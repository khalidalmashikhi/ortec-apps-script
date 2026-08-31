function createTask(input, sessionToken){
  const user=getCurrentUser(sessionToken); input=input||{};
  if(!String(input.title||'').trim())throw new Error('عنوان المهمة مطلوب.');
  const row={task_id:uuid_(),title:String(input.title).trim(),description:input.description||'',branch_id:input.branchId||'ALL',priority:input.priority||'MEDIUM',status:'OPEN',assigned_to:input.assignedTo||'',due_date:input.dueDate||'',source_type:input.sourceType||'MANUAL',source_id:input.sourceId||'',created_by:user.email,created_at:nowIso_(),completed_at:''};
  appendObject_(ORTEC.SHEETS.TASKS,row); audit_('TASK',row.task_id,'CREATE',null,row); return makeClientSafe_(row);
}
function listTasks(status){return sheetToObjects_(ORTEC.SHEETS.TASKS).filter(function(t){return !status||status==='ALL'||(status==='OPEN'?t.status!=='COMPLETED':t.status===status);}).slice(-500).reverse();}
function completeTask(taskId, sessionToken){getCurrentUser(sessionToken);const old=findBy_(ORTEC.SHEETS.TASKS,'task_id',taskId);if(!old)throw new Error('المهمة غير موجودة.');const patch={status:'COMPLETED',completed_at:nowIso_()};updateById_(ORTEC.SHEETS.TASKS,'task_id',taskId,patch);audit_('TASK',taskId,'COMPLETE',old,Object.assign({},old,patch));return {ok:true};}
function sendTaskReminders(){
  const today=today_(); const tasks=listTasks('OPEN').filter(function(t){return t.due_date && normalizeDate_(t.due_date)<=today;});
  if(!tasks.length)return {ok:true,count:0};
  const recipients=getSetting_('REPORT_RECIPIENTS',''); if(!recipients)return {ok:false,count:tasks.length};
  const doc=DocumentApp.create(`OrTec_Task_Reminders_${today}`);const b=doc.getBody();b.clear();b.appendParagraph('OrTec OS').setHeading(DocumentApp.ParagraphHeading.TITLE);b.appendParagraph('تذكير المهام المستحقة والمتأخرة').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  const rows=[['المهمة','المسؤول','الفرع','الأولوية','الاستحقاق']];tasks.forEach(function(t){rows.push([safeText_(t.title),safeText_(t.assigned_to),branchLabel_(t.branch_id),safeText_(t.priority),safeText_(t.due_date)]);});b.appendTable(rows);doc.saveAndClose();
  const blob=DriveApp.getFileById(doc.getId()).getAs(MimeType.PDF).setName(`OrTec_Task_Reminders_${today}.pdf`);DriveApp.getFileById(doc.getId()).setTrashed(true);
  MailApp.sendEmail({to:recipients,subject:`OrTec — تذكير ${tasks.length} مهمة — ${today}`,body:'التفاصيل مرفقة PDF',attachments:[blob],name:'OrTec OS'});return {ok:true,count:tasks.length};
}
