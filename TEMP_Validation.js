/**
 * TEMPORARY staging-only validation harness. DELETE BEFORE ANY VERSION.
 *
 * Exists solely because automated execution from outside is impossible:
 * clasp run and the Execution API both require an API-executable deployment
 * (which we are not permitted to create) and OAuth scopes this environment does
 * not hold. Every function here is prefixed TEMP_ and is removed in the
 * cleanup push.
 *
 * Run TEMP_validate once from the editor. It performs, in order:
 *   1. the full regression suite in the real runtime
 *   2. read-only production diagnostics
 *   3. one 2026-07-17 report, rendered and then trashed
 *
 * It does NOT send email, modify triggers, import data, create a version or
 * touch a deployment. The only production side effect is a single report PDF,
 * which it trashes before returning.
 */

function TEMP_validate() {
  const out = { startedAt: new Date().toISOString(), runtime: 'apps-script' };

  // ---- 1. regression suite -------------------------------------------------
  try {
    const suite = runAllTests_();
    out.tests = {
      total: suite.total,
      passed: suite.passed,
      failed: suite.failures.length,
      failures: suite.failures.map(function (f) { return f.name + (f.detail ? ' — ' + f.detail : ''); })
    };
  } catch (error) {
    out.tests = { error: String(error && error.message ? error.message : error) };
  }

  // ---- 2. read-only diagnostics -------------------------------------------
  try {
    out.diagnostics = ortecDiagnostics_();
  } catch (error) {
    out.diagnostics = { error: String(error && error.message ? error.message : error) };
  }

  // ---- 3. historical report validation ------------------------------------
  try {
    out.report = TEMP_validateHistoricalReport_('2026-07-17');
  } catch (error) {
    out.report = { error: String(error && error.message ? error.message : error) };
  }

  out.finishedAt = new Date().toISOString();
  console.log('===== TEMP_validate BEGIN =====');
  console.log(JSON.stringify(out, null, 2));
  console.log('===== TEMP_validate END =====');
  return out;
}

/**
 * Builds the report payload for `date`, checks it against independently summed
 * sheet rows, renders one PDF, inspects its name, then trashes it.
 * No email, no audit row, no session — renderReportPdf_ is called directly.
 */
function TEMP_validateHistoricalReport_(date) {
  const result = { requestedDate: date };

  // Which dates actually hold data, so a zero result can be interpreted.
  const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS);
  const byDate = {};
  items.forEach(function (r) {
    const d = normalizeDate_(r.receipt_date);
    if (d) byDate[d] = (byDate[d] || 0) + 1;
  });
  const dates = Object.keys(byDate).sort();
  result.storedCoverage = {
    distinctDates: dates.length,
    earliest: dates[0] || null,
    latest: dates[dates.length - 1] || null,
    rowsOnRequestedDate: byDate[date] || 0,
    busiestDate: dates.sort(function (a, b) { return byDate[b] - byDate[a]; })[0] || null
  };

  const payload = buildReportPayload_('DAILY', date, date, 'ALL');
  result.payload = {
    sales: payload.sales, orders: payload.orders, grossProfit: payload.grossProfit,
    expenses: payload.expenses, netProfit: payload.netProfit,
    margin: Number(payload.margin).toFixed(2),
    topItems: payload.topItems.length, branches: payload.branchPerformance.length,
    periodLabel: payload.periodLabel
  };
  result.nonZeroBusinessData = payload.orders > 0 && payload.sales !== 0;

  // Independent reconciliation: sum the raw rows for this date ourselves and
  // compare against what the report computed.
  const dayItems = items.filter(function (r) { return normalizeDate_(r.receipt_date) === date; });
  const dayReceipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS)
    .filter(function (r) { return normalizeDate_(r.receipt_date) === date; });
  const expectedSales = sumField_(dayReceipts, 'net_sales');
  const expectedProfit = sumField_(dayItems, 'profit');
  result.reconciliation = {
    expectedSalesFromSheet: expectedSales,
    reportSales: payload.sales,
    salesMatch: Math.abs(expectedSales - payload.sales) < 0.005,
    expectedProfitFromSheet: expectedProfit,
    reportGrossProfit: payload.grossProfit,
    profitMatch: Math.abs(expectedProfit - payload.grossProfit) < 0.005,
    expectedOrders: dayReceipts.length,
    reportOrders: payload.orders,
    ordersMatch: dayReceipts.length === payload.orders
  };

  // Render exactly one PDF, inspect the filename, then trash it.
  const file = renderReportPdf_(payload, { name_ar: 'TEMP validation', username: 'TEMP' });
  const name = file.getName();
  result.pdf = {
    created: true,
    fileName: name,
    containsRequestedDate: name.indexOf(date) !== -1,
    containsObjectObject: name.indexOf('[object Object]') !== -1,
    sizeBytes: file.getSize()
  };
  try {
    file.setTrashed(true);
    result.pdf.trashedAfterValidation = true;
  } catch (error) {
    result.pdf.trashedAfterValidation = false;
    result.pdf.trashError = String(error && error.message ? error.message : error);
  }

  result.verdict =
    result.pdf.containsRequestedDate &&
    !result.pdf.containsObjectObject &&
    result.reconciliation.salesMatch &&
    result.reconciliation.ordersMatch
      ? 'PASS' : 'REVIEW';
  return result;
}
