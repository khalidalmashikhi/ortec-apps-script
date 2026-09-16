/**
 * Report builder (data) + Google Docs → PDF renderer, saved under  Walif Coffee Accounting/Reports/YYYY/MM.
 */

var REPORT_TYPES_ = {
  daily: 'التقرير اليومي', weekly: 'التقرير الأسبوعي', monthly: 'التقرير الشهري', custom: 'تقرير فترة مخصصة',
  purchases: 'تقرير المشتريات', expenses: 'تقرير المصروفات', payroll: 'تقرير الرواتب', rent: 'تقرير الإيجارات',
  pnl: 'تقرير الربح والخسارة', cashflow: 'تقرير الحركة النقدية', receipts: 'أرشيف الإيصالات'
};
var RECEIPTS_MAX_IMAGES_ = 60;

function reportRange_(type, from, to) {
  var today = parseDateOnly_(todayStr_());
  if (type === 'daily') { var d = parseDateOnly_(from) || today; return { from: fmtDate_(d), to: fmtDate_(d) }; }
  if (type === 'weekly') { var e = parseDateOnly_(to) || parseDateOnly_(from) || today; return { from: fmtDate_(addDays_(e, -6)), to: fmtDate_(e) }; }
  if (type === 'monthly') {
    var base = parseDateOnly_(from) || today; var ym = fmtDate_(base, 'yyyy-MM');
    return { from: ym + '-01', to: monthEnd_(ym) };
  }
  return periodRange_('custom', from, to);
}

function kpiRows_(k) {
  return [
    ['إجمالي المبيعات', k.grossSales], ['الخصومات', k.discounts], ['صافي المبيعات', k.netSales],
    ['تكلفة البضاعة المباعة', k.cogs], ['مجمل الربح', k.grossProfit], ['هامش مجمل الربح %', k.grossMargin],
    ['المشتريات المدفوعة', k.purchasesPaid], ['مشتريات المخزون (إجمالي الفواتير)', k.inventoryPurchases],
    ['المصروفات', k.expenses], ['الرواتب المدفوعة', k.payrollPaid], ['الإيجار المدفوع', k.rentPaid],
    ['صافي الربح التشغيلي', k.operatingProfit], ['صافي الحركة النقدية', k.netCash],
    ['عدد الفواتير', k.receipts], ['متوسط الفاتورة', k.avgReceipt]
  ];
}

/** Returns {title, subtitle, range, kpis:[[label,value]], sections:[{title, headers, rows}], notes:[]} */
function buildReport_(type, from, to) {
  if (!REPORT_TYPES_[type]) throw new Error('نوع التقرير غير معروف.');
  var range = reportRange_(type, from, to);
  var fin = computeFinancials_(range.from, range.to, {});
  var k = fin.kpis;
  var sb = salesBreakdowns_(fin._sales, 5);
  var cb = costBreakdowns_(fin);
  var money = function (n) { return money_(n); };
  var notes = [];
  if (!fin._sales.length) notes.push('لا توجد مبيعات مستوردة لهذه الفترة.');
  if (Math.abs(k.grossProfitDiff) > 0.001) notes.push('فرق بين مجمل الربح المحسوب ومجمل ربح Loyverse: ' + money(k.grossProfitDiff));
  if (k.purchasesUnpaid > 0) notes.push('مشتريات غير مدفوعة (متبقية): ' + money(k.purchasesUnpaid));
  var unpaidExp = round3_(k.expenses - k.expensesPaid); if (unpaidExp > 0) notes.push('مصروفات غير مدفوعة: ' + money(unpaidExp));
  var errs = readRows_(WC.SHEETS.ERRORS).filter(function (r) { return String(r.Resolved) !== 'TRUE' && inRange_(dateCell_(r.Timestamp), range.from, range.to); });
  if (errs.length) notes.push('أخطاء نظام غير معالجة خلال الفترة: ' + errs.length);
  var imports = readRows_(WC.SHEETS.SALES_IMPORTS).filter(function (r) { return String(r.Status) !== 'OK' && inRange_(dateCell_(r['Uploaded At']), range.from, range.to); });
  if (imports.length) notes.push('عمليات استيراد فاشلة خلال الفترة: ' + imports.length);

  var rep = { type: type, title: REPORT_TYPES_[type], range: range, kpis: [], sections: [], notes: notes,
    subtitle: range.from === range.to ? 'تاريخ التقرير: ' + range.from : 'الفترة: ' + range.from + ' إلى ' + range.to };

  var salesSections = function () {
    rep.sections.push({ title: 'أفضل 5 أصناف', headers: ['الصنف', 'الكمية', 'صافي المبيعات'], rows: sb.topItems.map(function (i) { return [i.item, i.qty, money(i.net)]; }) });
    if (sb.byPos.length) rep.sections.push({ title: 'المبيعات حسب نقطة البيع', headers: ['POS', 'صافي المبيعات'], rows: sb.byPos.map(function (p) { return [p.pos, money(p.net)]; }) });
    if (sb.byCashier.length) rep.sections.push({ title: 'المبيعات حسب الكاشير', headers: ['الكاشير', 'صافي المبيعات'], rows: sb.byCashier.map(function (p) { return [p.cashier, money(p.net)]; }) });
    if (sb.byCategory.length) rep.sections.push({ title: 'المبيعات حسب التصنيف', headers: ['التصنيف', 'صافي المبيعات'], rows: sb.byCategory.map(function (p) { return [p.category, money(p.net)]; }) });
  };

  switch (type) {
    case 'daily': case 'weekly': case 'monthly': case 'custom':
      rep.kpis = kpiRows_(k);
      var bank = bankBalance_();
      if (bank.configured) rep.kpis.push(['رصيد الحساب البنكي (حتى ' + bank.asOf + ')', bank.balance]);
      if (type !== 'daily') rep.sections.push({ title: 'المبيعات اليومية', headers: ['التاريخ', 'صافي المبيعات', 'التكلفة', 'مجمل الربح', 'الفواتير'], rows: sb.daily.map(function (d) { return [d.date, money(d.net), money(d.cogs), money(d.profit), d.receipts]; }) });
      salesSections();
      if (cb.expensesByType.length) rep.sections.push({ title: 'المصروفات حسب النوع', headers: ['النوع', 'المبلغ'], rows: cb.expensesByType.map(function (e) { return [e.type, money(e.amount)]; }) });
      break;
    case 'purchases':
      rep.kpis = [['إجمالي المشتريات', k.purchasesTotal], ['مشتريات المخزون', k.inventoryPurchases], ['مشتريات غير مخزنية', k.nonInventoryPurchases], ['المدفوع', k.purchasesPaid], ['المتبقي', k.purchasesUnpaid]];
      rep.sections.push({ title: 'حسب المورد', headers: ['المورد', 'الإجمالي'], rows: cb.purchasesBySupplier.map(function (s) { return [s.supplier, money(s.total)]; }) });
      rep.sections.push({ title: 'حسب التصنيف', headers: ['التصنيف', 'الإجمالي'], rows: cb.purchasesByCategory.map(function (s) { return [s.category, money(s.total)]; }) });
      rep.sections.push({ title: 'الفواتير', headers: ['التاريخ', 'رقم الفاتورة', 'المورد', 'التصنيف', 'الإجمالي', 'المدفوع', 'الحالة'],
        rows: fin._purchases.map(function (r) { return [dateCell_(r['Invoice Date']), r['Invoice Number'], r.Supplier, r.Category, money(r.Total), money(r['Paid Amount']), r['Payment Status']]; }) });
      break;
    case 'expenses':
      rep.kpis = [['إجمالي المصروفات', k.expenses], ['المدفوع', k.expensesPaid], ['غير المدفوع', round3_(k.expenses - k.expensesPaid)]];
      rep.sections.push({ title: 'حسب النوع', headers: ['النوع', 'المبلغ'], rows: cb.expensesByType.map(function (e) { return [e.type, money(e.amount)]; }) });
      rep.sections.push({ title: 'التفاصيل', headers: ['التاريخ', 'النوع', 'البيان', 'المستفيد', 'المبلغ', 'الحالة'],
        rows: fin._expenses.map(function (r) { return [dateCell_(r['Expense Date']), r['Expense Type'], r.Description, r.Payee, money(r.Amount), r['Payment Status']]; }) });
      break;
    case 'payroll':
      rep.kpis = [['إجمالي الرواتب', k.payroll], ['المدفوع', k.payrollPaid], ['غير المدفوع', round3_(k.payroll - k.payrollPaid)]];
      rep.sections.push({ title: 'حسب الشهر', headers: ['الشهر', 'المبلغ'], rows: cb.payrollByMonth.map(function (m) { return [m.month, money(m.amount)]; }) });
      rep.sections.push({ title: 'التفاصيل', headers: ['العامل', 'الشهر', 'الأساسي', 'البدل', 'الإضافي', 'الخصم', 'السلفة', 'الصافي', 'الحالة'],
        rows: fin._payroll.map(function (r) { return [r.Employee, r.Month, money(r['Basic Salary']), money(r.Allowance), money(r.Overtime), money(r.Deduction), money(r.Advance), money(r['Net Salary']), r['Payment Status']]; }) });
      break;
    case 'rent':
      rep.kpis = [['إجمالي الإيجار', k.rent], ['المدفوع', k.rentPaid], ['المستحق', round3_(k.rent - k.rentPaid)]];
      rep.sections.push({ title: 'الإيجارات', headers: ['الفترة', 'المؤجر', 'المبلغ', 'الاستحقاق', 'تاريخ الدفع', 'الحالة'],
        rows: cb.rentList.map(function (r) { return [r.period, r.landlord, money(r.amount), r.dueDate, r.paymentDate, r.status]; }) });
      break;
    case 'pnl':
      rep.kpis = [['صافي المبيعات', k.netSales], ['تكلفة البضاعة المباعة', k.cogs], ['مجمل الربح', k.grossProfit], ['مجمل ربح Loyverse (للمطابقة)', k.loyverseGrossProfit],
        ['المصروفات العامة', k.expenses], ['الرواتب', k.payroll], ['الإيجار', k.rent], ['إجمالي المصروفات التشغيلية', k.operatingExpenses], ['صافي الربح التشغيلي', k.operatingProfit]];
      rep.notes.unshift('مشتريات المخزون (' + money(k.inventoryPurchases) + ') لا تُخصم هنا لأن تكلفة الجزء المباع مدرجة في تكلفة البضاعة المباعة.');
      rep.sections.push({ title: 'المصروفات حسب النوع', headers: ['النوع', 'المبلغ'], rows: cb.expensesByType.map(function (e) { return [e.type, money(e.amount)]; }) });
      break;
    case 'cashflow':
      rep.kpis = [['صافي المبيعات (داخل)', k.netSales], ['المشتريات المدفوعة', k.purchasesPaid], ['المصروفات المدفوعة', k.expensesPaid], ['الرواتب المدفوعة', k.payrollPaid], ['الإيجار المدفوع', k.rentPaid], ['صافي الحركة النقدية', k.netCash],
        ['للمقارنة: صافي الربح المحاسبي', k.operatingProfit], ['الفرق (نقد − ربح)', round3_(k.netCash - k.operatingProfit)]];
      var bank2 = bankBalance_();
      if (bank2.configured) rep.kpis.push(['رصيد الحساب البنكي (حتى ' + bank2.asOf + ')', bank2.balance]);
      rep.sections.push({ title: 'المشتريات حسب المورد', headers: ['المورد', 'الإجمالي'], rows: cb.purchasesBySupplier.map(function (s) { return [s.supplier, money(s.total)]; }) });
      break;
    case 'receipts':
      var receipts = collectReceipts_(fin);
      rep.kpis = [['عدد الإيصالات المصورة', receipts.length], ['إجمالي مبالغها', round3_(receipts.reduce(function (t, r) { return t + r.amount; }, 0))]];
      rep.sections.push({ title: 'الإيصالات', headers: ['#', 'التاريخ', 'النوع', 'الجهة', 'المبلغ', 'البيان', 'المرفق'],
        rows: receipts.map(function (r, i) { return [i + 1, r.date, r.kind, r.party, money(r.amount), r.description, r.url]; }) });
      rep.images = receipts;
      rep.notes = [];
      if (!receipts.length) rep.notes.push('لا توجد إيصالات مرفقة في هذه الفترة.');
      if (receipts.length > RECEIPTS_MAX_IMAGES_) rep.notes.push('يُدرج في PDF أول ' + RECEIPTS_MAX_IMAGES_ + ' صورة فقط؛ الباقي بالروابط في الجدول.');
      break;
  }
  return rep;
}

/** Active purchases / expenses / rents in the period that carry an attachment. */
function collectReceipts_(fin) {
  var out = [];
  fin._purchases.forEach(function (r) { if (r['Attachment ID']) out.push({ date: dateCell_(r['Invoice Date']), kind: 'مشتريات', party: String(r.Supplier || ''), amount: toNum_(r.Total), description: String(r.Description || r['Invoice Number'] || ''), fileId: String(r['Attachment ID']), url: String(r['Attachment URL'] || '') }); });
  fin._expenses.forEach(function (r) { if (r['Attachment ID']) out.push({ date: dateCell_(r['Expense Date']), kind: 'مصروف', party: String(r.Payee || r['Expense Type'] || ''), amount: toNum_(r.Amount), description: String(r.Description || ''), fileId: String(r['Attachment ID']), url: String(r['Attachment URL'] || '') }); });
  fin._rent.forEach(function (r) { if (r['Attachment ID']) out.push({ date: r._d, kind: 'إيجار', party: String(r.Landlord || ''), amount: toNum_(r.Amount), description: String(r.Period || ''), fileId: String(r['Attachment ID']), url: String(r['Attachment URL'] || '') }); });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

/** Appends each receipt image (JPG/PNG) to the document; PDFs and unreadable files are listed as links. */
function appendReceiptImages_(body, rtl, receipts) {
  var skipped = [];
  receipts.slice(0, RECEIPTS_MAX_IMAGES_).forEach(function (r, i) {
    var caption = (i + 1) + '. ' + r.date + ' — ' + r.kind + ' — ' + r.party + ' — ' + money_(r.amount) + ' ' + brand_().currency + (r.description ? ' — ' + r.description : '');
    rtl(body.appendParagraph(caption)).setBold(true);
    try {
      var file = DriveApp.getFileById(r.fileId);
      var mime = String(file.getMimeType ? file.getMimeType() : file.getBlob().getContentType());
      if (/^image\/(jpeg|jpg|png|gif)$/i.test(mime)) {
        var img = body.appendImage(file.getBlob());
        var w = img.getWidth(), h = img.getHeight(), maxW = 420, maxH = 560;
        if (w && h) { var k = Math.min(maxW / w, maxH / h, 1); img.setWidth(Math.round(w * k)); img.setHeight(Math.round(h * k)); }
      } else {
        skipped.push(caption);
        rtl(body.appendParagraph('ملف PDF — الرابط: ' + r.url));
      }
    } catch (e) {
      skipped.push(caption);
      rtl(body.appendParagraph('تعذر تحميل المرفق — الرابط: ' + r.url));
    }
    rtl(body.appendParagraph(''));
  });
  return skipped;
}

// ---------------------------------------------------------------- Google Docs → PDF

function reportFileName_(rep) {
  var typeName = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', custom: 'Custom', purchases: 'Purchases', expenses: 'Expenses', payroll: 'Payroll', rent: 'Rent', pnl: 'PnL', cashflow: 'CashFlow', receipts: 'Receipts' }[rep.type];
  var period = rep.range.from === rep.range.to ? rep.range.from : rep.range.from + '_to_' + rep.range.to;
  return brand_().slug + '-' + typeName + '-Report-' + period + '.pdf';
}

function renderReportPdf_(rep) {
  var name = reportFileName_(rep);
  var doc = DocumentApp.create('tmp-' + name.replace(/\.pdf$/, ''));
  var body = doc.getBody();
  var rtl = function (p) { try { p.setLeftToRight(false); } catch (e) {} p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT); return p; };

  var b = brand_();
  rtl(body.appendParagraph(b.name + ' / ' + b.nameAr)).setHeading(DocumentApp.ParagraphHeading.TITLE);
  rtl(body.appendParagraph(rep.title)).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  rtl(body.appendParagraph(rep.subtitle));
  rtl(body.appendParagraph('أُنشئ في: ' + fmtDateTime_(now_()) + ' (توقيت مسقط) — العملة: ' + b.currency)).setItalic(true);

  if (rep.kpis.length) {
    rtl(body.appendParagraph('المؤشرات')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var t = body.appendTable([['المؤشر', 'القيمة']].concat(rep.kpis.map(function (r) { return [String(r[0]), typeof r[1] === 'number' && String(r[0]).indexOf('عدد') < 0 && String(r[0]).indexOf('%') < 0 ? money_(r[1]) : String(r[1])]; })));
    styleTable_(t);
  }
  rep.sections.forEach(function (s) {
    rtl(body.appendParagraph(s.title)).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    if (!s.rows.length) { rtl(body.appendParagraph('لا توجد بيانات.')); return; }
    var data = [s.headers.map(String)].concat(s.rows.slice(0, 300).map(function (r) { return r.map(function (v) { return String(v == null ? '' : v); }); }));
    styleTable_(body.appendTable(data));
  });
  if (rep.images && rep.images.length) {
    rtl(body.appendParagraph('صور الإيصالات')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    var skipped = appendReceiptImages_(body, rtl, rep.images);
    if (skipped.length) rep.notes.push('إيصالات بدون صورة داخل الملف (PDF أو مرفق غير صالح): ' + skipped.length);
  }
  if (rep.notes.length) {
    rtl(body.appendParagraph('ملاحظات')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
    rep.notes.forEach(function (n) { rtl(body.appendListItem(n)); });
  }
  doc.saveAndClose();

  var pdfBlob = DriveApp.getFileById(doc.getId()).getAs('application/pdf').setName(name);
  var folder = monthlyFolder_('REPORTS_FOLDER_ID', parseDateOnly_(rep.range.to) || now_());
  // replace an older copy with the same name
  var old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  var file = folder.createFile(pdfBlob);
  try { DriveApp.getFileById(doc.getId()).setTrashed(true); } catch (e) {}
  return { fileId: file.getId(), url: file.getUrl(), name: name, blob: pdfBlob };
}

function styleTable_(table) {
  try {
    table.setBorderWidth(0.5);
    var head = table.getRow(0);
    for (var c = 0; c < head.getNumCells(); c++) head.getCell(c).setBackgroundColor(brand_().primary).getChild(0).asParagraph().setForegroundColor(brand_().cream).setBold(true);
    for (var r = 0; r < table.getNumRows(); r++) for (var k = 0; k < table.getRow(r).getNumCells(); k++) {
      var p = table.getRow(r).getCell(k).getChild(0).asParagraph();
      try { p.setLeftToRight(false); } catch (e) {}
      p.setAlignment(DocumentApp.HorizontalAlignment.RIGHT);
    }
  } catch (e) { /* cosmetic only */ }
}

// ---------------------------------------------------------------- API

function api_getReportData(token, type, from, to) {
  return apiCall_('api_getReportData', token, [WC.ROLES.MANAGER], function () {
    return { ok: true, report: buildReport_(String(type), cleanText_(from, 10), cleanText_(to, 10)) };
  });
}

function api_generateReportPdf(token, type, from, to) {
  return apiCall_('api_generateReportPdf', token, [WC.ROLES.MANAGER], function (actor) {
    var rep = buildReport_(String(type), cleanText_(from, 10), cleanText_(to, 10));
    var pdf = renderReportPdf_(rep);
    logAudit_(actor, 'DOWNLOAD_REPORT', 'Reports', pdf.fileId, rep.title + ' ' + rep.range.from + '..' + rep.range.to, 'OK');
    return { ok: true, url: pdf.url, name: pdf.name, fileId: pdf.fileId, base64: Utilities.base64Encode(pdf.blob.getBytes()) };
  });
}
