/**
 * Shared listing, cancel (soft delete) and edit-with-reason for entry sheets.
 * Financial records are never hard-deleted: Record Status becomes CANCELLED.
 */

var EDITABLE_FIELDS_ = {
  Purchases: ['Invoice Number', 'Invoice Date', 'Supplier', 'Category', 'Description', 'Subtotal', 'Tax', 'Discount', 'Paid Amount', 'Payment Method', 'Payment Status', 'Is Inventory', 'Notes'],
  Expenses: ['Expense Date', 'Expense Type', 'Description', 'Amount', 'Payment Method', 'Payee', 'Payment Status', 'Notes'],
  Payroll: ['Employee', 'Month', 'Basic Salary', 'Allowance', 'Overtime', 'Deduction', 'Advance', 'Payment Date', 'Payment Method', 'Payment Status', 'Notes'],
  Rent: ['Period', 'Landlord', 'Amount', 'Due Date', 'Payment Date', 'Payment Method', 'Status', 'Notes']
};

function entitySheet_(entity) {
  var map = { purchases: WC.SHEETS.PURCHASES, expenses: WC.SHEETS.EXPENSES, payroll: WC.SHEETS.PAYROLL, rent: WC.SHEETS.RENT, sales: WC.SHEETS.SALES_RAW };
  var name = map[String(entity || '').toLowerCase()];
  if (!name) throw new Error('نوع السجل غير معروف.');
  return name;
}

/** Accountant sees only rows they created; manager sees all. */
function listEntries_(sheetName, actor, filters, dateField) {
  filters = filters || {};
  var rows = readRows_(sheetName);
  if (actor.role !== WC.ROLES.MANAGER) rows = rows.filter(function (r) { return String(r['Created By']) === actor.username; });
  var from = cleanText_(filters.from, 10), to = cleanText_(filters.to, 10);
  if (from || to) rows = rows.filter(function (r) { return inRange_(dateCell_(r[dateField]) || dateCell_(r['Created At']), from, to); });
  if (filters.status) rows = rows.filter(function (r) { return String(r['Record Status']) === String(filters.status); });
  var n = Math.min(Math.max(toNum_(filters.limit) || 200, 1), 2000);
  return rows.slice(-n).reverse().map(function (r) {
    delete r._row; delete r['Dedupe Key'];
    Object.keys(r).forEach(function (k) { if (typeof r[k] === 'string' && r[k].charAt(0) === "'") r[k] = r[k].slice(1); });
    if ('Month' in r) r.Month = ymCell_(r.Month);
    if ('Period' in r) r.Period = ymCell_(r.Period);
    return r;
  });
}

function api_cancelRecord(token, entity, id, reason) {
  return apiCall_('api_cancelRecord', token, [WC.ROLES.MANAGER], function (actor) {
    var sheet = entitySheet_(entity);
    reason = cleanText_(reason, 500);
    if (!reason) throw new Error('سبب الإلغاء مطلوب.');
    return withLock_(function () {
      var row = findRowById_(sheet, id);
      if (!row) throw new Error('السجل غير موجود.');
      if (String(row['Record Status']) === WC.STATUS.CANCELLED) throw new Error('السجل ملغى مسبقًا.');
      var fields = { 'Record Status': WC.STATUS.CANCELLED, 'Cancelled By': actor.username, 'Cancelled At': now_(), 'Cancel Reason': reason };
      if (sheet !== WC.SHEETS.SALES_RAW) { fields['Updated At'] = now_(); fields['Updated By'] = actor.username; }
      updateRowFields_(sheet, row._row, fields);
      logAudit_(actor, 'CANCEL_RECORD', sheet, String(id), 'reason=' + reason, 'OK');
      return { ok: true };
    });
  });
}

function api_updateRecord(token, entity, id, changes, reason) {
  return apiCall_('api_updateRecord', token, [WC.ROLES.MANAGER], function (actor) {
    var sheet = entitySheet_(entity);
    if (sheet === WC.SHEETS.SALES_RAW) throw new Error('سجلات المبيعات المستوردة لا تُعدَّل، يمكن إلغاؤها فقط.');
    reason = cleanText_(reason, 500);
    if (!reason) throw new Error('سبب التعديل مطلوب.');
    var allowed = EDITABLE_FIELDS_[sheet];
    return withLock_(function () {
      var row = findRowById_(sheet, id);
      if (!row) throw new Error('السجل غير موجود.');
      if (String(row['Record Status']) !== WC.STATUS.ACTIVE) throw new Error('لا يمكن تعديل سجل ملغى.');
      var merged = {};
      Object.keys(row).forEach(function (k) { if (k !== '_row') merged[k] = typeof row[k] === 'string' && row[k].charAt(0) === "'" ? row[k].slice(1) : row[k]; });
      if ('Month' in merged) merged.Month = ymCell_(merged.Month);
      if ('Period' in merged) merged.Period = ymCell_(merged.Period);
      var changed = [];
      Object.keys(changes || {}).forEach(function (k) {
        if (allowed.indexOf(k) < 0) throw new Error('الحقل غير قابل للتعديل: ' + k);
        if (String(merged[k]) !== String(changes[k])) { changed.push(k + ': "' + merged[k] + '" → "' + changes[k] + '"'); }
        merged[k] = changes[k];
      });
      if (!changed.length) throw new Error('لا توجد تغييرات.');
      var revalidated = revalidateRecord_(sheet, merged);
      revalidated['Updated At'] = now_(); revalidated['Updated By'] = actor.username;
      revalidated.Notes = (merged.Notes ? merged.Notes + ' | ' : '') + 'تعديل (' + actor.username + '): ' + reason;
      updateRowFields_(sheet, row._row, revalidated);
      logAudit_(actor, 'UPDATE_RECORD', sheet, String(id), 'reason=' + reason + '; ' + changed.join('; '), 'OK');
      return { ok: true };
    });
  });
}

/** Re-run the module validator against the merged record and return sheet-ready fields. */
function revalidateRecord_(sheet, m) {
  var toDate = function (v) { return v instanceof Date ? fmtDate_(v) : v; };
  if (sheet === WC.SHEETS.PURCHASES) return validatePurchase_({
    invoiceNumber: m['Invoice Number'], invoiceDate: toDate(m['Invoice Date']), supplier: m.Supplier, category: m.Category, description: m.Description,
    subtotal: m.Subtotal, tax: m.Tax, discount: m.Discount, paidAmount: m['Paid Amount'], paymentMethod: m['Payment Method'],
    paymentStatus: m['Payment Status'], isInventory: m['Is Inventory'], notes: m.Notes });
  if (sheet === WC.SHEETS.EXPENSES) return validateExpense_({
    expenseDate: toDate(m['Expense Date']), expenseType: m['Expense Type'], description: m.Description, amount: m.Amount,
    paymentMethod: m['Payment Method'], payee: m.Payee, paymentStatus: m['Payment Status'], notes: m.Notes });
  if (sheet === WC.SHEETS.PAYROLL) return validatePayroll_({
    employee: m.Employee, month: m.Month, basicSalary: m['Basic Salary'], allowance: m.Allowance, overtime: m.Overtime, deduction: m.Deduction,
    advance: m.Advance, paymentDate: toDate(m['Payment Date']), paymentMethod: m['Payment Method'], paymentStatus: m['Payment Status'], notes: m.Notes });
  if (sheet === WC.SHEETS.RENT) return validateRent_({
    period: m.Period, landlord: m.Landlord, amount: m.Amount, dueDate: toDate(m['Due Date']), paymentDate: toDate(m['Payment Date']),
    paymentMethod: m['Payment Method'], status: m.Status, notes: m.Notes });
  throw new Error('غير مدعوم.');
}

/** Manager: raw sales rows for a range (for the "all sales" table). */
function api_listSales(token, filters) {
  return apiCall_('api_listSales', token, [WC.ROLES.MANAGER], function () {
    filters = filters || {};
    var from = cleanText_(filters.from, 10), to = cleanText_(filters.to, 10);
    var rows = loadSales_().filter(function (r) { return inRange_(r._d, from, to); });
    var n = Math.min(Math.max(toNum_(filters.limit) || 500, 1), 5000);
    return { ok: true, total: rows.length, rows: rows.slice(-n).reverse().map(function (r) {
      return { id: r['Internal ID'], date: fmtDateTime_(r.Date), receipt: r['Receipt number'], type: r['Receipt type'], category: r.Category,
        item: r.Item, variant: r.Variant, qty: r.Quantity, gross: r['Gross sales'], discount: r.Discounts, net: r['Net sales'],
        cogs: r['Cost of goods'], profit: r['Gross profit'], tax: r.Taxes, pos: r.POS, store: r.Store, cashier: r['Cashier name'], importId: r['Import ID'] };
    }) };
  });
}
