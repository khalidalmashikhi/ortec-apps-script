function createReportPdf(reportType, options, sessionToken) {
  const user = requireCapability_('reports', sessionToken);
  options = options || {};
  const type = String(reportType || 'DAILY').toUpperCase();
  const dateFrom = resolveDateArg_(options.dateFrom || options.date);
  const dateTo = resolveDateArg_(options.dateTo || dateFrom);
  const branchId = scopeBranch_(user, options.branchId || user.branch_id || 'ALL');

  const payload = buildReportPayload_(type, dateFrom, dateTo, branchId);
  const file = renderReportPdf_(payload, user);
  audit_('REPORT', file.getId(), 'CREATE_PDF', null, {
    reportType: type, dateFrom: dateFrom, dateTo: dateTo, branchId: branchId
  });

  return makeClientSafe_({
    ok: true,
    fileId: file.getId(),
    fileName: file.getName(),
    url: file.getUrl()
  });
}

function emailReportPdf(reportType, options, recipients, sessionToken) {
  const user = requireCapability_('reports.email', sessionToken);
  options = options || {};
  const type = String(reportType || 'DAILY').toUpperCase();
  const dateFrom = resolveDateArg_(options.dateFrom || options.date);
  const dateTo = resolveDateArg_(options.dateTo || dateFrom);
  const branchId = scopeBranch_(user, options.branchId || user.branch_id || 'ALL');
  const to = String(recipients || getSetting_('REPORT_RECIPIENTS', '')).trim();
  if (!to) throw new Error('أدخل بريد المستلم أو حدده في إعدادات النظام.');

  const payload = buildReportPayload_(type, dateFrom, dateTo, branchId);
  const file = renderReportPdf_(payload, user);
  const blob = file.getBlob().setName(file.getName());
  const subject = `OrTec OS — ${payload.titleAr} — ${payload.periodLabel}`;
  const html = buildReportEmailHtml_(payload);

  // Log both outcomes. Previously the log row was only written after a
  // successful send, so a failed nightly report (mail quota, bad recipient)
  // left no trace at all and error_message could never be populated.
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: `تقرير OrTec OS مرفق بصيغة PDF: ${payload.periodLabel}`,
      htmlBody: html,
      attachments: [blob],
      name: 'OrTec OS'
    });
  } catch (mailError) {
    appendObject_(ORTEC.SHEETS.EMAIL_LOG, {
      log_id: uuid_(), report_date: dateFrom, report_type: type, recipients: to,
      pdf_file_id: file.getId(), status: 'FAILED',
      error_message: String(mailError && mailError.message ? mailError.message : mailError),
      sent_at: nowIso_()
    });
    throw mailError;
  }

  appendObject_(ORTEC.SHEETS.EMAIL_LOG, {
    log_id: uuid_(), report_date: dateFrom, report_type: type, recipients: to,
    pdf_file_id: file.getId(), status: 'SENT', error_message: '', sent_at: nowIso_()
  });
  audit_('REPORT', file.getId(), 'EMAIL_PDF', null, { recipients: to, reportType: type });
  return { ok: true, url: file.getUrl(), recipients: to };
}

function buildReportPayload_(type, dateFrom, dateTo, branchId) {
  const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS).filter(function(r) {
    const d = normalizeDate_(r.receipt_date);
    return d >= dateFrom && d <= dateTo && (branchId === 'ALL' || r.branch_id === branchId);
  });
  const items = sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS).filter(function(r) {
    const d = normalizeDate_(r.receipt_date);
    return d >= dateFrom && d <= dateTo && (branchId === 'ALL' || r.branch_id === branchId);
  });
  const expenses = sheetToObjects_(ORTEC.SHEETS.EXPENSES).filter(function(r) {
    const d = normalizeDate_(r.expense_date);
    return d >= dateFrom && d <= dateTo && (branchId === 'ALL' || r.branch_id === branchId);
  });
  const issues = listInventoryIssues_('OPEN').filter(function(r) {
    return branchId === 'ALL' || r.branch_id === branchId;
  });
  const tasks = listTasks_('ALL').filter(function(r) {
    return branchId === 'ALL' || r.branch_id === branchId || r.branch_id === 'ALL';
  });

  const sales = sumField_(receipts, 'net_sales');
  const grossProfit = sumField_(items, 'profit');
  const expenseTotal = sumField_(expenses.filter(function(e){return String(e.status)==='APPROVED';}), 'amount');
  const byBranch = {};
  items.forEach(function(r) {
    const key = r.branch_id || 'UNKNOWN';
    byBranch[key] = byBranch[key] || { branchId: key, sales: 0, profit: 0, quantity: 0 };
    byBranch[key].sales += Number(r.net_sales) || 0;
    byBranch[key].profit += Number(r.profit) || 0;
    byBranch[key].quantity += Number(r.quantity) || 0;
  });
  const byItem = {};
  items.forEach(function(r) {
    const key = String(r.sku || r.item_name || '').trim();
    if (!key) return;
    byItem[key] = byItem[key] || { sku:r.sku||'', itemName:r.item_name||'', quantity:0, sales:0, profit:0 };
    byItem[key].quantity += Number(r.quantity)||0;
    byItem[key].sales += Number(r.net_sales)||0;
    byItem[key].profit += Number(r.profit)||0;
  });

  const titleMap = {
    DAILY: ['التقرير اليومي','Daily Report'], WEEKLY:['التقرير الأسبوعي','Weekly Report'],
    MONTHLY:['التقرير الشهري','Monthly Report'], SALES:['تقرير المبيعات','Sales Report'],
    EXPENSES:['تقرير المصروفات','Expenses Report'], INVENTORY:['تقرير المخزون','Inventory Report'],
    TASKS:['تقرير المهام','Tasks Report'], USERS:['تقرير المستخدمين','Users Report']
  };
  const names = titleMap[type] || titleMap.DAILY;
  return {
    type:type, titleAr:names[0], titleEn:names[1], dateFrom:dateFrom, dateTo:dateTo,
    periodLabel: dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`,
    branchId:branchId, sales:sales, orders:receipts.length,
    averageOrder: receipts.length ? sales/receipts.length : 0,
    grossProfit:grossProfit, expenses:expenseTotal, netProfit:grossProfit-expenseTotal,
    margin:sales ? grossProfit/sales*100 : 0,
    branchPerformance:Object.keys(byBranch).map(function(k){return byBranch[k];}).sort(function(a,b){return b.sales-a.sales;}),
    topItems:Object.keys(byItem).map(function(k){return byItem[k];}).sort(function(a,b){return b.sales-a.sales;}).slice(0,20),
    expenseRows:expenses, issueRows:issues.slice(0,100), taskRows:tasks.slice(0,100)
  };
}

function renderReportPdf_(p, user) {
  const doc = DocumentApp.create(`OrTec_${p.type}_${p.dateFrom}_${p.dateTo}`);
  const body = doc.getBody();
  body.clear();
  body.appendParagraph('OrTec OS').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(`${p.titleAr} | ${p.titleEn}`).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(`الفترة: ${p.periodLabel}    الفرع: ${branchLabel_(p.branchId)}`);
  body.appendParagraph(`أُنشئ بواسطة: ${user.name_ar || user.username}    ${nowIso_()}`);
  body.appendHorizontalRule();
  body.appendTable([
    ['المبيعات','عدد الفواتير','متوسط الفاتورة','ربح الأصناف','المصروفات','صافي الربح','هامش الربح'],
    [fmt_(p.sales),String(p.orders),fmt_(p.averageOrder),fmt_(p.grossProfit),fmt_(p.expenses),fmt_(p.netProfit),`${p.margin.toFixed(1)}%`]
  ]);

  if (p.branchPerformance.length) {
    body.appendParagraph('أداء الفروع').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rows=[['الفرع','المبيعات','الربح','الكمية']];
    p.branchPerformance.forEach(function(r){ rows.push([branchLabel_(r.branchId),fmt_(r.sales),fmt_(r.profit),String(Math.round(r.quantity))]); });
    body.appendTable(rows);
  }
  if (p.topItems.length) {
    body.appendParagraph('أفضل الأصناف').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rows=[['SKU','الصنف','الكمية','المبيعات','الربح']];
    p.topItems.forEach(function(r){ rows.push([String(r.sku||''),String(r.itemName||''),String(Math.round(r.quantity)),fmt_(r.sales),fmt_(r.profit)]); });
    body.appendTable(rows);
  }
  if (p.expenseRows.length) {
    body.appendParagraph('المصروفات').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rows=[['التاريخ','المكان','المبلغ','التصنيف','الدفع','المستفيد','البيان','الحالة']];
    p.expenseRows.slice(0,100).forEach(function(e){ rows.push([
      safeText_(e.expense_date),branchLabel_(e.branch_id),fmt_(e.amount),safeText_(e.category),
      safeText_(e.payment_method),safeText_(e.beneficiary),safeText_(e.description),safeText_(e.status)
    ]); });
    body.appendTable(rows);
  }
  if (p.issueRows.length) {
    body.appendParagraph('تنبيهات المخزون المفتوحة').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rows=[['الأهمية','النوع','الفرع','SKU','الصنف','التفاصيل']];
    p.issueRows.slice(0,60).forEach(function(i){ rows.push([safeText_(i.severity),safeText_(i.issue_type),branchLabel_(i.branch_id),safeText_(i.sku),safeText_(i.item_name),safeText_(i.details)]); });
    body.appendTable(rows);
  }
  if (p.taskRows.length) {
    body.appendParagraph('المهام').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const rows=[['المهمة','المسؤول','الأولوية','الحالة','الاستحقاق']];
    p.taskRows.slice(0,60).forEach(function(t){ rows.push([safeText_(t.title),safeText_(t.assigned_to),safeText_(t.priority),safeText_(t.status),safeText_(t.due_date)]); });
    body.appendTable(rows);
  }
  doc.saveAndClose();
  const pdf = DriveApp.getFileById(doc.getId()).getAs(MimeType.PDF)
    .setName(`OrTec_${p.type}_${p.dateFrom}_${p.dateTo}.pdf`);
  const folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('REPORT_FOLDER_ID'));
  const file = folder.createFile(pdf);
  DriveApp.getFileById(doc.getId()).setTrashed(true);
  return file;
}

function buildReportEmailHtml_(p) {
  return `<div dir="rtl" style="font-family:Arial;max-width:760px">
    <h2>${escapeHtml_(p.titleAr)} — ${escapeHtml_(p.periodLabel)}</h2>
    <p><b>المبيعات:</b> ${fmt_(p.sales)} &nbsp; <b>الربح:</b> ${fmt_(p.grossProfit)} &nbsp; <b>المصروفات:</b> ${fmt_(p.expenses)}</p>
    <p><b>صافي الربح التقديري:</b> ${fmt_(p.netProfit)} &nbsp; <b>هامش الربح:</b> ${p.margin.toFixed(1)}%</p>
    <p>التفاصيل الكاملة مرفقة بصيغة PDF.</p></div>`;
}

/**
 * Nightly accounting report.
 *
 * A time-based trigger calls this with an EVENT OBJECT, not a date. The old
 * `date = date || today_()` kept that object, which then flowed into the
 * report's date filters as "[object Object]" and matched no rows — every
 * scheduled report was empty. Normalize first, and require either a genuine
 * trigger invocation or an authorized caller.
 */
function sendDailyAccountingReport(dateOrEvent, sessionToken) {
  const context = requireScheduledOrCapability_(dateOrEvent, sessionToken, 'reports.email');
  const date = context.date;
  return emailReportPdf('DAILY', {dateFrom:date,dateTo:date,branchId:'ALL'}, getSetting_('REPORT_RECIPIENTS',''), createSystemSessionToken_());
}

function createSystemSessionToken_() {
  const owner = sheetToObjects_(ORTEC.SHEETS.USERS).find(function(u){return String(u.role)==='OWNER' && String(u.active).toLowerCase()!=='false';});
  if (!owner) throw new Error('لا يوجد حساب مالك فعال لتشغيل التقرير الآلي.');
  const token = Utilities.getUuid()+Utilities.getUuid().replace(/-/g,'');
  CacheService.getScriptCache().put('session:'+token, JSON.stringify({user_id:owner.user_id,username:owner.username,created_at:nowIso_(),expires_at:Date.now()+300000}), 300);
  return token;
}

/**
 * Nightly "did the branches upload their Loyverse exports?" check.
 *
 * Two defects made this alert fire every single night regardless of reality:
 * the trigger event object was used as the date (filterByDate_ compares with
 * ===, and an object never equals a date string, so `batches` was always
 * empty), and the constant below was spelled ITEMS_EXPORT while the importer
 * writes ITEM_EXPORT. Both are fixed; either one alone leaves the alert wrong.
 */
function checkMissingLoyverseUpload(dateOrEvent, sessionToken){
  const context = requireScheduledOrCapability_(dateOrEvent, sessionToken, 'import');
  const date = context.date;
  const batches=filterByDate_(ORTEC.SHEETS.IMPORT_BATCHES,'period_date',date);
  const types=new Set(batches.map(function(b){return String(b.report_type||'');}));
  const missing=[];
  if(!types.has(ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM))missing.push('Receipts by Item');
  if(!types.has(ORTEC.IMPORT_TYPES.ITEM_EXPORT))missing.push('Export Items');
  if(!missing.length)return {ok:true,missing:[]};
  const ingestion=getIngestionStatus_();
  const recipients=getSetting_('REPORT_RECIPIENTS','');
  if(recipients){
    const detail=missing.slice();
    if(ingestion.receipts.state!=='OK'){
      detail.push(ingestion.receipts.lastImport
        ? `آخر استيراد للمبيعات: ${ingestion.receipts.lastImport} (منذ ${ingestion.receipts.ageDays} يومًا)`
        : 'لم يتم استيراد أي تقرير مبيعات مطلقًا.');
    }
    if(ingestion.catalogue.state!=='OK'){
      detail.push(ingestion.catalogue.lastImport
        ? `آخر استيراد للمخزون: ${ingestion.catalogue.lastImport} (منذ ${ingestion.catalogue.ageDays} يومًا)`
        : 'لم يتم استيراد أي تقرير مخزون مطلقًا.');
    }
    const blob=createSimpleAlertPdf_('تنبيه نقص تقارير Loyverse',date,detail);
    MailApp.sendEmail({to:recipients,subject:`تنبيه: تقارير Loyverse غير مكتملة - ${date}`,body:'التفاصيل مرفقة PDF',attachments:[blob],name:'OrTec OS'});
  }
  return {ok:false,missing:missing,ingestion:ingestion};
}

function createSimpleAlertPdf_(title,date,lines){
  const doc=DocumentApp.create(`OrTec_Alert_${date}`); const body=doc.getBody(); body.clear();
  body.appendParagraph('OrTec OS').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(date); lines.forEach(function(x){body.appendListItem(String(x));});
  doc.saveAndClose(); const blob=DriveApp.getFileById(doc.getId()).getAs(MimeType.PDF).setName(`OrTec_Alert_${date}.pdf`);
  DriveApp.getFileById(doc.getId()).setTrashed(true); return blob;
}

function branchLabel_(id){
  if(id==='ALL')return 'جميع الفروع'; if(id==='OUTSIDE')return 'خارج الفروع';
  const b=ORTEC.BRANCHES.find(function(x){return x.id===id;}); return b?b.ar:String(id||'');
}
function safeText_(v){return v===null||v===undefined?'':String(v);}
function fmt_(n){return `${(Number(n)||0).toFixed(3)} ر.ع`;}
