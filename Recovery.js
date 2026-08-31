/**
 * OrTec OS — guided recovery for the Loyverse ingestion gap.
 *
 * Editor-only (trailing underscores): these read production and, in the commit
 * step, write it. They must never be reachable from the web app.
 *
 * Intended use for the 2026-07-18 -> today gap:
 *
 *   1. Export "Receipts by Item" from Loyverse for the missing range.
 *   2. Upload that CSV to the OrTec OS / Uploads Drive folder.
 *   3. ortecPreviewReceiptsRecovery_('<drive file id>')   <- READ ONLY
 *      Read the printed plan: schema, date coverage, row and receipt counts,
 *      overlap with what is already stored, and exactly what would be
 *      inserted, refreshed and skipped. Nothing is written.
 *   4. If the plan is right, take the confirmation token it prints and run
 *      ortecCommitReceiptsRecovery_('<drive file id>', '<token>')
 *   5. ortecVerifyReceiptsRecovery_() for the post-import reconciliation.
 *
 * EXPORT ITEMS IS DIFFERENT AND DELIBERATELY NOT AUTOMATED HERE. That export is
 * a snapshot of the catalogue as it stands today. It carries no history, so a
 * file downloaded now describes today and only today. Importing it backfills
 * nothing, and InventorySnapshots for 18 July onward describe days whose stock
 * was never captured. Those rows do not exist in any system and must not be
 * manufactured: writing today's stock under a past date would turn a known gap
 * into invented history. Import a fresh Export Items normally, as current
 * state, and accept the inventory-history gap as permanent.
 */

/**
 * READ-ONLY dry run. Parses the file, validates it, and reports precisely what
 * a real import would do. Writes nothing.
 */
function ortecPreviewReceiptsRecovery_(driveFileId) {
  assertEditorContext_('ortecPreviewReceiptsRecovery_');
  const plan = ortecBuildRecoveryPlan_(driveFileId);
  console.log(JSON.stringify(plan, null, 2));
  if (plan.ok) {
    console.log(
      '\nNothing has been written. To apply this plan, run:\n' +
      `  ortecCommitReceiptsRecovery_('${driveFileId}', '${plan.confirmationToken}')`
    );
  }
  return plan;
}

/** Shared read-only planning used by both preview and commit. */
function ortecBuildRecoveryPlan_(driveFileId) {
  const report = { ok: false, driveFileId: String(driveFileId || ''), checks: [] };

  function check(name, passed, detail) {
    report.checks.push({ check: name, passed: !!passed, detail: detail || '' });
    return !!passed;
  }

  let file, csvText;
  try {
    file = DriveApp.getFileById(driveFileId);
    csvText = file.getBlob().getDataAsString('UTF-8');
  } catch (error) {
    check('file is readable', false, String(error && error.message ? error.message : error));
    return report;
  }

  report.file = { name: file.getName(), size: file.getSize(), created: String(file.getDateCreated()) };
  if (!check('file is a CSV', /\.csv$/i.test(file.getName()), file.getName())) return report;

  const rows = Utilities.parseCsv(csvText);
  if (!check('file has data rows', rows && rows.length >= 2, `${rows ? rows.length : 0} lines`)) return report;

  const normalizedHeaders = rows[0].map(function (h) { return normalizeHeader_(String(h || '').trim()); });
  const reportType = detectReportType_(normalizedHeaders);
  if (!check('file is a Receipts by Item export',
      reportType === ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM,
      `detected ${reportType}`)) {
    if (reportType === ORTEC.IMPORT_TYPES.ITEM_EXPORT) {
      report.checks.push({
        check: 'export-items guidance', passed: false,
        detail: 'This is an Export Items file. It represents CURRENT catalogue state only ' +
                'and cannot backfill history. Import it through the normal upload screen.'
      });
    }
    return report;
  }

  // Would the existing file-hash check reject this outright?
  const fileHash = sha256_(csvText);
  const priorBatch = findBy_(ORTEC.SHEETS.IMPORT_BATCHES, 'file_hash', fileHash);
  report.duplicateFile = !!priorBatch;
  check('file has not been imported before', !priorBatch,
    priorBatch ? `identical file already imported as batch ${priorBatch.batch_id}` : '');

  const parsed = parseReceiptItemRows_(normalizedHeaders, rows.slice(1), 'preview');
  report.parse = {
    dataRows: rows.length - 1,
    parsedItems: parsed.items.length,
    rejectedRows: parsed.stats.errors,
    repeatedLinesWithinFile: parsed.stats.inFileRepeats,
    dateCoverage: parsed.stats.dateCoverage
  };
  check('most rows parsed cleanly',
    parsed.items.length > 0 && parsed.stats.errors <= parsed.items.length,
    `${parsed.stats.errors} rejected`);

  const existingItems = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
  const storedDates = existingItems
    .map(function (r) { return normalizeDate_(r.receipt_date); })
    .filter(Boolean).sort();
  report.stored = {
    itemRows: existingItems.length,
    earliest: storedDates.length ? storedDates[0] : null,
    latest: storedDates.length ? storedDates[storedDates.length - 1] : null
  };

  const merge = planReceiptMerge_(existingItems, parsed.items);
  report.plan = {
    receiptsToInsert: merge.stats.receiptsInserted,
    receiptsToRefresh: merge.stats.receiptsRefreshed,
    receiptsAlreadyIdentical: merge.stats.receiptsUnchanged,
    receiptsUntouched: merge.stats.receiptsPreserved,
    itemRowsBefore: existingItems.length,
    itemRowsAfter: merge.items.length,
    netRowChange: merge.items.length - existingItems.length
  };

  // Overlap: dates present in both the file and the stored data.
  const storedDateSet = {};
  storedDates.forEach(function (d) { storedDateSet[d] = true; });
  const fileDates = {};
  parsed.items.forEach(function (i) { fileDates[i.receipt_date] = true; });
  const overlapping = Object.keys(fileDates).filter(function (d) { return storedDateSet[d]; }).sort();
  report.overlap = {
    overlappingDates: overlapping.length,
    earliestOverlap: overlapping.length ? overlapping[0] : null,
    latestOverlap: overlapping.length ? overlapping[overlapping.length - 1] : null,
    note: 'Overlap is safe: import is idempotent per receipt. Identical receipts are skipped, ' +
          'changed receipts are refreshed wholesale, and untouched receipts are preserved.'
  };

  check('no rows would be lost', merge.items.length >= existingItems.length,
    `${existingItems.length} -> ${merge.items.length}`);

  const backupId = PropertiesService.getScriptProperties().getProperty('BACKUP_FOLDER_ID');
  check('backup folder is configured', !!backupId,
    backupId ? '' : 'BACKUP_FOLDER_ID missing — the import will refuse to run');

  report.ok = report.checks.every(function (c) { return c.passed; }) && !report.duplicateFile;
  // Token binds a confirmation to this exact file AND this exact plan, so a
  // stale token cannot approve a different import.
  report.confirmationToken = sha256_([fileHash, merge.items.length, merge.stats.receiptsInserted,
                                      merge.stats.receiptsRefreshed].join('|')).slice(0, 16);
  return report;
}

/**
 * Applies a previewed plan. Requires the confirmation token printed by the
 * preview, which is derived from the file's content AND the computed plan, so
 * it cannot approve anything other than exactly what was reviewed.
 */
function ortecCommitReceiptsRecovery_(driveFileId, confirmationToken) {
  assertEditorContext_('ortecCommitReceiptsRecovery_');

  const plan = ortecBuildRecoveryPlan_(driveFileId);
  if (!plan.ok) {
    console.log(JSON.stringify(plan, null, 2));
    throw new Error('Recovery refused: the preview checks did not all pass. Nothing was written.');
  }
  if (String(confirmationToken || '') !== plan.confirmationToken) {
    throw new Error(
      'Recovery refused: confirmation token does not match the current plan. ' +
      'Re-run ortecPreviewReceiptsRecovery_ and use the token it prints. Nothing was written.'
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another import is running. Nothing was written.');
  try {
    const file = DriveApp.getFileById(driveFileId);
    const csvText = file.getBlob().getDataAsString('UTF-8');
    const result = importLoyverseCsv_(csvText, {
      fileName: file.getName(),
      branchId: 'AUTO',
      reportDate: today_(),
      sourceFileId: driveFileId,
      sessionToken: null,
      actor: 'recovery(editor)'
    });
    const verification = ortecVerifyReceiptsRecovery_();
    console.log(JSON.stringify({ import: result, verification: verification }, null, 2));
    return { import: result, verification: verification };
  } finally {
    lock.releaseLock();
  }
}

/**
 * READ-ONLY post-import verification: do the parent receipts agree with their
 * line items, and what does the data now cover?
 */
function ortecVerifyReceiptsRecovery_() {
  const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
  const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS);

  const totals = {};
  items.forEach(function (i) {
    const key = String(i.receipt_key || '');
    totals[key] = (totals[key] || 0) + (Number(i.net_sales) || 0);
  });

  let mismatched = 0, receiptsWithoutItems = 0;
  receipts.forEach(function (r) {
    const key = String(r.receipt_key || '');
    if (!(key in totals)) { receiptsWithoutItems++; return; }
    if (Math.abs((Number(r.net_sales) || 0) - totals[key]) > 0.005) mismatched++;
  });

  const receiptKeys = {};
  receipts.forEach(function (r) { receiptKeys[String(r.receipt_key || '')] = true; });
  const orphanItems = Object.keys(totals).filter(function (k) { return !receiptKeys[k]; }).length;

  const dates = items.map(function (i) { return normalizeDate_(i.receipt_date); }).filter(Boolean).sort();

  return {
    itemRows: items.length,
    receiptRows: receipts.length,
    distinctReceiptKeys: Object.keys(totals).length,
    coverage: { earliest: dates.length ? dates[0] : null, latest: dates.length ? dates[dates.length - 1] : null },
    reconciliation: {
      receiptsDisagreeingWithItems: mismatched,
      receiptsWithNoItems: receiptsWithoutItems,
      itemsWithNoParentReceipt: orphanItems,
      consistent: mismatched === 0 && orphanItems === 0
    },
    remedyIfInconsistent: 'run reconcileReceiptTotals_ to rebuild receipts from items'
  };
}
