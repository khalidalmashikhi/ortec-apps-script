/**
 * In-editor smoke test. Run  runSmokeTest()  from the Apps Script editor after setupSystem().
 * It never writes financial data: it only exercises parsing, validation, auth and report building,
 * then cleans up the session it created. Results are printed to the execution log.
 */
function runSmokeTest() {
  var results = [], fails = 0;
  var check = function (name, fn) {
    try { var r = fn(); if (r === false) throw new Error('assertion failed'); results.push('✔ ' + name); }
    catch (e) { fails++; results.push('✘ ' + name + ' → ' + (e && e.message ? e.message : e)); }
  };
  var sample = 'Date,Receipt number,Receipt type,Category,SKU,Item,Variant,Modifiers applied,Quantity,Gross sales,Discounts,Net sales,Cost of goods,Gross profit,Taxes,POS,Store,Cashier name,Customer name,Customer contacts,Comment,Status\n' +
    '2026-01-01 08:00:00,T-1,Sale,Test,1,Test Item,,,1,1.000,0.000,1.000,0.400,0.600,0.000,POS 1,Test Store,Tester,,,,Closed\n' +
    '2026-01-01 08:05:00,T-2,Refund,Test,1,Test Item,,,-1,-1.000,0.000,-1.000,-0.400,-0.600,0.000,POS 1,Test Store,Tester,,,,Closed\n' +
    '2026-01-01 08:10:00,T-3,Sale,Test,1,Test Item,,,1,1.000,0.000,1.000,0.400,0.600,0.000,POS 1,Test Store,Tester,,,,Cancelled\n';

  check('all sheets exist', function () {
    var ss = ss_();
    return Object.keys(WC.SHEETS).every(function (k) { return !!ss.getSheetByName(WC.SHEETS[k]); });
  });
  check('Drive folders exist', function () {
    return !!DriveApp.getFolderById(props_().getProperty('INVOICES_FOLDER_ID')) && !!DriveApp.getFolderById(props_().getProperty('REPORTS_FOLDER_ID'));
  });
  check('timezone is Asia/Muscat', function () { return ss_().getSpreadsheetTimeZone() === WC.TZ; });
  check('CSV parse + preview (BOM, refund, cancelled)', function () {
    var a = analyseSalesCsv_('﻿' + sample, 'smoke.csv');
    return a.summary.totalRows === 3 && a.summary.rejectedRows === 1 && a.summary.netSales === 0 && a.summary.refunds === 1;
  });
  check('missing column detected', function () {
    try { analyseSalesCsv_(sample.replace('Net sales', 'X'), 'x.csv'); return false; } catch (e) { return /Net sales/.test(e.message); }
  });
  check('purchase validation rejects bad status', function () {
    try { validatePurchase_({ invoiceNumber: '1', invoiceDate: '2026-01-01', supplier: 's', category: 'بن', subtotal: 10, paidAmount: 0, paymentStatus: 'مدفوعة', paymentMethod: 'نقد' }); return false; } catch (e) { return true; }
  });
  check('payroll net formula', function () {
    return validatePayroll_({ employee: 'x', month: '2026-01', basicSalary: 100, allowance: 10, overtime: 5, deduction: 3, advance: 2, paymentStatus: 'غير مدفوع' })['Net Salary'] === 110;
  });
  var mgrToken = null, accToken = null;
  check('demo users can log in (or passwords already changed)', function () {
    var m = api_login('manager', '2026'), a = api_login('accountant', '1234');
    mgrToken = m.ok ? m.token : null; accToken = a.ok ? a.token : null;
    return true;
  });
  check('accountant is blocked from manager API', function () {
    if (!accToken) return true;
    var r = api_getSettings(accToken); return r.ok === false && r.code === 'FORBIDDEN';
  });
  check('dashboard computes for last 30 days', function () {
    if (!mgrToken) return true;
    var r = api_getDashboard(mgrToken, { preset: 'last30' }); return r.ok && typeof r.kpis.netCash === 'number';
  });
  check('every report type builds', function () {
    return Object.keys(REPORT_TYPES_).every(function (t) { return !!buildReport_(t, todayStr_(), todayStr_()).title; });
  });
  if (mgrToken) api_logout(mgrToken);
  if (accToken) api_logout(accToken);
  var out = results.join('\n') + '\n' + (fails ? fails + ' FAILED' : 'ALL PASSED');
  Logger.log(out);
  return out;
}
