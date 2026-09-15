#!/usr/bin/env node
/**
 * Browser test of the real UI against the simulator (via dev-server). Fails on any JS error.
 *   node tools/ui-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const { chromium } = require(require.resolve('playwright', { paths: ['/opt/node22/lib/node_modules'] }));
const PORT = 8790, BASE = 'http://localhost:' + PORT;
const OUT = path.join(__dirname, '..', 'tests', 'screenshots'); fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'dev-server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('preview on')) r(); }));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const errors = [];
  let failed = 0;
  const step = async (name, fn) => { try { await fn(); console.log('  ✔', name); } catch (e) { failed++; console.log('  ✘', name, '\n      ', e.message.split('\n')[0]); } };
  const newPage = async (viewport) => {
    const ctx = await browser.newContext({ viewport, locale: 'ar' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/gstatic|charts|net::ERR|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    // block Google Charts network (offline sandbox) so the page uses its fallback text
    await page.route(/gstatic\.com|fonts\.googleapis\.com/, r => r.abort());
    return page;
  };
  const toastText = async (page) => (await page.locator('.toast').allTextContents()).join(' | ');

  console.log('\nAccountant flow (mobile 390px)');
  let page = await newPage({ width: 390, height: 844 });
  await step('login page renders', async () => { await page.goto(BASE); await page.waitForSelector('#loginForm', { state: 'visible' }); await page.screenshot({ path: OUT + '/01-login-mobile.png' }); });
  await step('wrong password shows error', async () => { await page.fill('#loginUser', 'ac'); await page.fill('#loginPass', 'x'); await page.click('#loginBtn'); await page.waitForSelector('#loginError:not(.hidden)'); });
  await step('ac/1234 logs in, sees accountant view only', async () => {
    await page.fill('#loginPass', '1234'); await page.click('#loginBtn');
    await page.waitForSelector('#view-accountant:not(.hidden)');
    if (!(await page.locator('#view-manager').evaluate(e => e.classList.contains('hidden')))) throw new Error('manager view visible to accountant');
    if (await page.locator('#accTabs button').count() !== 6) throw new Error('tabs');
    await page.screenshot({ path: OUT + '/02-accountant-mobile.png', fullPage: true });
  });
  await step('CSV preview + import', async () => {
    await page.setInputFiles('#csvFile', path.join(__dirname, '..', 'tests', 'sample-loyverse.csv'));
    await page.click('#btnPreviewCsv'); await page.waitForSelector('#csvPreview:not(.hidden)');
    const grid = await page.locator('#csvPreviewGrid').innerText();
    if (!grid.includes('31.800')) throw new Error('preview net sales missing: ' + grid);
    await page.screenshot({ path: OUT + '/03-csv-preview.png', fullPage: true });
    await page.click('#btnImportCsv'); await page.click('#mOk');
    await page.waitForSelector('#csvResult:not(.hidden)');
    const res = await page.locator('#csvResult').innerText();
    if (!/18/.test(res) || !/31\.800/.test(res)) throw new Error('import result: ' + res);
  });
  await step('re-import shows duplicates only', async () => {
    await page.setInputFiles('#csvFile', path.join(__dirname, '..', 'tests', 'sample-loyverse.csv'));
    await page.click('#btnPreviewCsv'); await page.waitForSelector('#csvPreview:not(.hidden)');
    if (!(await page.locator('#btnImportCsv').isDisabled())) throw new Error('import should be disabled when 0 accepted');
    const grid = await page.locator('#csvPreviewGrid').innerText(); if (!/1 \/ 18/.test(grid)) throw new Error(grid);
    await page.click('#btnCancelCsv');
  });
  await step('add purchase with attachment', async () => {
    await page.click('#accTabs button[data-tab=acc-purchase]');
    const f = page.locator('#purchaseForm');
    await f.locator('[name=invoiceNumber]').fill('UI-1'); await f.locator('[name=invoiceDate]').fill('2026-09-15'); await f.locator('[name=supplier]').fill('مورد UI');
    await f.locator('[name=subtotal]').fill('10'); await f.locator('[name=tax]').fill('0.5'); await f.locator('[name=paidAmount]').fill('10.5');
    if ((await page.locator('#purTotal').innerText()) !== '10.500') throw new Error('total calc');
    await f.locator('[name=attachment]').setInputFiles({ name: 'inv.png', mimeType: 'image/png', buffer: Buffer.from('png') });
    await f.locator('button[type=submit]').click(); await page.waitForSelector('.toast.ok');
    if (!/تم حفظ الفاتورة/.test(await toastText(page))) throw new Error(await toastText(page));
  });
  await step('validation error surfaces (bad attachment type)', async () => {
    const f = page.locator('#purchaseForm');
    await f.locator('[name=invoiceNumber]').fill('UI-2'); await f.locator('[name=supplier]').fill('x'); await f.locator('[name=subtotal]').fill('1'); await f.locator('[name=paidAmount]').fill('1');
    await f.locator('[name=attachment]').setInputFiles({ name: 'a.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await f.locator('button[type=submit]').click(); await page.waitForSelector('.toast.err');
  });
  await step('add expense / payroll / rent', async () => {
    await page.click('#accTabs button[data-tab=acc-expense]');
    let f = page.locator('#expenseForm'); await f.locator('[name=amount]').fill('3.250'); await f.locator('[name=description]').fill('ماء'); await f.locator('button[type=submit]').click(); await page.waitForSelector('.toast.ok');
    await page.click('#accTabs button[data-tab=acc-payroll]');
    f = page.locator('#payrollForm'); await f.locator('[name=employee]').fill('علي'); await f.locator('[name=basicSalary]').fill('250'); await f.locator('[name=advance]').fill('50');
    if ((await page.locator('#payNet').innerText()) !== '200.000') throw new Error('net calc');
    await f.locator('[name=paymentDate]').fill('2026-09-15'); await f.locator('button[type=submit]').click(); await page.waitForSelector('.toast.ok');
    await page.click('#accTabs button[data-tab=acc-rent]');
    f = page.locator('#rentForm'); await f.locator('[name=landlord]').fill('المالك'); await f.locator('[name=amount]').fill('150'); await f.locator('[name=dueDate]').fill('2026-09-01'); await f.locator('[name=paymentDate]').fill('2026-09-02'); await f.locator('button[type=submit]').click(); await page.waitForSelector('.toast.ok');
  });
  await step('my records list', async () => {
    await page.click('#accTabs button[data-tab=acc-records]'); await page.waitForSelector('#recordsTableWrap table');
    const t = await page.locator('#recordsTableWrap').innerText(); if (!t.includes('UI-1') || !t.includes('📎')) throw new Error(t);
    await page.screenshot({ path: OUT + '/04-records-mobile.png', fullPage: true });
  });
  await step('logout returns to login', async () => { await page.click('#btnLogout'); await page.waitForSelector('#loginForm', { state: 'visible' }); });

  console.log('\nManager flow (desktop 1280px)');
  page = await newPage({ width: 1280, height: 900 });
  await step('admin/2026 logs in, dashboard renders KPIs + demo warning', async () => {
    await page.goto(BASE); await page.fill('#loginUser', 'admin'); await page.fill('#loginPass', '2026'); await page.click('#loginBtn');
    await page.waitForSelector('#view-manager:not(.hidden)'); await page.waitForSelector('#kpis .kpi');
    if (await page.locator('#kpis .kpi').count() !== 14) throw new Error('14 KPI cards expected');
    if (await page.locator('#demoWarning').evaluate(e => e.classList.contains('hidden'))) throw new Error('demo warning missing');
    const note = await page.locator('#dashNote').innerText(); if (!note.includes('Cost of goods')) throw new Error('note');
    await page.screenshot({ path: OUT + '/05-dashboard-desktop.png', fullPage: true });
  });
  await step('filters + tables populate', async () => {
    await page.click('#presetChips .chip[data-preset=last7]'); await page.waitForTimeout(300);
    const t = await page.locator('#tTop').innerText(); if (!t.includes('Iced Latte')) throw new Error('top items: ' + t);
    await page.selectOption('#fCashier', 'Salim'); await page.click('#btnApplyFilters'); await page.waitForTimeout(300);
    if (!(await page.locator('#tCashier').innerText()).includes('Salim')) throw new Error('cashier filter');
    await page.selectOption('#fCashier', ''); await page.click('#btnApplyFilters'); await page.waitForTimeout(300);
  });
  await step('sales list + cancel with reason', async () => {
    await page.click('#mgrTabs button[data-tab=mgr-sales]'); await page.fill('#sFrom', '2026-09-13'); await page.fill('#sTo', '2026-09-15'); await page.click('#btnLoadSales');
    await page.waitForSelector('#salesTableWrap table'); const before = await page.locator('#salesCount').innerText();
    await page.locator('#salesTableWrap [data-cancel]').first().click(); await page.fill('#mIn', 'اختبار'); await page.click('#mOk'); await page.waitForSelector('.toast.ok');
    await page.waitForTimeout(300); const after = await page.locator('#salesCount').innerText(); if (before === after) throw new Error('count unchanged ' + before);
  });
  await step('records: edit with reason + cancel', async () => {
    await page.click('#mgrTabs button[data-tab=mgr-records]'); await page.selectOption('#mrEntity', 'payroll'); await page.click('#btnMgrRecords'); await page.waitForSelector('#mgrRecordsWrap table');
    await page.locator('#mgrRecordsWrap [data-edit]').first().click(); await page.waitForSelector('#mForm');
    await page.fill('#mForm [name=Allowance]', '25'); await page.fill('#mForm [name=__reason]', 'بدل جديد'); await page.click('#mForm button[type=submit]'); await page.waitForSelector('.toast.ok');
    await page.waitForTimeout(300); if (!(await page.locator('#mgrRecordsWrap').innerText()).includes('225.000')) throw new Error('net not updated');
    await page.locator('#mgrRecordsWrap [data-cancel]').first().click(); await page.fill('#mIn', 'إلغاء تجريبي'); await page.click('#mOk'); await page.waitForSelector('.toast.ok');
  });
  await step('reports: view + PDF download', async () => {
    await page.click('#mgrTabs button[data-tab=mgr-reports]'); await page.selectOption('#rType', 'pnl'); await page.fill('#rFrom', '2026-09-13'); await page.fill('#rTo', '2026-09-15');
    await page.click('#btnReportView'); await page.waitForSelector('#reportOut .card'); if (!(await page.locator('#reportOut').innerText()).includes('صافي الربح التشغيلي')) throw new Error('report view');
    const dl = page.waitForEvent('download'); await page.click('#btnReportPdf'); const d = await dl; if (!/Walif-Coffee-PnL-Report/.test(d.suggestedFilename())) throw new Error(d.suggestedFilename());
    await page.screenshot({ path: OUT + '/06-report.png', fullPage: true });
  });
  await step('settings: save e-mail + trigger, test send, change password', async () => {
    await page.click('#mgrTabs button[data-tab=mgr-settings]'); await page.waitForSelector('#usersWrap table');
    await page.fill('#settingsForm [name=reportEmail]', 'owner@example.com'); await page.selectOption('#reportHour', '8'); await page.check('#settingsForm [name=reportEnabled]');
    await page.click('#settingsForm button[type=submit]'); await page.waitForSelector('.toast.ok'); await page.waitForTimeout(200);
    if (!(await page.locator('#triggerState').innerText()).includes('✅')) throw new Error('trigger state');
    await page.click('#btnTestEmail'); await page.click('#mOk'); await page.waitForSelector('.toast.ok', { timeout: 5000 });
    const st = await (await fetch(BASE + '/__state')).json(); if (st.mails < 1 || st.triggers !== 1) throw new Error(JSON.stringify(st));
    await page.selectOption('#pwUser', 'ac'); await page.fill('#passwordForm [name=newPassword]', 'secret99'); await page.fill('#passwordForm [name=confirm]', 'secret99'); await page.click('#passwordForm button[type=submit]'); await page.waitForSelector('.toast.ok');
    await page.screenshot({ path: OUT + '/07-settings.png', fullPage: true });
  });
  await step('audit log shows actions', async () => {
    await page.click('#mgrTabs button[data-tab=mgr-audit]'); await page.waitForSelector('#auditWrap table');
    const t = await page.locator('#auditWrap').innerText(); for (const a of ['IMPORT_SALES', 'ADD_PURCHASE', 'CANCEL_RECORD', 'SEND_EMAIL', 'CHANGE_PASSWORD']) if (!t.includes(a)) throw new Error('missing ' + a);
  });
  await step('mobile dashboard renders without horizontal overflow', async () => {
    const m = await newPage({ width: 390, height: 844 }); await m.goto(BASE); await m.fill('#loginUser', 'admin'); await m.fill('#loginPass', '2026'); await m.click('#loginBtn');
    await m.waitForSelector('#kpis .kpi'); const sw = await m.evaluate(() => document.documentElement.scrollWidth); if (sw > 400) { const wide = await m.evaluate(() => Array.from(document.querySelectorAll('body *')).filter(e => e.getBoundingClientRect().right > 395).slice(0, 8).map(e => e.tagName + '#' + e.id + '.' + e.className)); throw new Error('page overflows: ' + sw + ' ' + JSON.stringify(wide)); }
    await m.screenshot({ path: OUT + '/08-dashboard-mobile.png', fullPage: true });
  });

  await browser.close(); srv.kill();
  if (errors.length) { failed++; console.log('\nJS errors:\n  ' + errors.join('\n  ')); }
  console.log('\n' + (failed ? failed + ' UI step(s) failed' : 'UI: all steps passed, no JS errors'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
