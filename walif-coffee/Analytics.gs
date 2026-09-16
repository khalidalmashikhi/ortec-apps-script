/**
 * Financial engine + manager dashboard data.
 *
 * Accounting P&L  : Net sales − COGS (from Loyverse) = Gross profit; − (expenses + payroll + rent) = Operating profit.
 *                   Inventory purchases are NOT deducted again (their sold share is already inside COGS).
 * Cash movement   : Net sales − purchases paid − expenses paid − payroll paid − rent paid.
 *
 * Attribution: expenses by Expense Date; purchases by Invoice Date (Paid Amount is treated as paid on that date);
 * payroll/rent by Payment Date when paid, otherwise by the period (last day of Month / Due Date).
 */

function monthEnd_(ym) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return '';
  var last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return m[1] + '-' + m[2] + '-' + ('0' + last).slice(-2);
}

function activeRows_(sheet) {
  return readRows_(sheet).filter(function (r) { return String(r['Record Status']) === WC.STATUS.ACTIVE; });
}

function pick_(rows, dateFn, from, to) {
  return rows.filter(function (r) { return inRange_(dateFn(r), from, to); });
}

/** Everything the dashboard/report needs for one period. */
function computeFinancials_(from, to, salesFilters) {
  salesFilters = salesFilters || {};
  var sales = loadSales_().filter(function (r) {
    if (!inRange_(r._d, from, to)) return false;
    if (salesFilters.store && String(r.Store) !== salesFilters.store) return false;
    if (salesFilters.pos && String(r.POS) !== salesFilters.pos) return false;
    if (salesFilters.cashier && String(r['Cashier name']) !== salesFilters.cashier) return false;
    if (salesFilters.category && String(r.Category) !== salesFilters.category) return false;
    if (salesFilters.item && String(r.Item) !== salesFilters.item) return false;
    return true;
  });

  var purchases = pick_(activeRows_(WC.SHEETS.PURCHASES), function (r) { return dateCell_(r['Invoice Date']); }, from, to);
  var expenses = pick_(activeRows_(WC.SHEETS.EXPENSES), function (r) { return dateCell_(r['Expense Date']); }, from, to);
  var payrollAll = activeRows_(WC.SHEETS.PAYROLL).map(function (r) {
    r.Month = ymCell_(r.Month);
    r._paid = String(r['Payment Status']) === 'مدفوع';
    r._d = r._paid && dateCell_(r['Payment Date']) ? dateCell_(r['Payment Date']) : monthEnd_(r.Month);
    return r;
  });
  var rentAll = activeRows_(WC.SHEETS.RENT).map(function (r) {
    r.Period = ymCell_(r.Period);
    r._paid = String(r.Status) === 'مدفوع';
    r._d = r._paid && dateCell_(r['Payment Date']) ? dateCell_(r['Payment Date']) : dateCell_(r['Due Date']);
    return r;
  });
  var payroll = pick_(payrollAll, function (r) { return r._d; }, from, to);
  var rent = pick_(rentAll, function (r) { return r._d; }, from, to);
  var withdrawals = pick_(activeRows_(WC.SHEETS.WITHDRAWALS), function (r) { return dateCell_(r['Withdrawal Date']); }, from, to);

  var receipts = {};
  sales.forEach(function (r) { receipts[String(r['Receipt number'])] = true; });
  var receiptCount = Object.keys(receipts).length;

  var grossSales = sumBy_(sales, 'Gross sales');
  var discounts = sumBy_(sales, 'Discounts');
  var netSales = sumBy_(sales, 'Net sales');
  var cogs = sumBy_(sales, 'Cost of goods');
  var loyverseGrossProfit = sumBy_(sales, 'Gross profit');
  var taxes = sumBy_(sales, 'Taxes');
  var grossProfit = round3_(netSales - cogs);

  var inventoryPurchases = sumBy_(purchases.filter(function (r) { return String(r['Is Inventory']) === 'نعم'; }), 'Total');
  var nonInventoryPurchases = sumBy_(purchases.filter(function (r) { return String(r['Is Inventory']) !== 'نعم'; }), 'Total');
  var purchasesPaid = sumBy_(purchases, 'Paid Amount');
  var purchasesUnpaid = sumBy_(purchases, 'Remaining Amount');

  var expensesTotal = sumBy_(expenses, 'Amount');
  var expensesPaid = sumBy_(expenses.filter(function (r) { return String(r['Payment Status']) === 'مدفوع'; }), 'Amount');
  var payrollTotal = sumBy_(payroll, 'Net Salary');
  var payrollPaid = sumBy_(payroll.filter(function (r) { return r._paid; }), 'Net Salary');
  var rentTotal = sumBy_(rent, 'Amount');
  var rentPaid = sumBy_(rent.filter(function (r) { return r._paid; }), 'Amount');

  var operatingExpenses = round3_(expensesTotal + payrollTotal + rentTotal);
  var operatingProfit = round3_(grossProfit - operatingExpenses);

  // Cash withdrawals: deposits to the bank are internal transfers; the rest left the business.
  var isBank = function (r) { return String(r.Destination) === WC.WITHDRAWAL_TO_BANK; };
  var withdrawalsTotal = sumBy_(withdrawals, 'Amount');
  var withdrawalsToBank = sumBy_(withdrawals.filter(isBank), 'Amount');
  var withdrawalsOut = round3_(withdrawalsTotal - withdrawalsToBank);
  // Anything paid out of already-withdrawn cash must not reduce the cash movement twice.
  var fromW = function (r) { return String(r['Payment Method']) === WC.PAID_FROM_WITHDRAWN; };
  var paidFromWithdrawn = round3_(sumBy_(purchases.filter(fromW), 'Paid Amount') +
    sumBy_(expenses.filter(function (r) { return fromW(r) && String(r['Payment Status']) === 'مدفوع'; }), 'Amount') +
    sumBy_(payroll.filter(function (r) { return fromW(r) && r._paid; }), 'Net Salary') +
    sumBy_(rent.filter(function (r) { return fromW(r) && r._paid; }), 'Amount'));
  var netCash = round3_(netSales - purchasesPaid - expensesPaid - payrollPaid - rentPaid + paidFromWithdrawn - withdrawalsOut);

  return {
    from: from, to: to,
    kpis: {
      grossSales: grossSales, discounts: discounts, netSales: netSales, cogs: cogs, grossProfit: grossProfit,
      loyverseGrossProfit: loyverseGrossProfit, grossProfitDiff: round3_(grossProfit - loyverseGrossProfit),
      grossMargin: netSales ? round3_(grossProfit / netSales * 100) : 0, taxes: taxes,
      inventoryPurchases: inventoryPurchases, nonInventoryPurchases: nonInventoryPurchases, purchasesTotal: round3_(inventoryPurchases + nonInventoryPurchases),
      purchasesPaid: purchasesPaid, purchasesUnpaid: purchasesUnpaid,
      expenses: expensesTotal, expensesPaid: expensesPaid, payroll: payrollTotal, payrollPaid: payrollPaid, rent: rentTotal, rentPaid: rentPaid,
      operatingExpenses: operatingExpenses, operatingProfit: operatingProfit, netCash: netCash,
      withdrawals: withdrawalsTotal, withdrawalsToBank: withdrawalsToBank, withdrawalsOut: withdrawalsOut, paidFromWithdrawn: paidFromWithdrawn,
      receipts: receiptCount, avgReceipt: receiptCount ? round3_(netSales / receiptCount) : 0,
      quantity: sumBy_(sales, 'Quantity'), rows: sales.length,
      refunds: round3_(sales.filter(function (r) { return r['Receipt type'] === 'Refund'; }).reduce(function (t, r) { return t + r['Net sales']; }, 0))
    },
    _sales: sales, _purchases: purchases, _expenses: expenses, _payroll: payroll, _rent: rent, _withdrawals: withdrawals
  };
}

// ---------------------------------------------------------------- breakdowns

function salesBreakdowns_(sales, limit) {
  limit = limit || 10;
  var byDay = {}, byHour = {}, byItem = {}, byCat = {}, byCashier = {}, byStore = {}, byPos = {}, discountsByDay = {}, discountsByItem = {};
  var itemQty = {}, itemCogs = {}, dayCogs = {}, dayReceipts = {};
  for (var h = 0; h < 24; h++) byHour[h] = 0;
  sales.forEach(function (r) {
    var d = r._d, net = r['Net sales'];
    byDay[d] = round3_((byDay[d] || 0) + net);
    dayCogs[d] = round3_((dayCogs[d] || 0) + r['Cost of goods']);
    (dayReceipts[d] = dayReceipts[d] || {})[String(r['Receipt number'])] = true;
    byHour[r._hour] = round3_((byHour[r._hour] || 0) + net);
    var item = String(r.Item) + (r.Variant ? ' — ' + r.Variant : '');
    byItem[item] = round3_((byItem[item] || 0) + net);
    itemQty[item] = round3_((itemQty[item] || 0) + r.Quantity);
    itemCogs[item] = round3_((itemCogs[item] || 0) + r['Cost of goods']);
    var cat = String(r.Category || '—');
    byCat[cat] = round3_((byCat[cat] || 0) + net);
    var cs = String(r['Cashier name'] || '—'); byCashier[cs] = round3_((byCashier[cs] || 0) + net);
    var st = String(r.Store || '—'); byStore[st] = round3_((byStore[st] || 0) + net);
    var pos = String(r.POS || '—'); byPos[pos] = round3_((byPos[pos] || 0) + net);
    if (r.Discounts) { discountsByDay[d] = round3_((discountsByDay[d] || 0) + r.Discounts); discountsByItem[item] = round3_((discountsByItem[item] || 0) + r.Discounts); }
  });
  var days = Object.keys(byDay).sort().map(function (d) {
    return { date: d, net: byDay[d], cogs: dayCogs[d], profit: round3_(byDay[d] - dayCogs[d]), receipts: Object.keys(dayReceipts[d]).length };
  });
  var items = Object.keys(byItem).map(function (k) { return { item: k, net: byItem[k], qty: itemQty[k], cogs: itemCogs[k], profit: round3_(byItem[k] - itemCogs[k]) }; });
  items.sort(function (a, b) { return b.net - a.net; });
  return {
    daily: days,
    hourly: Object.keys(byHour).map(function (h) { return { hour: +h, net: byHour[h] }; }).sort(function (a, b) { return a.hour - b.hour; }),
    byItem: items,
    topItems: items.slice(0, limit),
    bottomItems: items.filter(function (i) { return i.net > 0; }).slice(-limit).reverse(),
    byCategory: mapToSortedArray_(byCat, 'category', 'net'),
    byCashier: mapToSortedArray_(byCashier, 'cashier', 'net'),
    byStore: mapToSortedArray_(byStore, 'store', 'net'),
    byPos: mapToSortedArray_(byPos, 'pos', 'net'),
    discountsByDay: Object.keys(discountsByDay).sort().map(function (d) { return { date: d, discounts: discountsByDay[d] }; }),
    discountsByItem: mapToSortedArray_(discountsByItem, 'item', 'discounts')
  };
}

function costBreakdowns_(fin) {
  var expByDay = {}, purByDay = {}, payByDay = {}, rentByDay = {};
  fin._expenses.forEach(function (r) { var d = dateCell_(r['Expense Date']); expByDay[d] = round3_((expByDay[d] || 0) + toNum_(r.Amount)); });
  fin._purchases.forEach(function (r) { var d = dateCell_(r['Invoice Date']); purByDay[d] = round3_((purByDay[d] || 0) + toNum_(r['Paid Amount'])); });
  fin._payroll.forEach(function (r) { payByDay[r._d] = round3_((payByDay[r._d] || 0) + toNum_(r['Net Salary'])); });
  fin._rent.forEach(function (r) { rentByDay[r._d] = round3_((rentByDay[r._d] || 0) + toNum_(r.Amount)); });
  var payrollByMonth = {};
  fin._payroll.forEach(function (r) { var m = String(r.Month); payrollByMonth[m] = round3_((payrollByMonth[m] || 0) + toNum_(r['Net Salary'])); });
  return {
    purchasesBySupplier: mapToSortedArray_(groupSum_(fin._purchases, 'Supplier', 'Total'), 'supplier', 'total'),
    purchasesByCategory: mapToSortedArray_(groupSum_(fin._purchases, 'Category', 'Total'), 'category', 'total'),
    expensesByType: mapToSortedArray_(groupSum_(fin._expenses, 'Expense Type', 'Amount'), 'type', 'amount'),
    payrollByMonth: Object.keys(payrollByMonth).sort().map(function (m) { return { month: m, amount: payrollByMonth[m] }; }),
    withdrawalsByDestination: mapToSortedArray_(groupSum_(fin._withdrawals, 'Destination', 'Amount'), 'destination', 'amount'),
    withdrawalsList: fin._withdrawals.slice().sort(function (a, b) { return dateCell_(b['Withdrawal Date']) < dateCell_(a['Withdrawal Date']) ? -1 : 1; }).map(function (r) { return { id: r['Internal ID'], date: dateCell_(r['Withdrawal Date']), amount: toNum_(r.Amount), destination: String(r.Destination), description: String(r.Description || ''), url: String(r['Attachment URL'] || ''), by: String(r['Created By'] || '') }; }),
    rentList: fin._rent.map(function (r) { return { id: r['Internal ID'], period: r.Period, landlord: r.Landlord, amount: toNum_(r.Amount), dueDate: dateCell_(r['Due Date']), paymentDate: dateCell_(r['Payment Date']), status: r.Status }; }),
    expensesByDay: expByDay, purchasesPaidByDay: purByDay, payrollByDay: payByDay, rentByDay: rentByDay
  };
}

/** Day-level and month-level comparison of sales / operating expenses / profit / cash. */
function comparisonSeries_(fin, sb, cb) {
  var days = {};
  var touch = function (d) { if (!days[d]) days[d] = { date: d, net: 0, cogs: 0, expenses: 0, payroll: 0, rent: 0, purchasesPaid: 0 }; return days[d]; };
  sb.daily.forEach(function (x) { var d = touch(x.date); d.net = x.net; d.cogs = x.cogs; });
  Object.keys(cb.expensesByDay).forEach(function (d) { touch(d).expenses = cb.expensesByDay[d]; });
  Object.keys(cb.payrollByDay).forEach(function (d) { touch(d).payroll = cb.payrollByDay[d]; });
  Object.keys(cb.rentByDay).forEach(function (d) { touch(d).rent = cb.rentByDay[d]; });
  Object.keys(cb.purchasesPaidByDay).forEach(function (d) { touch(d).purchasesPaid = cb.purchasesPaidByDay[d]; });
  var daily = Object.keys(days).sort().map(function (k) {
    var d = days[k];
    d.opex = round3_(d.expenses + d.payroll + d.rent);
    d.profit = round3_(d.net - d.cogs - d.opex);
    return d;
  });
  var months = {};
  daily.forEach(function (d) {
    var m = d.date.slice(0, 7);
    var o = months[m] || (months[m] = { month: m, net: 0, cogs: 0, opex: 0, purchasesPaid: 0, profit: 0 });
    o.net = round3_(o.net + d.net); o.cogs = round3_(o.cogs + d.cogs); o.opex = round3_(o.opex + d.opex);
    o.purchasesPaid = round3_(o.purchasesPaid + d.purchasesPaid); o.profit = round3_(o.profit + d.profit);
  });
  return { daily: daily, monthly: Object.keys(months).sort().map(function (m) { return months[m]; }) };
}

// ---------------------------------------------------------------- period helpers

function periodRange_(preset, from, to) {
  var today = parseDateOnly_(todayStr_());
  var f, t;
  switch (String(preset || 'custom')) {
    case 'today': f = t = today; break;
    case 'yesterday': f = t = addDays_(today, -1); break;
    case 'last7': f = addDays_(today, -6); t = today; break;
    case 'last30': f = addDays_(today, -29); t = today; break;
    case 'this_month': f = parseDateOnly_(fmtDate_(today, 'yyyy-MM') + '-01'); t = today; break;
    case 'last_month':
      var firstThis = parseDateOnly_(fmtDate_(today, 'yyyy-MM') + '-01');
      t = addDays_(firstThis, -1); f = parseDateOnly_(fmtDate_(t, 'yyyy-MM') + '-01'); break;
    case 'this_week': var dow = (+fmtDate_(today, 'u')) % 7; f = addDays_(today, -dow); t = today; break; // Sunday-based
    default:
      f = parseDateOnly_(from) || addDays_(today, -29); t = parseDateOnly_(to) || today;
  }
  if (f > t) { var x = f; f = t; t = x; }
  return { from: fmtDate_(f), to: fmtDate_(t) };
}

// ---------------------------------------------------------------- bank balance

/**
 * Current bank balance = opening balance (Settings) + net cash movement from the opening date until today.
 * Independent of the dashboard filters so the figure is always "as of now".
 */
function bankBalance_() {
  var s = getAllSettings_();
  var opening = round3_(toNum_(s.OPENING_BALANCE));
  var openingDate = fmtDate_(parseDateOnly_(s.OPENING_BALANCE_DATE));
  if (!openingDate) return { configured: false, opening: opening, openingDate: '', movement: 0, balance: opening, asOf: todayStr_() };
  var today = todayStr_();
  var movement = 0;
  if (openingDate <= today) movement = computeFinancials_(openingDate, today, {}).kpis.netCash;
  return { configured: true, opening: opening, openingDate: openingDate, movement: movement, balance: round3_(opening + movement), asOf: today };
}

// ---------------------------------------------------------------- API

function api_getDashboard(token, filters) {
  return apiCall_('api_getDashboard', token, [WC.ROLES.MANAGER], function () {
    filters = filters || {};
    var range = periodRange_(filters.preset, filters.from, filters.to);
    var sf = { store: cleanText_(filters.store, 100), pos: cleanText_(filters.pos, 100), cashier: cleanText_(filters.cashier, 100),
      category: cleanText_(filters.category, 100), item: cleanText_(filters.item, 200) };
    var fin = computeFinancials_(range.from, range.to, sf);
    var sb = salesBreakdowns_(fin._sales, 10);
    var cb = costBreakdowns_(fin);
    var cmp = comparisonSeries_(fin, sb, cb);
    delete cb.expensesByDay; delete cb.purchasesPaidByDay; delete cb.payrollByDay; delete cb.rentByDay;
    cb.withdrawalsList = cb.withdrawalsList.slice(0, 50);
    var out = {
      ok: true, range: range, kpis: fin.kpis, bank: bankBalance_(), sales: sb, costs: cb, comparison: cmp,
      options: filterOptions_(),
      note: 'شراء المخزون يؤثر على النقد عند دفعه، بينما تكلفة الجزء المباع منه فقط تظهر في الربح من خلال Cost of goods القادمة من Loyverse. لذلك لا تُخصم فواتير المخزون مرة ثانية من صافي الربح. الكاش المسحوب للإيداع في البنك تحويل داخلي لا يغيّر الرصيد، والمسحوب للمصاريف يُخصم مرة واحدة؛ لذلك سجّل ما يُدفع منه بطريقة الدفع "كاش مسحوب".',
      demoPasswordsActive: getSetting_('DEMO_PASSWORDS_ACTIVE') === 'true'
    };
    delete out.sales.byItem;
    return out;
  });
}

function filterOptions_() {
  var stores = {}, pos = {}, cashiers = {}, cats = {}, items = {};
  loadSales_().forEach(function (r) {
    if (r.Store) stores[r.Store] = 1; if (r.POS) pos[r.POS] = 1; if (r['Cashier name']) cashiers[r['Cashier name']] = 1;
    if (r.Category) cats[r.Category] = 1; if (r.Item) items[r.Item] = 1;
  });
  var keys = function (o) { return Object.keys(o).sort(); };
  return { stores: keys(stores), pos: keys(pos), cashiers: keys(cashiers), categories: keys(cats), items: keys(items) };
}
