/**
 * One-time initialisation. Safe to run more than once: it only creates what is missing.
 */

function setupSystem() {
  return withLock_(function () {
    var ss = ss_();
    var report = { sheets: [], folders: {}, users: [], demoData: false, alreadyDone: false };

    try { ss.setSpreadsheetTimeZone(WC.TZ); } catch (e) { /* ignore on non-owner */ }
    props_().setProperty('SPREADSHEET_ID', ss.getId());

    report.sheets = ensureAllSheets_();
    report.folders = ensureFolders_();
    ensureDefaultSettings_();
    report.users = ensureDemoUsers_();

    var already = getSetting_('SETUP_DONE') === 'true';
    report.alreadyDone = already;
    if (!already) {
      if (!hasRealData_()) {
        createDemoData_();
        report.demoData = true;
      }
      setSetting_('SETUP_DONE', 'true', 'system');
      setSetting_('SETUP_VERSION', WC.VERSION, 'system');
    }
    // Remove the default empty "Sheet1"/"ورقة1" if it still exists and is empty.
    var sheets = ss.getSheets();
    if (sheets.length > 1) {
      sheets.forEach(function (sh) {
        var n = sh.getName();
        if (/^(Sheet1|ورقة1|ورقة 1)$/.test(n) && sh.getLastRow() === 0) { try { ss.deleteSheet(sh); } catch (e) {} }
      });
    }
    logAudit_({ username: 'system', role: 'system' }, 'SETUP', 'System', '', 'setupSystem executed (alreadyDone=' + already + ')', 'OK');
    Logger.log(JSON.stringify(report, null, 2));
    return report;
  });
}

/** Column layout for every sheet. */
function sheetHeaders_(name) {
  var S = WC.SHEETS, H = WC.HEADERS;
  if (name === S.SALES_RAW) return WC.LOYVERSE_COLUMNS.concat(WC.LOYVERSE_INTERNAL);
  if (WC.ENTRY_SHEETS.indexOf(name) >= 0) return WC.COMMON_COLUMNS.concat(H[name]);
  return H[name] || ['Key', 'Value'];
}

function ensureAllSheets_() {
  var ss = ss_();
  var created = [];
  var order = [WC.SHEETS.DASHBOARD, WC.SHEETS.SALES_RAW, WC.SHEETS.SALES_IMPORTS, WC.SHEETS.PURCHASES, WC.SHEETS.EXPENSES,
    WC.SHEETS.PAYROLL, WC.SHEETS.RENT, WC.SHEETS.USERS, WC.SHEETS.SETTINGS, WC.SHEETS.AUDIT, WC.SHEETS.ERRORS];
  order.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    var headers = sheetHeaders_(name);
    if (!sh) { sh = ss.insertSheet(name); created.push(name); }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      // add any missing headers at the end (schema upgrades) without touching data
      var existing = headersOf_(sh);
      var missing = headers.filter(function (h) { return existing.indexOf(h) < 0; });
      if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    formatSheet_(sh, name);
  });
  return created;
}

function formatSheet_(sh, name) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol);
  head.setFontWeight('bold').setBackground('#4b2e1e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  try { if (!sh.getFilter()) sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), lastCol).createFilter(); } catch (e) {}
  var headers = headersOf_(sh);
  headers.forEach(function (h, i) {
    var col = i + 1;
    var range = sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1);
    if (/^(Month|Period)$/.test(h) || /Key|ID|Number|SKU|Receipt number|Invoice Number/.test(h)) {
      range.setNumberFormat('@');
    } else if (/(Date|Timestamp|At)$/.test(h)) {
      if (/At$|Timestamp|^Date$|Uploaded At/.test(h)) range.setNumberFormat('yyyy-mm-dd hh:mm:ss');
      else range.setNumberFormat('yyyy-mm-dd');
    } else if (/(sales|Sales|Amount|Total|Subtotal|Tax|Discount|Salary|Allowance|Overtime|Deduction|Advance|Cost of|Gross profit|Gross Profit|Taxes|Discounts)/.test(h)) {
      range.setNumberFormat('#,##0.000');
    } else if (h === 'Quantity') {
      range.setNumberFormat('0.###');
    }
  });
  if (WC.HIDDEN_SHEETS.indexOf(name) >= 0) { try { sh.hideSheet(); } catch (e) {} }
}

// ---------------------------------------------------------------- Drive

function ensureFolders_() {
  var root = getOrCreateFolder_(null, WC.ROOT_FOLDER, 'ROOT_FOLDER_ID');
  var invoices = getOrCreateFolder_(root, 'Invoices', 'INVOICES_FOLDER_ID');
  var reports = getOrCreateFolder_(root, 'Reports', 'REPORTS_FOLDER_ID');
  return { root: root.getId(), invoices: invoices.getId(), reports: reports.getId() };
}

function getOrCreateFolder_(parent, name, propKey) {
  var p = props_();
  if (propKey) {
    var id = p.getProperty(propKey);
    if (id) { try { var f = DriveApp.getFolderById(id); if (f && !f.isTrashed()) return f; } catch (e) {} }
  }
  var it = parent ? parent.getFoldersByName(name) : DriveApp.getRootFolder().getFoldersByName(name);
  var folder = it.hasNext() ? it.next() : (parent ? parent.createFolder(name) : DriveApp.createFolder(name));
  if (propKey) p.setProperty(propKey, folder.getId());
  return folder;
}

/** Returns folder  <base>/YYYY/MM  (created on demand). */
function monthlyFolder_(baseKey, date) {
  var base = DriveApp.getFolderById(props_().getProperty(baseKey) || ensureFolders_()[baseKey === 'INVOICES_FOLDER_ID' ? 'invoices' : 'reports']);
  var y = getOrCreateFolder_(base, fmtDate_(date, 'yyyy'));
  return getOrCreateFolder_(y, fmtDate_(date, 'MM'));
}

// ---------------------------------------------------------------- Settings

function ensureDefaultSettings_() {
  var rows = readRows_(WC.SHEETS.SETTINGS);
  var have = {};
  rows.forEach(function (r) { have[String(r.Key)] = true; });
  var add = [];
  Object.keys(WC.DEFAULT_SETTINGS).forEach(function (k) {
    if (!have[k]) add.push({ Key: k, Value: WC.DEFAULT_SETTINGS[k].value, Description: WC.DEFAULT_SETTINGS[k].desc, 'Updated At': now_(), 'Updated By': 'system' });
  });
  appendObjects_(WC.SHEETS.SETTINGS, add);
}

function getAllSettings_() {
  var out = {};
  Object.keys(WC.DEFAULT_SETTINGS).forEach(function (k) { out[k] = WC.DEFAULT_SETTINGS[k].value; });
  readRows_(WC.SHEETS.SETTINGS).forEach(function (r) { out[String(r.Key)] = String(r.Value == null ? '' : r.Value); });
  return out;
}
function getSetting_(key) { return getAllSettings_()[key]; }

function setSetting_(key, value, by) {
  var rows = readRows_(WC.SHEETS.SETTINGS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].Key) === key) {
      updateRowFields_(WC.SHEETS.SETTINGS, rows[i]._row, { Value: String(value), 'Updated At': now_(), 'Updated By': by || '' });
      return;
    }
  }
  var def = WC.DEFAULT_SETTINGS[key] || { desc: '' };
  appendObjects_(WC.SHEETS.SETTINGS, [{ Key: key, Value: String(value), Description: def.desc, 'Updated At': now_(), 'Updated By': by || '' }]);
}

// ---------------------------------------------------------------- Users

function ensureDemoUsers_() {
  var created = [];
  var existing = readRows_(WC.SHEETS.USERS).map(function (r) { return String(r.Username); });
  WC.DEMO_USERS.forEach(function (u) {
    if (existing.indexOf(u.username) < 0) {
      createUser_(u.username, u.password, u.role, u.displayName, true);
      created.push(u.username);
    }
  });
  return created;
}

/** Resets ONLY the demo accounts' passwords. Never touches data. */
function resetDemoPasswords() {
  WC.DEMO_USERS.forEach(function (u) {
    setUserPassword_(u.username, u.password);
    var row = findUser_(u.username);
    if (row) updateRowFields_(WC.SHEETS.USERS, row._row, { 'Must Change Password': 'TRUE', Status: 'ACTIVE' });
    else createUser_(u.username, u.password, u.role, u.displayName, true);
  });
  setSetting_('DEMO_PASSWORDS_ACTIVE', 'true', 'system');
  logAudit_({ username: 'system', role: 'system' }, 'RESET_DEMO_PASSWORDS', 'Users', '', 'demo passwords reset', 'OK');
  return 'تمت إعادة كلمات المرور التجريبية.';
}

// ---------------------------------------------------------------- Demo data

function hasRealData_() {
  var s = WC.SHEETS;
  return [s.SALES_RAW, s.PURCHASES, s.EXPENSES, s.PAYROLL, s.RENT].some(function (n) { return getSheet_(n).getLastRow() > 1; });
}

var DEMO_MARK_ = 'DEMO';

function createDemoData_() {
  var by = 'system-demo';
  var t = now_();
  var month = fmtDate_(t, 'yyyy-MM');
  var d = todayStr_();
  appendObjects_(WC.SHEETS.PURCHASES, [entryRow_(by, {
    'Invoice Number': 'DEMO-001', 'Invoice Date': d, Supplier: 'مورد تجريبي', Category: 'بن', Description: 'بيانات تجريبية',
    Subtotal: 50, Tax: 2.5, Discount: 0, Total: 52.5, 'Paid Amount': 52.5, 'Remaining Amount': 0, 'Payment Method': 'نقد',
    'Payment Status': 'مدفوعة', 'Is Inventory': 'نعم', Notes: DEMO_MARK_, 'Dedupe Key': 'demo|1'
  }, 'PUR')]);
  appendObjects_(WC.SHEETS.EXPENSES, [entryRow_(by, {
    'Expense Date': d, 'Expense Type': 'كهرباء', Description: 'بيانات تجريبية', Amount: 15, 'Payment Method': 'نقد', Payee: 'الكهرباء', 'Payment Status': 'مدفوع', Notes: DEMO_MARK_
  }, 'EXP')]);
  appendObjects_(WC.SHEETS.PAYROLL, [entryRow_(by, {
    Employee: 'عامل تجريبي', Month: month, 'Basic Salary': 200, Allowance: 20, Overtime: 0, Deduction: 0, Advance: 0, 'Net Salary': 220,
    'Payment Date': d, 'Payment Method': 'تحويل بنكي', 'Payment Status': 'مدفوع', Notes: DEMO_MARK_
  }, 'PAY')]);
  appendObjects_(WC.SHEETS.RENT, [entryRow_(by, {
    Period: month, Landlord: 'مؤجر تجريبي', Amount: 150, 'Due Date': d, 'Payment Date': d, 'Payment Method': 'تحويل بنكي', Status: 'مدفوع', Notes: DEMO_MARK_
  }, 'RNT')]);
}

/** Physically removes demo rows (they are demo-only, so a hard delete is acceptable). */
function removeDemoData() {
  var removed = 0;
  WC.ENTRY_SHEETS.forEach(function (name) {
    var sh = getSheet_(name);
    var rows = readRows_(name).filter(function (r) { return String(r.Notes) === DEMO_MARK_ && String(r['Created By']) === 'system-demo'; });
    rows.sort(function (a, b) { return b._row - a._row; });
    rows.forEach(function (r) { sh.deleteRow(r._row); removed++; });
  });
  logAudit_({ username: 'system', role: 'system' }, 'REMOVE_DEMO_DATA', 'System', '', 'rows removed: ' + removed, 'OK');
  return removed;
}

/** Builds a full entry row with the common audit columns. */
function entryRow_(by, fields, prefix) {
  var t = now_();
  var base = {
    'Internal ID': newId_(prefix), 'Created At': t, 'Created By': by, 'Updated At': t, 'Updated By': by,
    'Record Status': WC.STATUS.ACTIVE, 'Cancelled By': '', 'Cancelled At': '', 'Cancel Reason': '', Notes: ''
  };
  Object.keys(fields).forEach(function (k) { base[k] = fields[k]; });
  return base;
}
