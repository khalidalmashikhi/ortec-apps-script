#!/usr/bin/env node
/**
 * End-to-end test of the Walif Coffee server code against the in-memory simulator.
 * Mirrors the mandatory checklist (section 14) as far as it can run outside Google.
 *   node tools/run-local-tests.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path');
const sim = require('./gas-sim');
const G = sim.load();
const S = G.__sim;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ✔', name); } catch (e) { failed++; console.log('  ✘', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); } }
function ok(r, label) { assert.ok(r && r.ok, (label || 'api') + ' failed: ' + (r && r.error)); return r; }
const csv = fs.readFileSync(path.join(__dirname, '..', 'tests', 'sample-loyverse.csv'), 'utf8');
const csvBom = '\uFEFF' + csv;

console.log('\n1-2. setupSystem()');
let setupReport;
test('setupSystem creates sheets, folders, users, settings', () => {
  setupReport = G.setupSystem();
  const names = S.ss.getSheets().map(s => s.getName());
  for (const n of ['Dashboard_Data', 'Sales_Raw', 'Sales_Imports', 'Purchases', 'Expenses', 'Payroll', 'Rent', 'Users', 'Settings', 'Audit_Log', 'Error_Log']) assert.ok(names.includes(n), 'missing sheet ' + n);
  assert.ok(!names.includes('Sheet1'), 'default sheet should be removed');
  assert.ok(S.findFolder('Walif Coffee Accounting/Invoices'), 'Invoices folder');
  assert.ok(S.findFolder('Walif Coffee Accounting/Reports'), 'Reports folder');
  assert.strictEqual(S.ss.getSpreadsheetTimeZone(), 'Asia/Muscat');
  assert.ok(S.ss.getSheetByName('Users').hidden, 'Users hidden');
  assert.strictEqual(S.ss.getSheetByName('Sales_Raw').frozen, 1);
  assert.strictEqual(JSON.stringify(setupReport.users.slice().sort()), '["accountant","manager"]');
  assert.ok(setupReport.demoData, 'demo data created on first run');
});
test('Users sheet holds no password / hash', () => {
  const cells = S.ss.getSheetByName('Users').data.flat().map(String);
  assert.ok(!cells.some(c => c === '1234' || c === '2026' || /^[0-9a-f]{64}$/i.test(c)), 'Users sheet leaks secrets: ' + cells.join(' '));
  assert.ok(S.STATE.props.WC_USER_manager && JSON.parse(S.STATE.props.WC_USER_manager).salt, 'hash+salt in properties');
});
test('setupSystem is idempotent', () => {
  const before = S.ss.getSheetByName('Purchases').getLastRow();
  const r2 = G.setupSystem();
  assert.ok(r2.alreadyDone); assert.strictEqual(r2.sheets.length, 0); assert.strictEqual(r2.users.length, 0);
  assert.strictEqual(S.ss.getSheetByName('Purchases').getLastRow(), before, 'no duplicate demo data');
});

console.log('\n3-4. accountant login + authorization');
let acc, mgr;
test('login accountant/1234', () => { acc = ok(G.api_login('accountant', '1234')); assert.strictEqual(acc.user.role, 'accountant'); assert.ok(acc.demoPasswordsActive); });
test('wrong password fails + audited', () => { const r = G.api_login('manager', 'wrong'); assert.ok(!r.ok); assert.ok(S.ss.getSheetByName('Audit_Log').data.some(r => r[3] === 'LOGIN' && r[7] === 'FAILED')); });
test('accountant cannot reach manager APIs', () => {
  for (const [fn, args] of [['api_getDashboard', [{}]], ['api_getSettings', []], ['api_getAuditLog', [50]], ['api_cancelRecord', ['expenses', 'x', 'r']], ['api_changePassword', ['manager', 'abcdef']], ['api_generateReportPdf', ['daily']], ['api_sendTestReport', []], ['api_rebuildTrigger', []], ['api_listSales', [{}]]]) {
    const r = G[fn].apply(null, [acc.token].concat(args)); assert.ok(r.ok === false && r.code === 'FORBIDDEN', fn + ' should be forbidden: ' + JSON.stringify(r));
  }
});
test('bootstrap for accountant has no settings', () => { const b = ok(G.api_bootstrap(acc.token)); assert.ok(!b.settings); assert.ok(b.lists.purchaseCategories.length === 9); });
test('bad/expired token rejected', () => { const r = G.api_bootstrap('nope'); assert.ok(!r.ok && r.code === 'AUTH'); });

console.log('\n5-9. CSV preview, import, duplicate prevention');
let preview;
test('preview (UTF-8 BOM, quoted fields) computes summary', () => {
  preview = ok(G.api_previewSalesCsv(acc.token, csvBom, 'sales.csv')).preview;
  assert.strictEqual(preview.totalRows, 20);
  assert.strictEqual(preview.rejectedRows, 1, 'cancelled row rejected');
  assert.strictEqual(preview.duplicatesInFile, 1, 'duplicate line inside file');
  assert.strictEqual(preview.acceptedRows, 18);
  assert.strictEqual(preview.dateFrom, '2026-09-13'); assert.strictEqual(preview.dateTo, '2026-09-15');
  assert.strictEqual(preview.receipts, 15);
  // expected sums over accepted rows (18) incl. refund negative
  assert.strictEqual(preview.netSales, 31.8); assert.strictEqual(preview.costOfGoods, 11.4); assert.strictEqual(preview.grossProfit, 20.4);
  assert.strictEqual(preview.grossSales, 32.9); assert.strictEqual(preview.discounts, 1.1); assert.strictEqual(preview.quantity, 35);
  assert.strictEqual(preview.refunds, 1);
});
test('missing required column blocks preview', () => {
  const bad = csv.replace('Net sales', 'Net amount'); const r = G.api_previewSalesCsv(acc.token, bad, 'bad.csv');
  assert.ok(!r.ok && /Net sales/.test(r.error), r.error);
});
test('column order independence', () => {
  const lines = csv.trim().split('\n'); const cols = lines[0].split(',');
  const perm = cols.map((_, i) => cols.length - 1 - i);
  const shuffled = lines.map(l => { const cells = G.parseCsv_(l)[0]; return perm.map(i => '"' + String(cells[i]).replace(/"/g, '""') + '"').join(','); }).join('\n');
  const p = ok(G.api_previewSalesCsv(acc.token, shuffled, 'shuffled.csv')).preview;
  assert.strictEqual(p.netSales, preview.netSales); assert.strictEqual(p.acceptedRows, 18);
});
let imp;
test('import writes rows + import log', () => {
  imp = ok(G.api_importSalesCsv(acc.token, csvBom, 'sales.csv'));
  assert.strictEqual(imp.imported, 18); assert.strictEqual(imp.duplicates, 1); assert.strictEqual(imp.rejected, 1);
  assert.strictEqual(S.ss.getSheetByName('Sales_Raw').getLastRow(), 19);
  const log = S.ss.getSheetByName('Sales_Imports').data[1]; assert.strictEqual(log[7], 18); assert.strictEqual(log[13], 'OK');
  const raw = S.ss.getSheetByName('Sales_Raw'); const hdr = raw.data[0]; const first = raw.data[1];
  assert.ok(first[hdr.indexOf('Date')] instanceof Date, 'Date stored as Date');
  assert.strictEqual(first[hdr.indexOf('Imported By')], 'accountant');
  assert.ok(String(first[hdr.indexOf('Unique Key')]).indexOf('Walif Main|1-1001|') === 0);
});
test('re-importing the same file imports 0 and reports 19 duplicates', () => {
  const r2 = ok(G.api_importSalesCsv(acc.token, csv, 'sales-again.csv'));
  assert.strictEqual(r2.imported, 0); assert.strictEqual(r2.duplicates, 19); assert.strictEqual(S.ss.getSheetByName('Sales_Raw').getLastRow(), 19);
});
test('formula injection neutralised', () => {
  const evil = csv.trim().split('\n').slice(0, 2).join('\n').replace('Ahmed', '=HYPERLINK("x")').replace('1-1001', '9-9999');
  const r = ok(G.api_importSalesCsv(acc.token, evil, 'evil.csv')); assert.strictEqual(r.imported, 1);
  const raw = S.ss.getSheetByName('Sales_Raw'); const hdr = raw.data[0]; const row = raw.data[raw.data.length - 1];
  assert.strictEqual(row[hdr.indexOf('Cashier name')], '=HYPERLINK("x")'); // stored as text (apostrophe stripped by Sheets)
});
test('date formats: DD/MM/YYYY and 12h', () => {
  assert.strictEqual(G.fmtDateTime_(G.parseLoyverseDate_('15/09/2026 14:05')), '2026-09-15 14:05:00');
  assert.strictEqual(G.fmtDateTime_(G.parseLoyverseDate_('9/15/26 2:05 PM')), '2026-09-15 14:05:00');
  assert.strictEqual(G.fmtDateTime_(G.parseLoyverseDate_('2026-09-15T00:30')), '2026-09-15 00:30:00');
  assert.strictEqual(G.parseLoyverseDate_('garbage'), null);
});

console.log('\n10-13. entries with attachment');
const png = { name: 'invoice.png', mimeType: 'image/png', base64: Buffer.from('fake png').toString('base64') };
let purchaseId, expenseId, payrollId, rentId;
test('add purchase with attachment (inventory, paid)', () => {
  const r = ok(G.api_addPurchase(acc.token, { invoiceNumber: 'INV-77', invoiceDate: '2026-09-14', supplier: 'شركة البن', category: 'بن', description: 'بن عربي', subtotal: 40, tax: 2, discount: 0, paidAmount: 42, paymentMethod: 'نقد', paymentStatus: 'مدفوعة', isInventory: true, notes: 'test' }, png));
  purchaseId = r.id; assert.strictEqual(r.total, 42); assert.strictEqual(r.remaining, 0); assert.ok(/drive\.google\.com/.test(r.attachmentUrl));
  const f = S.findFolder('Walif Coffee Accounting/Invoices/2026/09'); assert.ok(f && f.files.length === 1, 'file stored under Invoices/2026/09');
});
test('duplicate purchase rejected', () => {
  const r = G.api_addPurchase(acc.token, { invoiceNumber: 'INV-77', invoiceDate: '2026-09-14', supplier: 'شركة البن', category: 'بن', subtotal: 40, tax: 2, discount: 0, paidAmount: 42, paymentMethod: 'نقد', isInventory: true });
  assert.ok(!r.ok && /مسجلة مسبقًا/.test(r.error), r.error);
});
test('purchase validation: bad attachment type / status mismatch', () => {
  let r = G.api_addPurchase(acc.token, { invoiceNumber: 'X1', invoiceDate: '2026-09-14', supplier: 'S', category: 'بن', subtotal: 10, paidAmount: 10, paymentMethod: 'نقد', isInventory: true }, { name: 'a.exe', mimeType: 'application/x-msdownload', base64: 'AAAA' });
  assert.ok(!r.ok && /غير مسموح/.test(r.error));
  r = G.api_addPurchase(acc.token, { invoiceNumber: 'X2', invoiceDate: '2026-09-14', supplier: 'S', category: 'بن', subtotal: 10, paidAmount: 0, paymentStatus: 'مدفوعة', paymentMethod: 'نقد', isInventory: true });
  assert.ok(!r.ok && /لا تطابق/.test(r.error));
  r = G.api_addPurchase(acc.token, { invoiceNumber: 'X3', invoiceDate: '2026-09-14', supplier: 'S', category: 'غير موجود', subtotal: 10, paidAmount: 0, paymentMethod: 'نقد' });
  assert.ok(!r.ok);
});
test('unpaid non-inventory purchase (partial)', () => {
  const r = ok(G.api_addPurchase(acc.token, { invoiceNumber: 'INV-78', invoiceDate: '2026-09-15', supplier: 'معدات الخليج', category: 'معدات', subtotal: 100, tax: 5, discount: 5, paidAmount: 30, paymentMethod: 'آجل', isInventory: false }));
  assert.strictEqual(r.total, 100); assert.strictEqual(r.remaining, 70);
});
test('add expense', () => { expenseId = ok(G.api_addExpense(acc.token, { expenseDate: '2026-09-14', expenseType: 'كهرباء', description: 'فاتورة كهرباء', amount: 12.5, paymentMethod: 'بطاقة', payee: 'نماء', paymentStatus: 'مدفوع' }, null)).id; });
test('add unpaid expense', () => { ok(G.api_addExpense(acc.token, { expenseDate: '2026-09-15', expenseType: 'إنترنت', description: 'اشتراك', amount: 7, paymentMethod: 'آجل', paymentStatus: 'غير مدفوع' })); });
test('expense validation', () => { const r = G.api_addExpense(acc.token, { expenseDate: '2026-09-14', expenseType: 'كهرباء', description: '', amount: 0, paymentMethod: 'نقد', paymentStatus: 'مدفوع' }); assert.ok(!r.ok); });
test('add payroll (net computed server-side)', () => {
  const r = ok(G.api_addPayroll(acc.token, { employee: 'سالم', month: '2026-09', basicSalary: 300, allowance: 50, overtime: 20, deduction: 10, advance: 40, paymentDate: '2026-09-15', paymentMethod: 'تحويل بنكي', paymentStatus: 'مدفوع' }));
  payrollId = r.id; assert.strictEqual(r.netSalary, 320);
  const d = G.api_addPayroll(acc.token, { employee: 'سالم', month: '2026-09', basicSalary: 300, paymentStatus: 'غير مدفوع' }); assert.ok(!d.ok, 'duplicate month');
});
test('add rent', () => { rentId = ok(G.api_addRent(acc.token, { period: '2026-09', landlord: 'المالك', amount: 200, dueDate: '2026-09-01', paymentDate: '2026-09-13', paymentMethod: 'تحويل بنكي', status: 'مدفوع' }, null)).id; });
test('accountant lists only own records, cannot cancel', () => {
  const r = ok(G.api_listPurchases(acc.token, {})); assert.strictEqual(r.rows.length, 2); assert.ok(r.rows.every(x => x['Created By'] === 'accountant'));
  assert.ok(r.rows[0]['Dedupe Key'] === undefined);
  const c = G.api_cancelRecord(acc.token, 'purchases', purchaseId, 'x'); assert.ok(!c.ok && c.code === 'FORBIDDEN');
});

console.log('\n14-18. manager dashboard + financial rules');
let dash;
test('login manager/2026', () => { mgr = ok(G.api_login('manager', '2026')); assert.strictEqual(mgr.user.role, 'manager'); });
test('dashboard numbers for 2026-09-13..15', () => {
  dash = ok(G.api_getDashboard(mgr.token, { preset: 'custom', from: '2026-09-13', to: '2026-09-15' }));
  const k = dash.kpis;
  assert.strictEqual(k.netSales, 33); // 31.8 sample + 1.2 evil row
  assert.strictEqual(k.cogs, 11.8);
  assert.strictEqual(k.grossProfit, G.round3_(k.netSales - k.cogs));
  assert.strictEqual(k.grossProfitDiff, 0, 'matches Loyverse gross profit');
  assert.strictEqual(k.receipts, 16); assert.strictEqual(k.avgReceipt, G.round3_(k.netSales / 16));
  // costs: demo rows are dated today (2026-09-15) and included; demo purchase 52.5 paid, demo expense 15, demo payroll 220, demo rent 150
  assert.strictEqual(k.inventoryPurchases, 42 + 52.5); assert.strictEqual(k.nonInventoryPurchases, 100);
  assert.strictEqual(k.purchasesPaid, 42 + 30 + 52.5);
  assert.strictEqual(k.expenses, 12.5 + 7 + 15); assert.strictEqual(k.expensesPaid, 12.5 + 15);
  assert.strictEqual(k.payroll, 320 + 220); assert.strictEqual(k.payrollPaid, 540);
  assert.strictEqual(k.rent, 350); assert.strictEqual(k.rentPaid, 350);
  assert.strictEqual(k.operatingExpenses, G.round3_(34.5 + 540 + 350));
  // P&L must NOT deduct purchases:
  assert.strictEqual(k.operatingProfit, G.round3_(k.grossProfit - k.operatingExpenses));
  // cash must deduct paid purchases:
  assert.strictEqual(k.netCash, G.round3_(k.netSales - k.purchasesPaid - k.expensesPaid - k.payrollPaid - k.rentPaid));
  assert.ok(k.netCash < k.operatingProfit, 'cash lower than profit because inventory was bought');
  assert.ok(/Cost of goods/.test(dash.note));
});
test('breakdowns present', () => {
  assert.strictEqual(dash.sales.daily.length, 3);
  assert.strictEqual(dash.sales.topItems[0].item, 'Iced Latte');
  assert.ok(dash.sales.hourly.length === 24 && dash.sales.hourly[8].net > 0);
  assert.ok(dash.sales.byCashier.length === 3 /* Ahmed, Salim, evil */); assert.ok(dash.sales.byPos.length === 2);
  assert.ok(dash.costs.purchasesBySupplier.length === 3); assert.ok(dash.costs.expensesByType.length === 2);
  assert.strictEqual(dash.costs.payrollByMonth[0].amount, 540); assert.strictEqual(dash.costs.rentList.length, 2);
  assert.strictEqual(dash.comparison.monthly.length, 1); assert.ok(dash.comparison.daily.length >= 3);
  assert.ok(dash.options.items.includes('Espresso'));
});
test('filters: cashier + preset today', () => {
  const r = ok(G.api_getDashboard(mgr.token, { preset: 'custom', from: '2026-09-13', to: '2026-09-15', cashier: 'Salim' }));
  assert.strictEqual(r.kpis.netSales, G.round3_(4.5 + 2 + 2.2 + 3 + 1.5 + 3 + 0.9 + 2.5));
  const t = ok(G.api_getDashboard(mgr.token, { preset: 'today' })); assert.strictEqual(t.range.from, t.range.to);
});
test('cancelled record leaves the numbers', () => {
  ok(G.api_cancelRecord(mgr.token, 'expenses', expenseId, 'خطأ في الإدخال'));
  const r = ok(G.api_getDashboard(mgr.token, { preset: 'custom', from: '2026-09-13', to: '2026-09-15' }));
  assert.strictEqual(r.kpis.expenses, 7 + 15);
  const again = G.api_cancelRecord(mgr.token, 'expenses', expenseId, 'x'); assert.ok(!again.ok);
  const list = ok(G.api_listExpenses(mgr.token, { status: 'CANCELLED' })); assert.strictEqual(list.rows.length, 1); assert.strictEqual(list.rows[0]['Cancel Reason'], 'خطأ في الإدخال');
});
test('update record with reason re-validates', () => {
  ok(G.api_updateRecord(mgr.token, 'payroll', payrollId, { Deduction: 0 }, 'تصحيح الخصم'));
  const rows = ok(G.api_listPayroll(mgr.token, {})).rows; const row = rows.find(r => r['Internal ID'] === payrollId);
  assert.strictEqual(row['Net Salary'], 330); assert.ok(/تصحيح الخصم/.test(row.Notes));
  const bad = G.api_updateRecord(mgr.token, 'payroll', payrollId, { 'Net Salary': 1 }, 'x'); assert.ok(!bad.ok);
  const nor = G.api_updateRecord(mgr.token, 'payroll', payrollId, { Deduction: 5 }, ''); assert.ok(!nor.ok);
});
test('manager sales list + cancel a sales row', () => {
  const r = ok(G.api_listSales(mgr.token, { from: '2026-09-13', to: '2026-09-15' })); assert.strictEqual(r.total, 19);
  const evil = r.rows.find(x => x.receipt === '9-9999'); ok(G.api_cancelRecord(mgr.token, 'sales', evil.id, 'سجل اختبار'));
  const d = ok(G.api_getDashboard(mgr.token, { preset: 'custom', from: '2026-09-13', to: '2026-09-15' })); assert.strictEqual(d.kpis.netSales, 31.8);
});

console.log('\n19-20. PDF report + e-mail');
test('report data for every type', () => {
  for (const t of ['daily', 'weekly', 'monthly', 'custom', 'purchases', 'expenses', 'payroll', 'rent', 'pnl', 'cashflow']) {
    const r = ok(G.api_getReportData(mgr.token, t, '2026-09-14', '2026-09-15'), t); assert.ok(r.report.title);
  }
  const d = ok(G.api_getReportData(mgr.token, 'daily', '2026-09-14')).report; assert.strictEqual(d.range.from, '2026-09-14');
  assert.ok(d.kpis.find(k => k[0] === 'صافي المبيعات')[1] === 11.3);
  assert.ok(d.sections.find(s => s.title === 'أفضل 5 أصناف').rows.length === 5);
});
test('PDF generated, named, stored in Reports/YYYY/MM, temp doc trashed', () => {
  const r = ok(G.api_generateReportPdf(mgr.token, 'daily', '2026-09-15'));
  assert.strictEqual(r.name, 'Walif-Coffee-Daily-Report-2026-09-15.pdf'); assert.ok(r.base64.length > 10);
  const f = S.findFolder('Walif Coffee Accounting/Reports/2026/09'); assert.ok(f.files.some(x => x.name === r.name && !x.trashed));
  assert.ok(Object.values(S.DRIVE.docs).every(d => S.DRIVE.files[d.id].trashed), 'temp docs trashed');
  const r2 = ok(G.api_generateReportPdf(mgr.token, 'daily', '2026-09-15')); assert.strictEqual(f.files.filter(x => x.name === r2.name && !x.trashed).length, 1, 'no duplicate pdf');
  assert.ok(S.ss.getSheetByName('Audit_Log').data.some(x => x[3] === 'DOWNLOAD_REPORT'));
});
test('test e-mail requires recipient; settings save creates trigger', () => {
  let r = G.api_sendTestReport(mgr.token); assert.ok(!r.ok && /بريد/.test(r.error));
  r = G.api_saveSettings(mgr.token, { reportEmail: 'bad', reportHour: 8 }); assert.ok(!r.ok);
  r = G.api_saveSettings(mgr.token, { reportEmail: '', reportHour: 8, reportEnabled: true }); assert.ok(!r.ok);
  r = ok(G.api_saveSettings(mgr.token, { reportEmail: 'owner@example.com', reportHour: 7, reportEnabled: true, reportMode: 'previous_day' }));
  assert.ok(r.settings.trigger.exists); assert.strictEqual(S.STATE.triggers[0].hour, 7); assert.strictEqual(S.STATE.triggers[0].tz, 'Asia/Muscat');
  ok(G.api_rebuildTrigger(mgr.token)); assert.strictEqual(S.STATE.triggers.length, 1, 'old trigger removed');
  r = ok(G.api_sendTestReport(mgr.token, '2026-09-14')); assert.strictEqual(r.sentTo, 'owner@example.com');
  const m = S.STATE.mails[0]; assert.ok(/التقرير اليومي 2026-09-14/.test(m.subject)); assert.ok(m.attachments[0].name.endsWith('.pdf')); assert.ok(/11\.300/.test(m.htmlBody));
});
test('trigger job runs (previous day) and logs; failure goes to Error_Log without throwing', () => {
  G.sendDailyReportJob(); assert.strictEqual(S.STATE.mails.length, 2);
  const origSend = G.MailApp.sendEmail; G.MailApp.sendEmail = () => { throw new Error('smtp down'); };
  G.sendDailyReportJob(); G.MailApp.sendEmail = origSend;
  const errs = S.ss.getSheetByName('Error_Log'); assert.ok(errs.data.some(r => /smtp down/.test(String(r[3]))));
  assert.ok(S.ss.getSheetByName('Audit_Log').data.some(r => r[3] === 'SEND_EMAIL' && r[7] === 'FAILED'));
  const e = ok(G.api_getErrorLog(mgr.token, 10)); assert.ok(e.rows.length >= 1);
});

console.log('\nsecurity: passwords, sessions, logs');
test('change password, demo warning clears only when both changed', () => {
  let r = G.api_changePassword(mgr.token, 'accountant', '1234'); assert.ok(!r.ok);
  r = ok(G.api_changePassword(mgr.token, 'accountant', 'newpass1')); assert.ok(r.demoPasswordsActive === true);
  assert.ok(!G.api_login('accountant', '1234').ok); assert.ok(G.api_login('accountant', 'newpass1').ok);
  r = ok(G.api_changePassword(mgr.token, 'manager', 'managerpass')); assert.ok(r.demoPasswordsActive === false);
  assert.ok(G.resetDemoPasswords()); assert.ok(G.api_login('manager', '2026').ok);
});
test('logout kills the session', () => { ok(G.api_logout(acc.token)); assert.ok(!G.api_bootstrap(acc.token).ok); });
test('session expiry honoured', () => {
  const s = ok(G.api_login('manager', '2026')); const key = G.sessionKey_(s.token);
  const d = JSON.parse(S.STATE.props[key]); d.exp = Date.now() - 1; S.STATE.props[key] = JSON.stringify(d); S.STATE.cache[key] = JSON.stringify(d);
  assert.ok(!G.api_bootstrap(s.token).ok);
});
test('audit/error logs never contain tokens or passwords', () => {
  const all = S.ss.getSheetByName('Audit_Log').data.concat(S.ss.getSheetByName('Error_Log').data).flat().join(' ');
  assert.ok(!all.includes(mgr.token) && !all.includes(acc.token) && !/newpass1|managerpass/.test(all));
  const acts = new Set(S.ss.getSheetByName('Audit_Log').data.map(r => r[3]));
  for (const a of ['LOGIN', 'LOGOUT', 'UPLOAD_FILE', 'IMPORT_SALES', 'ADD_PURCHASE', 'ADD_EXPENSE', 'ADD_PAYROLL', 'ADD_RENT', 'UPDATE_RECORD', 'CANCEL_RECORD', 'DOWNLOAD_REPORT', 'SEND_EMAIL', 'CHANGE_SETTINGS', 'CREATE_TRIGGER', 'CHANGE_PASSWORD', 'FORBIDDEN']) assert.ok(acts.has(a), 'audit missing ' + a);
});
test('manager audit/users APIs', () => { assert.ok(ok(G.api_getAuditLog(mgr.token, 50)).rows.length > 10); assert.strictEqual(ok(G.api_listUsers(mgr.token)).users.length, 2); });

console.log('\n23. remove demo data (keeps real CSV data)');
test('removeDemoData deletes only demo rows', () => {
  const n = G.removeDemoData(); assert.strictEqual(n, 4);
  assert.strictEqual(S.ss.getSheetByName('Sales_Raw').getLastRow(), 20);
  const d = ok(G.api_getDashboard(mgr.token, { preset: 'custom', from: '2026-09-13', to: '2026-09-15' }));
  assert.strictEqual(d.kpis.inventoryPurchases, 42); assert.strictEqual(d.kpis.rent, 200); assert.strictEqual(d.kpis.payroll, 330);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (S.STATE.logs.length) console.log('(Logger output lines: ' + S.STATE.logs.length + ')');
process.exit(failed ? 1 : 0);
