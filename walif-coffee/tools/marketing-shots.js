#!/usr/bin/env node
/** Produces marketing screenshots with real-looking data (uses the simulator via dev-server). */
'use strict';
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const { chromium } = require(require.resolve('playwright', { paths: ['/opt/node22/lib/node_modules'] }));
const PORT = 8791, BASE = 'http://localhost:' + PORT;
const OUT = process.argv[2] || path.join(__dirname, '..', 'docs'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'dev-server.js'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (String(d).includes('preview on')) r(); }));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const mk = async (viewport, scale) => { const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale || 2, locale: 'ar' }); const page = await ctx.newPage(); await page.route(/gstatic\.com|fonts\.googleapis\.com/, r => r.abort()); return page; };
  const login = async (page, u, p) => { await page.goto(BASE); await page.fill('#loginUser', u); await page.fill('#loginPass', p); await page.click('#loginBtn'); await page.waitForSelector('#view-app:not(.hidden)'); };

  // accountant: import sample + a purchase/expense so the dashboard has numbers
  let page = await mk({ width: 390, height: 844 });
  await login(page, 'ac', '1234');
  // synthetic month of sales (deterministic) so the dashboard shows realistic figures
  const items = [['Hot Drinks', 'Espresso', 0.8, 0.25], ['Hot Drinks', 'Cappuccino', 1.2, 0.4], ['Hot Drinks', 'Flat White', 1.4, 0.45], ['Hot Drinks', 'Karak Tea', 0.5, 0.15], ['Cold Drinks', 'Iced Latte', 1.5, 0.5], ['Cold Drinks', 'Mojito', 1.5, 0.5], ['Bakery', 'Croissant', 0.8, 0.35], ['Bakery', 'Cheesecake', 1.2, 0.5], ['Bakery', 'Brownie', 0.9, 0.4]];
  let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const lines = ['Date,Receipt number,Receipt type,Category,SKU,Item,Variant,Modifiers applied,Quantity,Gross sales,Discounts,Net sales,Cost of goods,Gross profit,Taxes,POS,Store,Cashier name,Customer name,Customer contacts,Comment,Status'];
  let rc = 2000;
  for (let d = 1; d <= 30; d++) { const n = 18 + Math.floor(rnd() * 14); for (let r = 0; r < n; r++) { rc++; const hour = 7 + Math.floor(rnd() * 15), min = Math.floor(rnd() * 60); const k = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) { const it = items[Math.floor(rnd() * items.length)]; const q = 1 + Math.floor(rnd() * 3); const gross = +(it[2] * q).toFixed(3); const disc = rnd() < 0.08 ? +(gross * 0.1).toFixed(3) : 0; const net = +(gross - disc).toFixed(3); const cogs = +(it[3] * q).toFixed(3);
      lines.push(['2026-09-' + String(d).padStart(2, '0') + ' ' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00', '1-' + rc, 'Sale', it[0], '', it[1], '', '', q, gross.toFixed(3), disc.toFixed(3), net.toFixed(3), cogs.toFixed(3), (net - cogs).toFixed(3), '0.000', rnd() < 0.5 ? 'POS 1' : 'POS 2', 'Main', rnd() < 0.5 ? 'Ahmed' : 'Salim', '', '', '', 'Closed'].join(',')); } } }
  const csvPath = path.join(OUT, 'demo-month.csv'); fs.writeFileSync(csvPath, lines.join('\n'));
  await page.setInputFiles('#csvFile', csvPath);
  await page.click('#btnPreviewCsv'); await page.waitForSelector('#csvPreview:not(.hidden)');
  await page.screenshot({ path: OUT + '/m-preview.png', clip: { x: 0, y: 0, width: 390, height: 844 } });
  await page.click('#btnImportCsv'); await page.click('#mOk'); await page.waitForSelector('#csvResult:not(.hidden)');
  await page.click('#accTabs button[data-tab=acc-purchase]');
  const f = page.locator('#purchaseForm');
  await f.locator('[name=description]').fill('بن عماني 10 كيلو'); await f.locator('[name=invoiceDate]').fill('2026-09-14'); await f.locator('[name=subtotal]').fill('40.425');
  await f.locator('.seg button[data-v="تحويل بنكي"]').click();
  await page.screenshot({ path: OUT + '/m-purchase.png', clip: { x: 0, y: 0, width: 390, height: 844 } });
  // create the entries through the API (faster and deterministic)
  const api = async (name, args) => (await (await fetch(BASE + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args }) })).json()).result;
  const tk = (await api('api_login', ['ac', '1234'])).token;
  const P = (n, d, sup, cat, amt, pm) => api('api_addPurchase', [tk, { invoiceNumber: n, invoiceDate: d, supplier: sup, category: cat, subtotal: amt, tax: 0, discount: 0, paidAmount: amt, paymentMethod: pm, isInventory: true }, null]);
  await P('A-1042', '2026-09-02', 'شركة البن العماني', 'بن', 320, 'تحويل بنكي'); await P('M-77', '2026-09-05', 'مزرعة الألبان', 'حليب', 145, 'نقد'); await P('C-19', '2026-09-09', 'مصنع الأكواب', 'أكواب وعبوات', 88, 'بطاقة'); await P('A-1051', '2026-09-18', 'شركة البن العماني', 'بن', 310, 'تحويل بنكي'); await P('M-81', '2026-09-20', 'مزرعة الألبان', 'حليب', 150, 'نقد');
  const E = (d, t, desc, amt, payee) => api('api_addExpense', [tk, { expenseDate: d, expenseType: t, description: desc, amount: amt, paymentMethod: 'بطاقة', payee: payee, paymentStatus: 'مدفوع' }, null]);
  await E('2026-09-03', 'كهرباء', 'فاتورة الكهرباء', 96.5, 'نماء'); await E('2026-09-03', 'ماء', 'فاتورة الماء', 18, 'ديم'); await E('2026-09-06', 'إنترنت', 'اشتراك الإنترنت', 25, 'عمانتل'); await E('2026-09-12', 'تنظيف', 'مواد تنظيف', 22.4, 'كارفور'); await E('2026-09-21', 'تسويق', 'إعلان إنستغرام', 40, 'Meta'); await E('2026-09-25', 'صيانة', 'صيانة ماكينة الإسبريسو', 35, 'ورشة الخليج');
  await api('api_addPayroll', [tk, { employee: 'سالم', month: '2026-09', basicSalary: 380, allowance: 40, overtime: 0, deduction: 0, advance: 0, paymentDate: '2026-09-28', paymentMethod: 'تحويل بنكي', paymentStatus: 'مدفوع' }]);
  await api('api_addPayroll', [tk, { employee: 'أحمد', month: '2026-09', basicSalary: 350, allowance: 40, overtime: 25, deduction: 0, advance: 0, paymentDate: '2026-09-28', paymentMethod: 'تحويل بنكي', paymentStatus: 'مدفوع' }]);
  await api('api_addRent', [tk, { period: '2026-09', landlord: 'المالك', amount: 450, dueDate: '2026-09-01', paymentDate: '2026-09-01', paymentMethod: 'تحويل بنكي', status: 'مدفوع' }, null]);

  // manager: mobile dashboard + desktop
  page = await mk({ width: 390, height: 844 });
  await login(page, 'admin', '2026'); await page.waitForSelector('#kpis .kpi');
  await page.click('#presetChips .chip[data-preset=custom]'); await page.fill('#fFrom', '2026-09-01'); await page.fill('#fTo', '2026-09-30'); await page.click('#btnApplyFilters'); await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('#demoWarning').classList.add('hidden'); document.querySelector('#kpis').scrollIntoView(); });
  await page.screenshot({ path: OUT + '/m-dashboard.png', clip: { x: 0, y: 0, width: 390, height: 844 } });
  const desk = await mk({ width: 1280, height: 800 }, 1.5);
  await login(desk, 'admin', '2026'); await desk.waitForSelector('#kpis .kpi');
  await desk.click('#presetChips .chip[data-preset=custom]'); await desk.fill('#fFrom', '2026-09-01'); await desk.fill('#fTo', '2026-09-30'); await desk.click('#btnApplyFilters'); await desk.waitForTimeout(400);
  await desk.evaluate(() => { document.querySelector('#demoWarning').classList.add('hidden'); });
  const box = await desk.locator('#kpis').boundingBox();
  await desk.screenshot({ path: OUT + '/m-desktop.png', clip: { x: 0, y: 0, width: 1280, height: Math.min(800, box.y + box.height + 20) } });
  await desk.click('#mgrTabs button[data-tab=mgr-reports]'); await desk.selectOption('#rType', 'pnl'); await desk.fill('#rFrom', '2026-09-01'); await desk.fill('#rTo', '2026-09-30'); await desk.click('#btnReportView'); await desk.waitForSelector('#reportOut .card');
  const rb = await desk.locator('#reportOut').boundingBox();
  await desk.screenshot({ path: OUT + '/m-report.png', clip: { x: 0, y: Math.max(0, rb.y - 10), width: 1280, height: 520 } });
  await browser.close(); srv.kill();
  console.log('shots written to', OUT);
})().catch(e => { console.error(e); process.exit(1); });
