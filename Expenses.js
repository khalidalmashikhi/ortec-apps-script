function createExpense(input, sessionToken) {
  const user = requireRole_(['OWNER','ADMIN','ACCOUNTANT','BRANCH_MANAGER','CASHIER'], sessionToken);
  input = input || {};
  validateExpense_(input);
  let fileId = '';
  if (input.invoiceBase64) {
    const bytes = Utilities.base64Decode(String(input.invoiceBase64).split(',').pop());
    const blob = Utilities.newBlob(bytes, input.invoiceMimeType || 'application/octet-stream', input.invoiceFileName || `invoice_${Date.now()}`);
    fileId = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('EXPENSE_FOLDER_ID')).createFile(blob).getId();
  }
  const amount = Number(input.amount);
  const limit = Number(getSetting_('EXPENSE_APPROVAL_LIMIT', 50));
  const status = user.role === 'OWNER' || amount <= limit ? 'APPROVED' : 'PENDING_APPROVAL';
  const id = uuid_();
  const row = {
    expense_id:id, expense_date:input.expenseDate || today_(),
    expense_scope:input.branchId === 'OUTSIDE' ? 'OUTSIDE' : 'BRANCH', branch_id:input.branchId,
    amount:amount, category:input.category, payment_method:input.paymentMethod || 'CASH',
    payment_status:input.paymentStatus || 'PAID', beneficiary:input.beneficiary || '',
    description:String(input.description || '').trim(), invoice_required:input.category !== 'DELIVERY',
    invoice_file_id:fileId, invoice_number:input.invoiceNumber || '', delivery_agent_id:input.deliveryAgentId || '',
    shipment_number:input.shipmentNumber || '', status:status, created_by:user.email,
    approved_by:status==='APPROVED'?user.email:'', created_at:nowIso_(), approved_at:status==='APPROVED'?nowIso_():''
  };
  appendObject_(ORTEC.SHEETS.EXPENSES,row);
  audit_('EXPENSE',id,'CREATE',null,row);
  sendExpenseNotification_(row);
  return makeClientSafe_({ok:true, expense:row});
}

function validateExpense_(input) {
  if (!input.branchId || !['AWQAD','SAADA','ITTIN','OUTSIDE'].includes(input.branchId)) throw new Error('حدد الفرع أو اختر خارج الفروع.');
  if (!(Number(input.amount) > 0)) throw new Error('يجب أن يكون المبلغ أكبر من صفر.');
  if (!input.category) throw new Error('اختر تصنيف المصروف.');
  if (!String(input.description || '').trim()) throw new Error('اكتب بيان المصروف.');
  if (input.category === 'DELIVERY') {
    if (!input.deliveryAgentId && !input.deliveryAgentName) throw new Error('اسم مندوب التوصيل مطلوب.');
    if (!input.shipmentNumber) throw new Error('رقم الشحنة مطلوب.');
    if (!input.deliveryAgentId && input.deliveryAgentName) input.deliveryAgentId = createDeliveryAgent_({agent_name:input.deliveryAgentName,company_name:input.deliveryCompany||'',phone:input.deliveryPhone||''});
  } else if (!input.invoiceBase64 && String(getSetting_('REQUIRE_INVOICE_FOR_EXPENSE','true'))==='true') {
    throw new Error('أرفق الفاتورة أو الإيصال لهذا المصروف.');
  }
}

function createDeliveryAgent_(data) {
  const existing=sheetToObjects_(ORTEC.SHEETS.DELIVERY_AGENTS).find(function(a){return String(a.agent_name).trim().toLowerCase()===String(data.agent_name).trim().toLowerCase();});
  if(existing)return existing.agent_id;
  const id=uuid_(); appendObject_(ORTEC.SHEETS.DELIVERY_AGENTS,{agent_id:id,agent_name:data.agent_name,company_name:data.company_name,phone:data.phone,active:true,created_at:nowIso_()}); return id;
}

function approveExpense(expenseId, sessionToken) {
  const user=requireRole_(['OWNER','ADMIN','ACCOUNTANT'], sessionToken);
  const old=findBy_(ORTEC.SHEETS.EXPENSES,'expense_id',expenseId); if(!old)throw new Error('المصروف غير موجود.');
  const patch={status:'APPROVED',approved_by:user.email,approved_at:nowIso_()};
  updateById_(ORTEC.SHEETS.EXPENSES,'expense_id',expenseId,patch); audit_('EXPENSE',expenseId,'APPROVE',old,Object.assign({},old,patch)); return {ok:true};
}

function listExpenses(date, branchId) {
  return sheetToObjects_(ORTEC.SHEETS.EXPENSES).filter(function(r){return (!date||normalizeDate_(r.expense_date)===date)&&(!branchId||branchId==='ALL'||r.branch_id===branchId);});
}

function sendExpenseNotification_(expense) {
  const recipients=getSetting_('REPORT_RECIPIENTS',''); if(!recipients)return;
  const pdf=createExpensePdf_(expense);
  const attachments=[pdf];
  if(expense.invoice_file_id){try{attachments.push(DriveApp.getFileById(expense.invoice_file_id).getBlob());}catch(e){}}
  MailApp.sendEmail({
    to:recipients, subject:`OrTec — مصروف ${Number(expense.amount).toFixed(3)} ر.ع — ${branchLabel_(expense.branch_id)}`,
    body:'تفاصيل المصروف مرفقة بصيغة PDF.',
    htmlBody:`<div dir="rtl" style="font-family:Arial"><h2>تم تسجيل مصروف</h2><p><b>المبلغ:</b> ${fmt_(expense.amount)}</p><p><b>المكان:</b> ${branchLabel_(expense.branch_id)}</p><p><b>البيان:</b> ${escapeHtml_(expense.description)}</p><p>التقرير الكامل مرفق PDF.</p></div>`,
    attachments:attachments, name:'OrTec OS'
  });
}

function createExpensePdf_(e){
  const doc=DocumentApp.create(`OrTec_Expense_${e.expense_id}`); const b=doc.getBody(); b.clear();
  b.appendParagraph('OrTec OS').setHeading(DocumentApp.ParagraphHeading.TITLE); b.appendParagraph('سند مصروف').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  b.appendTable([
    ['الرقم المرجعي',safeText_(e.expense_id)],['التاريخ',safeText_(e.expense_date)],['المكان',branchLabel_(e.branch_id)],
    ['المبلغ',fmt_(e.amount)],['التصنيف',safeText_(e.category)],['طريقة الدفع',safeText_(e.payment_method)],
    ['حالة الدفع',safeText_(e.payment_status)],['المستفيد',safeText_(e.beneficiary)],['البيان',safeText_(e.description)],
    ['الحالة',safeText_(e.status)],['المسجل',safeText_(e.created_by)],['وقت التسجيل',safeText_(e.created_at)]
  ]);
  doc.saveAndClose(); const blob=DriveApp.getFileById(doc.getId()).getAs(MimeType.PDF).setName(`OrTec_Expense_${e.expense_id}.pdf`);
  DriveApp.getFileById(doc.getId()).setTrashed(true); return blob;
}
