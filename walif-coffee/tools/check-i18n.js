// Verifies every data-i18n text, t('...') literal, report string and server message has an English entry.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const scripts = read('Scripts.html').match(/<script>([\s\S]*)<\/script>/)[1];
const ctx = { window: {}, document: { addEventListener() {} }, localStorage: {}, sessionStorage: {} };
vm.createContext(ctx); new vm.Script(scripts).runInContext(ctx);
const EN = ctx.I18N_EN;
const keys = new Set();
for (const f of ['Index.html', 'Login.html', 'Accountant.html', 'Dashboard.html']) {
  const html = read(f);
  const re = /data-i18n[^>]*>([^<]+)</g; let m; while ((m = re.exec(html))) keys.add(m[1].trim());
}
for (const f of ['Dashboard.html', 'Scripts.html']) {
  const src = read(f); const re = /\bt\('([^']+)'\)/g; let m; while ((m = re.exec(src))) keys.add(m[1]);
  const re2 = /\[('[^'\]]+'(?:,\s*'[^'\]]+')*)\]\.map\(t\)/g; while ((m = re2.exec(src))) m[1].split(',').forEach(s => keys.add(s.trim().replace(/^'|'$/g, '')));
}
// server literals
for (const f of fs.readdirSync(root).filter(x => x.endsWith('.gs'))) {
  const src = read(f); let m;
  const re = /throw new Error\('([^']+)'\)|error: '([^']+)'/g; while ((m = re.exec(src))) { const k = m[1] || m[2]; if (/[؀-ۿ]/.test(k)) keys.add(k); }
  if (f === 'Reports.gs' || f === 'Analytics.gs') { const re3 = /'([^']*[؀-ۿ][^']*)'/g; while ((m = re3.exec(src))) if (!/[+]/.test(m[1]) && m[1].length < 80) keys.add(m[1]); }
}
const PDF_ONLY = new Set(['ملف PDF — الرابط: ', 'تعذر تحميل المرفق — الرابط: ', 'يُدرج في PDF أول ', ' صورة فقط؛ الباقي بالروابط في الجدول.', ' — ', 'مشتريات', 'مصروف', 'إيجار', 'إيصالات بدون صورة داخل الملف (PDF أو مرفق غير صالح): ', 'لا توجد بيانات.', 'ملاحظات', '#', 'المؤشر', 'القيمة', 'عدد', 'أُنشئ في: ', ' (توقيت مسقط) — العملة: ', ' إلى ', 'مشتريات المخزون (', ') لا تُخصم هنا لأن تكلفة الجزء المباع مدرجة في تكلفة البضاعة المباعة.']);
const missing = [...keys].filter(k => EN[k] === undefined && k !== '' && !PDF_ONLY.has(k) && EN[k.replace(/:\s*$/, '')] === undefined);
console.log('keys checked:', keys.size, 'missing:', missing.length);
missing.forEach(k => console.log('  -', k));
process.exit(missing.length ? 1 : 0);
