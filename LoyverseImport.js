function uploadLoyverseFile(payload, sessionToken) {
  requireCapability_('import', sessionToken);

  if (!payload || !payload.base64 || !payload.fileName) {
    throw new Error('اختر ملفًا صالحًا.');
  }

  const rawBase64 = String(payload.base64).split(',').pop();
  const bytes = Utilities.base64Decode(rawBase64);

  const blob = Utilities.newBlob(
    bytes,
    payload.mimeType || 'text/csv',
    payload.fileName
  );

  const uploadFolderId =
    PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID');

  if (!uploadFolderId) {
    throw new Error('مجلد الرفع غير مهيأ. شغّل setupOrTec أولًا.');
  }

  const storedFile = DriveApp
    .getFolderById(uploadFolderId)
    .createFile(blob);

  const fileName = String(payload.fileName).toLowerCase();

  if (!fileName.endsWith('.csv')) {
    throw new Error('ارفع ملف CSV من Loyverse.');
  }

  const csvText = blob.getDataAsString('UTF-8');

  // Every import is a read-modify-write over whole tables. Two managers
  // uploading at once would each compute their merge against a stale snapshot
  // and the second write would silently discard the first.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('هناك عملية استيراد جارية. أعد المحاولة بعد قليل.');
  }
  try {
    return importLoyverseCsv_(csvText, {
      fileName: payload.fileName,
      branchId: payload.branchId || 'AUTO',
      reportDate: payload.reportDate || today_(),
      sourceFileId: storedFile.getId(),
      sessionToken: sessionToken
    });
  } finally {
    lock.releaseLock();
  }
}


function importLoyverseCsv_(csvText, meta) {
  const rows = Utilities.parseCsv(csvText);

  if (!rows || rows.length < 2) {
    throw new Error('الملف لا يحتوي بيانات.');
  }

  const originalHeaders = rows[0].map(value => String(value || '').trim());
  const normalizedHeaders = originalHeaders.map(normalizeHeader_);

  const reportType = detectReportType_(normalizedHeaders);
  const fileHash = sha256_(csvText);

  const previousImport = findBy_(
    ORTEC.SHEETS.IMPORT_BATCHES,
    'file_hash',
    fileHash
  );

  if (previousImport) {
    return {
      ok: false,
      duplicateFile: true,
      message: 'تم استيراد هذا الملف مسبقًا.',
      batch: previousImport
    };
  }

  const batchId = uuid_();
  let result;

  if (reportType === ORTEC.IMPORT_TYPES.ITEM_EXPORT) {
    result = importItemExport_(
      originalHeaders,
      normalizedHeaders,
      rows.slice(1),
      batchId,
      meta
    );
  } else if (reportType === ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM) {
    result = importReceiptsByItem_(
      normalizedHeaders,
      rows.slice(1),
      batchId,
      meta
    );
  } else {
    throw new Error(
      'نوع التقرير غير مدعوم. استخدم Export Items أو Receipts by Item من Loyverse.'
    );
  }

  appendObject_(ORTEC.SHEETS.IMPORT_BATCHES, {
    batch_id: batchId,
    file_name: meta.fileName,
    file_hash: fileHash,
    report_type: reportType,
    branch_id: meta.branchId,
    period_date: resolveDateArg_(meta.reportDate),
    total_rows: rows.length - 1,
    inserted_rows: result.inserted,
    duplicate_rows: result.duplicates,
    error_rows: result.errors,
    status: result.errors > 0
      ? 'COMPLETED_WITH_WARNINGS'
      : 'COMPLETED',
    uploaded_by: (function(u){return u.username || u.email;})(resolveSessionUser_(meta.sessionToken, true)),
    uploaded_at: nowIso_()
  });

  audit_(
    'IMPORT_BATCH',
    batchId,
    'CREATE',
    null,
    {
      reportType: reportType,
      fileName: meta.fileName,
      result: result
    }
  );

  return Object.assign(
    {
      ok: true,
      batchId: batchId,
      reportType: reportType
    },
    result
  );
}


function detectReportType_(headers) {
  const headerSet = new Set(headers);

  if (
    headerSet.has('receipt number') &&
    headerSet.has('net sales') &&
    headerSet.has('quantity') &&
    headerSet.has('store')
  ) {
    return ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM;
  }

  if (
    headerSet.has('handle') &&
    headerSet.has('sku') &&
    headers.some(header => header.indexOf('in stock [') === 0)
  ) {
    return ORTEC.IMPORT_TYPES.ITEM_EXPORT;
  }

  return 'UNKNOWN';
}


function importItemExport_(
  originalHeaders,
  normalizedHeaders,
  rows,
  batchId,
  meta
) {
  const branchColumns = findInventoryBranchColumns_(
    originalHeaders,
    normalizedHeaders
  );

  if (!branchColumns.length) {
    throw new Error('لم يتم العثور على أعمدة مخزون الفروع.');
  }

  // An Export Items file IS the current Loyverse catalogue, so the replacement
  // set must be every product/branch row the file contains — not just the rows
  // that happen to be new. The previous code built this list from unseen keys
  // only and then handed it to a whole-table replace, so re-importing a broadly
  // unchanged catalogue wiped every pre-existing product.
  const existingProducts = sheetToObjects_(ORTEC.SHEETS.PRODUCTS);
  const existingKeys = new Set(
    existingProducts.map(row => String(row.product_key || ''))
  );

  const catalogueRows = [];        // complete replacement dataset
  const seenKeysInFile = new Set(); // detects rows repeated WITHIN this file
  const snapshotRows = [];

  const stats = {
    inserted: 0,        // rows in this file not previously in the table
    unchanged: 0,       // rows already present — retained, never dropped
    duplicates: 0,      // rows repeated within this file — collapsed
    errors: 0,
    productsRead: 0,
    branchesDetected: branchColumns.map(branch => branch.branchId)
  };

  rows.forEach(row => {
    try {
      if (isEmptyRow_(row)) {
        return;
      }

      const item = rowToObject_(normalizedHeaders, row);

      const sku = cleanText_(item.sku);
      const itemName = cleanText_(item.name);
      const barcode = cleanText_(item.barcode);
      const category = cleanText_(item.category);
      const supplier = cleanText_(item.supplier);

      const cost = firstPositiveNumber_([
        item.cost,
        item['purchase cost']
      ]);

      const trackStock =
        String(item['track stock'] || '').toUpperCase() === 'Y';

      if (!sku && !itemName) {
        stats.errors++;
        return;
      }

      stats.productsRead++;

      branchColumns.forEach(branch => {
        const stock = number_(row[branch.stockIndex], 0);
        const price = number_(row[branch.priceIndex], 0);
        const lowStock = number_(row[branch.lowStockIndex], 0);

        const available =
          branch.availableIndex >= 0
            ? String(row[branch.availableIndex] || '').toUpperCase() === 'Y'
            : true;

        const productKey = sha256_(
          [
            branch.branchId,
            sku,
            barcode,
            itemName
          ].join('|')
        );

        const product = {
          product_key: productKey,
          sku: sku,
          barcode: barcode,
          item_name: itemName,
          category: category,
          cost: cost,
          price: price,
          track_stock: trackStock,
          branch_id: branch.branchId,
          stock: stock,
          low_stock_threshold: lowStock,
          batch_id: batchId,
          updated_at: nowIso_()
        };

        if (seenKeysInFile.has(productKey)) {
          // The same product/branch twice in one file: keep the first, count it.
          stats.duplicates++;
        } else {
          seenKeysInFile.add(productKey);
          catalogueRows.push(product);
          if (existingKeys.has(productKey)) stats.unchanged++;
          else stats.inserted++;
        }

        snapshotRows.push({
          snapshot_id: uuid_(),
          snapshot_date: resolveDateArg_(meta.reportDate),
          branch_id: branch.branchId,
          sku: sku,
          item_name: itemName,
          stock: stock,
          cost: cost,
          value: stock * cost,
          batch_id: batchId,
          created_at: nowIso_()
        });
      });
    } catch (error) {
      stats.errors++;
      console.error('ITEM_EXPORT row failed: %s', error && error.message ? error.message : error);
    }
  });

  // Export Items represents the latest current catalogue/stock. Replace the
  // current product table while keeping InventorySnapshots as historical daily
  // records — snapshots are append-only and are never touched by this replace.
  //
  // Order matters: validate the prepared dataset, snapshot the table, then
  // replace. replaceAllObjectsGuarded_ refuses a replacement that would shrink
  // the catalogue implausibly, so a truncated or misparsed file fails closed
  // rather than destroying the table.
  if (!catalogueRows.length) {
    throw new Error('لم يتم استخراج أي منتجات من الملف. لم يتم تعديل جدول المنتجات.');
  }
  const errorRatio = stats.productsRead > 0 ? stats.errors / (stats.productsRead + stats.errors) : 1;
  if (errorRatio > ORTEC.IMPORT_GUARD.MAX_ERROR_RATIO) {
    throw new Error(
      `تم رفض الاستيراد: ${stats.errors} صف غير صالح من أصل ${stats.productsRead + stats.errors}. ` +
      'لم يتم تعديل جدول المنتجات.'
    );
  }

  // requireBackup is explicit: a full-catalogue replacement must never proceed
  // on a table that has data if the backup cannot be written and verified.
  const replacement = replaceAllObjectsGuarded_(ORTEC.SHEETS.PRODUCTS, catalogueRows, {
    minRows: ORTEC.IMPORT_GUARD.MIN_CATALOGUE_ROWS,
    maxShrinkRatio: ORTEC.IMPORT_GUARD.MAX_SHRINK_RATIO,
    backupLabel: 'item_export',
    requireBackup: true
  });
  stats.catalogueSize = replacement.written;
  stats.previousCatalogueSize = replacement.previousCount;
  stats.backupFileId = replacement.backupFileId;

  // Snapshots are historical and additive; written only after the catalogue
  // replacement has succeeded.
  appendObjectsInChunks_(
    ORTEC.SHEETS.INVENTORY,
    snapshotRows,
    1000
  );

  const inventoryAnalysis = analyzeInventory_(resolveDateArg_(meta.reportDate));
  stats.inventoryIssuesCreated = inventoryAnalysis.count;
  return stats;
}


function findInventoryBranchColumns_(originalHeaders, normalizedHeaders) {
  const branches = [];

  normalizedHeaders.forEach((header, index) => {
    const match = header.match(/^in stock \[(.+)\]$/);

    if (!match) {
      return;
    }

    const rawBranchName = originalHeaders[index]
      .replace(/^In stock \[/i, '')
      .replace(/\]$/, '')
      .trim();

    const branchId = normalizeLoyverseBranch_(rawBranchName);

    if (!branchId) {
      return;
    }

    branches.push({
      branchId: branchId,
      rawName: rawBranchName,
      stockIndex: index,
      priceIndex: findHeaderIndex_(
        normalizedHeaders,
        `price [${match[1]}]`
      ),
      lowStockIndex: findHeaderIndex_(
        normalizedHeaders,
        `low stock [${match[1]}]`
      ),
      optimalStockIndex: findHeaderIndex_(
        normalizedHeaders,
        `optimal stock [${match[1]}]`
      ),
      availableIndex: findHeaderIndex_(
        normalizedHeaders,
        `available for sale [${match[1]}]`
      )
    });
  });

  return branches.filter(branch => branch.stockIndex >= 0);
}


/**
 * Import a Loyverse "Receipts by Item" export idempotently.
 *
 * THE UNIT OF IDEMPOTENCY IS THE RECEIPT, not the file and not the line.
 *
 * File-hash deduplication alone is not enough: two different exports routinely
 * contain overlapping business records (any re-export whose date range overlaps
 * an earlier one). The previous implementation appended any line whose item_key
 * was unseen while skipping receipts whose receipt_key already existed, so an
 * overlapping import grew LoyverseReceiptItems while LoyverseReceipts kept stale
 * totals — the two tables silently diverged with no error anywhere (F-08).
 *
 * The strategy now:
 *   1. Parse every line and group it under its receipt.
 *   2. Compare each incoming receipt against what is stored, by fingerprint.
 *      - absent   -> insert the receipt and all its lines
 *      - identical-> keep the STORED rows untouched (a true no-op, so batch_id
 *                    and created_at of the original import survive)
 *      - differing-> refresh: the incoming lines replace that receipt's lines
 *        wholesale, so a corrected receipt converges rather than accumulating
 *   3. Receipts not mentioned by the file are preserved exactly as they are.
 *   4. Derive every receipt row from the merged item set, so parent totals
 *      cannot disagree with their lines by construction.
 *
 * Because receipts are derived rather than merged, re-running the same logical
 * dataset always produces the same final state, and a half-completed write is
 * repaired simply by running the import again.
 */
function importReceiptsByItem_(headers, rows, batchId, meta) {
  const parsed = parseReceiptItemRows_(headers, rows, batchId);

  const existingItems = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
  const existingReceipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS);

  const plan = planReceiptMerge_(existingItems, parsed.items);

  const stats = {
    inserted: plan.stats.itemsInserted,
    duplicates: parsed.stats.inFileRepeats,
    errors: parsed.stats.errors,
    receiptsInserted: plan.stats.receiptsInserted,
    receiptsRefreshed: plan.stats.receiptsRefreshed,
    receiptsUnchanged: plan.stats.receiptsUnchanged,
    receiptsPreserved: plan.stats.receiptsPreserved,
    itemsRefreshed: plan.stats.itemsRefreshed,
    itemsPreserved: plan.stats.itemsPreserved,
    dateCoverage: parsed.stats.dateCoverage
  };

  // Nothing changed: skip both writes entirely rather than rewriting the sheets
  // with identical content. This is what makes re-importing the same logical
  // dataset a genuine no-op.
  if (!plan.stats.receiptsInserted && !plan.stats.receiptsRefreshed) {
    stats.noChanges = true;
    return stats;
  }

  const receiptRows = buildReceiptsFromItems_(plan.items, existingReceipts, parsed.receiptMeta, batchId);

  // Items first, then the receipts derived from them. Both are guarded and
  // backed up. If the second write fails the tables are momentarily out of
  // step, but the state is self-healing: re-running the import (or
  // reconcileReceiptTotals_) recomputes receipts from whatever items exist.
  replaceAllObjectsGuarded_(ORTEC.SHEETS.RECEIPT_ITEMS, plan.items, {
    minRows: 1, maxShrinkRatio: 0, backupLabel: 'receipt_items', requireBackup: true
  });
  replaceAllObjectsGuarded_(ORTEC.SHEETS.RECEIPTS, receiptRows, {
    minRows: 1, maxShrinkRatio: 0, backupLabel: 'receipts', requireBackup: true
  });

  return stats;
}

/**
 * Parse raw CSV rows into item records carrying stable keys.
 *
 * The line-level business key deliberately excludes the measures (quantity,
 * net sales, cost, profit). The old key hashed them in, which meant an edited
 * or corrected line produced a NEW key and was appended alongside the stale
 * one, and two legitimately identical lines on one receipt collapsed into a
 * single row — silent data loss. Identity is now
 * receipt + sku + item name + variant + modifiers + occurrence, where
 * occurrence distinguishes repeated identical lines within the same receipt.
 * Occurrence is assigned in file order, but since repeated identical lines are
 * interchangeable the resulting KEY SET is stable regardless of row order.
 */
function parseReceiptItemRows_(headers, rows, batchId) {
  const items = [];
  const receiptMeta = {};
  const occurrences = {};
  const stats = { errors: 0, inFileRepeats: 0, dateCoverage: { earliest: null, latest: null, receipts: 0 } };
  const dates = [];

  rows.forEach(function (row) {
    try {
      if (isEmptyRow_(row)) return;
      const item = rowToObject_(headers, row);

      const receiptNumber = cleanText_(item['receipt number']);
      const receiptDate = normalizeLoyverseDate_(item.date) || resolveDateArg_(null);
      const branchId = normalizeLoyverseBranch_(item.store);
      if (!receiptNumber || !branchId) { stats.errors++; return; }

      const receiptKey = sha256_([receiptNumber, receiptDate, branchId].join('|'));
      const sku = cleanText_(item.sku);
      const itemName = cleanText_(item.item);
      const variant = cleanText_(item.variant);
      const modifiers = cleanText_(item['modifiers applied']);

      const identity = [receiptKey, sku, itemName, variant, modifiers].join('|');
      const occurrence = occurrences[identity] || 0;
      occurrences[identity] = occurrence + 1;
      if (occurrence > 0) stats.inFileRepeats++;

      const quantity = number_(item.quantity, 0);
      const netSales = number_(item['net sales'], 0);

      items.push({
        item_key: sha256_(identity + '|' + occurrence),
        receipt_key: receiptKey,
        receipt_number: receiptNumber,
        receipt_date: receiptDate,
        branch_id: branchId,
        sku: sku,
        item_name: itemName,
        category: cleanText_(item.category),
        quantity: quantity,
        unit_price: quantity !== 0 ? netSales / quantity : netSales,
        gross_sales: number_(item['gross sales'], 0),
        discount: Math.abs(number_(item.discounts, 0)),
        net_sales: netSales,
        cost: number_(item['cost of goods'], 0),
        profit: number_(item['gross profit'], 0),
        batch_id: batchId,
        created_at: nowIso_()
      });

      dates.push(receiptDate);
      if (!receiptMeta[receiptKey]) {
        receiptMeta[receiptKey] = {
          employee: cleanText_(item['cashier name']),
          payment_type: '',
          refunds: 0
        };
      }
      if (String(item['receipt type'] || '').toLowerCase().indexOf('refund') !== -1) {
        receiptMeta[receiptKey].refunds += Math.abs(netSales);
      }
    } catch (error) {
      stats.errors++;
      console.error('RECEIPTS_BY_ITEM row failed: %s', error && error.message ? error.message : error);
    }
  });

  const sorted = dates.slice().sort();
  stats.dateCoverage = {
    earliest: sorted.length ? sorted[0] : null,
    latest: sorted.length ? sorted[sorted.length - 1] : null,
    receipts: Object.keys(receiptMeta).length
  };
  return { items: items, receiptMeta: receiptMeta, stats: stats };
}

/** Group item rows by their receipt key. */
function groupByReceipt_(items) {
  const out = {};
  (items || []).forEach(function (item) {
    const key = String(item.receipt_key || '');
    (out[key] = out[key] || []).push(item);
  });
  return out;
}

/**
 * Fingerprint of a receipt's line set INCLUDING measures, so a corrected
 * receipt is detected as changed even though its line identities are stable.
 * Sorted, so file row order never affects the comparison.
 */
function receiptFingerprint_(items) {
  return (items || []).map(function (i) {
    return [i.item_key, Number(i.quantity) || 0, Number(i.net_sales) || 0,
            Number(i.gross_sales) || 0, Number(i.discount) || 0,
            Number(i.cost) || 0, Number(i.profit) || 0].join(':');
  }).sort().join('|');
}

/**
 * Merge incoming lines into the stored set, receipt by receipt.
 * Pure function: no sheet access, which is what makes it directly testable.
 */
function planReceiptMerge_(existingItems, incomingItems) {
  const existingByReceipt = groupByReceipt_(existingItems);
  const incomingByReceipt = groupByReceipt_(incomingItems);
  const merged = [];
  const stats = {
    receiptsInserted: 0, receiptsRefreshed: 0, receiptsUnchanged: 0, receiptsPreserved: 0,
    itemsInserted: 0, itemsRefreshed: 0, itemsUnchanged: 0, itemsPreserved: 0
  };

  // Receipts the file does not mention are preserved byte-for-byte.
  Object.keys(existingByReceipt).forEach(function (key) {
    if (incomingByReceipt[key]) return;
    existingByReceipt[key].forEach(function (item) { merged.push(item); });
    stats.receiptsPreserved++;
    stats.itemsPreserved += existingByReceipt[key].length;
  });

  Object.keys(incomingByReceipt).forEach(function (key) {
    const incoming = incomingByReceipt[key];
    const existing = existingByReceipt[key];
    if (!existing) {
      incoming.forEach(function (item) { merged.push(item); });
      stats.receiptsInserted++;
      stats.itemsInserted += incoming.length;
      return;
    }
    if (receiptFingerprint_(existing) === receiptFingerprint_(incoming)) {
      // Identical: keep the STORED rows so batch_id/created_at survive.
      existing.forEach(function (item) { merged.push(item); });
      stats.receiptsUnchanged++;
      stats.itemsUnchanged += existing.length;
      return;
    }
    // Changed: the incoming line set replaces this receipt's lines wholesale.
    incoming.forEach(function (item) { merged.push(item); });
    stats.receiptsRefreshed++;
    stats.itemsRefreshed += incoming.length;
  });

  return { items: merged, stats: stats };
}

/**
 * Derive every receipt row from the merged item set, so a parent's totals can
 * never disagree with its lines. Receipt-level attributes that items do not
 * carry (cashier, payment type, refunds) come from the file when present and
 * are otherwise preserved from the stored receipt, so no schema change is
 * required and nothing is lost.
 */
function buildReceiptsFromItems_(items, existingReceipts, receiptMeta, batchId) {
  const existingByKey = {};
  (existingReceipts || []).forEach(function (r) { existingByKey[String(r.receipt_key || '')] = r; });
  const grouped = groupByReceipt_(items);
  const out = [];

  Object.keys(grouped).forEach(function (key) {
    const lines = grouped[key];
    const first = lines[0];
    const prior = existingByKey[key] || {};
    const meta = (receiptMeta || {})[key] || {};
    out.push({
      receipt_key: key,
      receipt_number: first.receipt_number,
      receipt_date: first.receipt_date,
      branch_id: first.branch_id,
      employee: meta.employee || prior.employee || '',
      payment_type: meta.payment_type || prior.payment_type || '',
      gross_sales: sumField_(lines, 'gross_sales'),
      discounts: sumField_(lines, 'discount'),
      refunds: meta.refunds != null ? meta.refunds : (Number(prior.refunds) || 0),
      net_sales: sumField_(lines, 'net_sales'),
      batch_id: prior.batch_id || batchId,
      created_at: prior.created_at || nowIso_()
    });
  });

  // A stored receipt with no items at all is kept: it is historical data whose
  // lines were never imported, and dropping it would lose information.
  Object.keys(existingByKey).forEach(function (key) {
    if (!grouped[key]) out.push(existingByKey[key]);
  });

  return out;
}

/**
 * Repair path: recompute every receipt from the stored items. Safe to run at
 * any time; used after a half-completed import and by the verification report.
 */
function reconcileReceiptTotals_() {
  const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
  const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS);
  const rebuilt = buildReceiptsFromItems_(items, receipts, {}, 'reconcile');
  replaceAllObjectsGuarded_(ORTEC.SHEETS.RECEIPTS, rebuilt, {
    minRows: 1, maxShrinkRatio: 0, backupLabel: 'reconcile', requireBackup: true
  });
  return { receipts: rebuilt.length };
}

function appendObjectsInChunks_(sheetName, objects, chunkSize) {
  if (!objects || !objects.length) {
    return;
  }

  const size = chunkSize || 500;

  for (let index = 0; index < objects.length; index += size) {
    appendObjects_(
      sheetName,
      objects.slice(index, index + size)
    );
  }
}


function normalizeLoyverseBranch_(value) {
  // Normalize Arabic alif variants (أ إ آ ا) before matching: the branch is
  // configured as "مربع إتين" with hamza, so a bare-alif test never matched and
  // every row from that store was discarded as an error.
  const branch = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u0623\u0625\u0622]/g, '\u0627');

  if (
    branch.includes('sadah') ||
    branch.includes('saadah') ||
    branch.includes('tymour') ||
    branch.includes('سعادة')
  ) {
    return 'SAADA';
  }

  if (
    branch.includes('auqad') ||
    branch.includes('awqad') ||
    branch.includes('عوقد')
  ) {
    return 'AWQAD';
  }

  if (
    branch.includes('ittin') ||
    branch.includes('اتين')
  ) {
    return 'ITTIN';
  }

  return '';
}


function normalizeLoyverseDate_(value) {
  if (!value) {
    return '';
  }

  const cleaned = String(value)
    .replace(/[\u202F\u00A0]/g, ' ')
    .trim();

  const datePart = cleaned.split(' ')[0];
  const parts = datePart.split('/');

  if (parts.length === 3) {
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    let year = Number(parts[2]);

    if (year < 100) {
      year += 2000;
    }

    return [
      String(year).padStart(4, '0'),
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-');
  }

  const parsed = new Date(cleaned);

  if (isNaN(parsed.getTime())) {
    return '';
  }

  return Utilities.formatDate(
    parsed,
    ORTEC.TZ,
    'yyyy-MM-dd'
  );
}


function rowToObject_(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index];
    return object;
  }, {});
}


function normalizeHeader_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u202F\u00A0]/g, ' ')
    .replace(/\s+/g, ' ');
}


function findHeaderIndex_(headers, target) {
  return headers.indexOf(normalizeHeader_(target));
}


function number_(value, fallback) {
  const normalized = String(value == null ? '' : value)
    .replace(/,/g, '')
    .replace(/[^\d.\-]/g, '');

  const result = Number(normalized);

  return isNaN(result)
    ? Number(fallback || 0)
    : result;
}


function firstPositiveNumber_(values) {
  for (let index = 0; index < values.length; index++) {
    const value = number_(values[index], 0);

    if (value > 0) {
      return value;
    }
  }

  return 0;
}


function cleanText_(value) {
  return String(value == null ? '' : value).trim();
}


function isEmptyRow_(row) {
  return !row.some(value => String(value || '').trim() !== '');
}


function sha256_(text) {
  return Utilities
    .computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(text || ''),
      Utilities.Charset.UTF_8
    )
    .map(byte => (byte + 256) % 256)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}