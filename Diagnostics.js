/**
 * OrTec OS — read-only production diagnostics.
 *
 * STRICTLY READ-ONLY. This file must never write a sheet, send mail, create a
 * Drive file, change a trigger or set a script property. It exists because the
 * spreadsheet contents cannot be inspected from outside the project, so these
 * questions have to be answered by code running inside it.
 *
 * Run `ortecDiagnostics_` from the Apps Script editor and copy the logged JSON.
 * The trailing underscore makes it unreachable from google.script.run.
 *
 * Nothing here returns password hashes, salts, session tokens or any other
 * secret: user rows are reduced to counts and roles only.
 */

function ortecDiagnostics_() {
  // Editor-only. The trailing underscore is what guarantees it: this reads
  // every table, and as a plain global it would have been callable anonymously
  // through the ANYONE web app. assertEditorContext_ is defence in depth.
  assertEditorContext_('ortecDiagnostics_');
  const report = {
    generatedAt: nowIso_(),
    timezone: { config: ORTEC.TZ, manifestNote: 'compare against appsscript.json timeZone' },
    configuration: ortecDiagnoseConfiguration_(),
    datasets: {},
    ingestion: {},
    anomalies: {}
  };

  const datasets = [
    ['products', ORTEC.SHEETS.PRODUCTS, 'updated_at'],
    ['receiptItems', ORTEC.SHEETS.RECEIPT_ITEMS, 'receipt_date'],
    ['receipts', ORTEC.SHEETS.RECEIPTS, 'receipt_date'],
    ['inventorySnapshots', ORTEC.SHEETS.INVENTORY, 'snapshot_date'],
    ['inventoryIssues', ORTEC.SHEETS.INVENTORY_ISSUES, 'issue_date'],
    ['expenses', ORTEC.SHEETS.EXPENSES, 'expense_date'],
    ['tasks', ORTEC.SHEETS.TASKS, 'created_at'],
    ['users', ORTEC.SHEETS.USERS, 'created_at'],
    ['importBatches', ORTEC.SHEETS.IMPORT_BATCHES, 'period_date'],
    ['emailLog', ORTEC.SHEETS.EMAIL_LOG, 'report_date'],
    ['auditLog', ORTEC.SHEETS.AUDIT, 'timestamp'],
    ['deliveryAgents', ORTEC.SHEETS.DELIVERY_AGENTS, 'created_at'],
    ['branches', ORTEC.SHEETS.BRANCHES, 'created_at'],
    ['settings', ORTEC.SHEETS.SETTINGS, 'updated_at']
  ];

  datasets.forEach(function (entry) {
    report.datasets[entry[0]] = ortecDiagnoseDataset_(entry[1], entry[2]);
  });

  report.ingestion = ortecDiagnoseIngestion_();
  report.anomalies = ortecDiagnoseAnomalies_();

  console.log(JSON.stringify(report, null, 2));
  return report;
}

function ortecDiagnoseConfiguration_() {
  const props = PropertiesService.getScriptProperties();
  // Report only whether an id is present, never the id itself.
  const keys = ['SPREADSHEET_ID', 'ROOT_FOLDER_ID', 'UPLOAD_FOLDER_ID',
                'EXPENSE_FOLDER_ID', 'REPORT_FOLDER_ID', 'BACKUP_FOLDER_ID'];
  const out = {};
  keys.forEach(function (key) {
    const value = props.getProperty(key);
    out[key] = { configured: !!value };
  });

  // The backup folder must be reachable, not merely configured: the catalogue
  // replacement now refuses to run without a verified backup.
  const backupId = props.getProperty('BACKUP_FOLDER_ID');
  if (backupId) {
    try {
      const folder = DriveApp.getFolderById(backupId);
      let count = 0;
      const it = folder.getFiles();
      while (it.hasNext() && count < 1000) { it.next(); count++; }
      out.BACKUP_FOLDER_ID.accessible = true;
      out.BACKUP_FOLDER_ID.name = folder.getName();
      out.BACKUP_FOLDER_ID.existingBackups = count;
    } catch (error) {
      out.BACKUP_FOLDER_ID.accessible = false;
      out.BACKUP_FOLDER_ID.error = String(error && error.message ? error.message : error);
    }
  }

  try {
    out.triggers = ScriptApp.getProjectTriggers().map(function (t) {
      return { handler: t.getHandlerFunction(), source: String(t.getEventType ? t.getEventType() : 'UNKNOWN') };
    });
  } catch (error) {
    out.triggers = { error: String(error && error.message ? error.message : error) };
  }

  return out;
}

function ortecDiagnoseDataset_(sheetName, dateField) {
  try {
    const rows = sheetToObjects_(sheetName);
    const dates = rows
      .map(function (r) { return normalizeDate_(r[dateField]); })
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d)); })
      .sort();
    return {
      rows: rows.length,
      earliest: dates.length ? dates[0] : null,
      latest: dates.length ? dates[dates.length - 1] : null,
      datedRows: dates.length
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

function ortecDiagnoseIngestion_() {
  try {
    const batches = sheetToObjects_(ORTEC.SHEETS.IMPORT_BATCHES);
    const byType = {};
    batches.forEach(function (b) {
      const type = String(b.report_type || 'UNKNOWN');
      byType[type] = byType[type] || { count: 0, periods: [], statuses: {} };
      byType[type].count++;
      byType[type].periods.push(normalizeDate_(b.period_date));
      const status = String(b.status || 'UNKNOWN');
      byType[type].statuses[status] = (byType[type].statuses[status] || 0) + 1;
    });
    Object.keys(byType).forEach(function (type) {
      const periods = byType[type].periods.filter(Boolean).sort();
      byType[type].earliestPeriod = periods.length ? periods[0] : null;
      byType[type].latestPeriod = periods.length ? periods[periods.length - 1] : null;
      delete byType[type].periods;
    });

    const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
    const itemDates = items.map(function (r) { return normalizeDate_(r.receipt_date); })
      .filter(Boolean).sort();
    const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS);

    return {
      batchCount: batches.length,
      byReportType: byType,
      canonicalTypeExpected: ORTEC.IMPORT_TYPES,
      newestSalesTransaction: itemDates.length ? itemDates[itemDates.length - 1] : null,
      uniqueReceiptKeys: new Set(receipts.map(function (r) { return String(r.receipt_key || ''); })).size,
      receiptRows: receipts.length,
      receiptItemRows: items.length,
      daysSinceNewestSale: itemDates.length
        ? Math.round((new Date(today_()) - new Date(itemDates[itemDates.length - 1])) / 86400000)
        : null
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
}

function ortecDiagnoseAnomalies_() {
  const out = {};
  try {
    const products = sheetToObjects_(ORTEC.SHEETS.PRODUCTS);
    const keys = products.map(function (p) { return String(p.product_key || ''); });
    out.products = {
      total: products.length,
      duplicateKeys: keys.length - new Set(keys).size,
      blankKeys: keys.filter(function (k) { return !k; }).length,
      negativeStock: products.filter(function (p) { return Number(p.stock) < 0; }).length,
      zeroOrMissingCost: products.filter(function (p) { return !(Number(p.cost) > 0); }).length,
      byBranch: products.reduce(function (acc, p) {
        const b = String(p.branch_id || 'UNKNOWN');
        acc[b] = (acc[b] || 0) + 1; return acc;
      }, {})
    };

    const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
    const itemKeys = items.map(function (r) { return String(r.item_key || ''); });
    out.receiptItems = {
      total: items.length,
      duplicateKeys: itemKeys.length - new Set(itemKeys).size,
      missingBranch: items.filter(function (r) { return !String(r.branch_id || ''); }).length,
      byBranch: items.reduce(function (acc, r) {
        const b = String(r.branch_id || 'UNKNOWN');
        acc[b] = (acc[b] || 0) + 1; return acc;
      }, {})
    };

    // Receipt-level totals should reconcile with the sum of their items. A
    // mismatch means a partial re-import updated items without their parent.
    const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS);
    const itemTotals = {};
    items.forEach(function (r) {
      const key = String(r.receipt_key || '');
      itemTotals[key] = (itemTotals[key] || 0) + (Number(r.net_sales) || 0);
    });
    let mismatched = 0, orphanReceipts = 0;
    receipts.forEach(function (r) {
      const key = String(r.receipt_key || '');
      if (!(key in itemTotals)) { orphanReceipts++; return; }
      if (Math.abs((Number(r.net_sales) || 0) - itemTotals[key]) > 0.005) mismatched++;
    });
    const receiptKeys = new Set(receipts.map(function (r) { return String(r.receipt_key || ''); }));
    out.reconciliation = {
      receipts: receipts.length,
      receiptsWithNoItems: orphanReceipts,
      receiptsWhoseTotalDisagreesWithItems: mismatched,
      itemsWithNoParentReceipt: Object.keys(itemTotals).filter(function (k) { return !receiptKeys.has(k); }).length
    };

    const issues = sheetToObjects_(ORTEC.SHEETS.INVENTORY_ISSUES);
    const issueIdentity = issues.map(function (i) {
      return [i.branch_id, i.sku, i.issue_type].join('|');
    });
    out.inventoryIssues = {
      total: issues.length,
      open: issues.filter(function (i) { return String(i.status) === 'OPEN'; }).length,
      distinctIdentities: new Set(issueIdentity).size,
      duplicateAccumulation: issueIdentity.length - new Set(issueIdentity).size
    };

    // Roles and counts only — never password material.
    const users = sheetToObjects_(ORTEC.SHEETS.USERS);
    out.users = {
      total: users.length,
      active: users.filter(function (u) { return String(u.active).toLowerCase() !== 'false'; }).length,
      byRole: users.reduce(function (acc, u) {
        const r = String(u.role || 'UNKNOWN'); acc[r] = (acc[r] || 0) + 1; return acc;
      }, {}),
      withoutPasswordSet: users.filter(function (u) { return !String(u.password_hash || ''); }).length,
      mustChangePassword: users.filter(function (u) { return String(u.must_change_password).toLowerCase() === 'true'; }).length,
      unknownRole: users.filter(function (u) { return ORTEC.ROLES.indexOf(String(u.role)) === -1; }).length
    };

    const expenses = sheetToObjects_(ORTEC.SHEETS.EXPENSES);
    out.expenses = {
      total: expenses.length,
      byStatus: expenses.reduce(function (acc, e) {
        const s = String(e.status || 'UNKNOWN'); acc[s] = (acc[s] || 0) + 1; return acc;
      }, {}),
      withInvoiceFile: expenses.filter(function (e) { return String(e.invoice_file_id || ''); }).length
    };

    const tasks = sheetToObjects_(ORTEC.SHEETS.TASKS);
    out.tasks = {
      total: tasks.length,
      open: tasks.filter(function (t) { return String(t.status) !== 'COMPLETED'; }).length,
      overdue: tasks.filter(function (t) {
        return String(t.status) !== 'COMPLETED' && t.due_date && normalizeDate_(t.due_date) < today_();
      }).length
    };
  } catch (error) {
    out.error = String(error && error.message ? error.message : error);
  }
  return out;
}
