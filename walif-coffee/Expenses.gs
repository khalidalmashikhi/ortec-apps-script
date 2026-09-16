/**
 * Operating expenses.
 */

function validateExpense_(p) {
  var out = {};
  out['Expense Date'] = dateCell_(p.expenseDate === undefined || p.expenseDate === null || String(p.expenseDate).trim() === '' ? todayStr_() : p.expenseDate);
  out['Expense Type'] = cleanText_(p.expenseType, 60) || 'أخرى';
  out.Description = cleanText_(p.description, 500);
  out.Amount = round3_(p.amount);
  out['Payment Method'] = cleanText_(p.paymentMethod, 30) || 'نقد';
  out.Payee = cleanText_(p.payee, 120);
  out['Payment Status'] = cleanText_(p.paymentStatus, 30) || 'مدفوع';
  out.Notes = cleanText_(p.notes, 1000);
  if (!out['Expense Date']) throw new Error('تاريخ المصروف غير صالح.');
  if (WC.EXPENSE_TYPES.indexOf(out['Expense Type']) < 0) throw new Error('نوع المصروف غير صالح.');
  if (!out.Description) throw new Error('اكتب ما هو المصروف.');
  if (!(out.Amount > 0)) throw new Error('المبلغ يجب أن يكون أكبر من صفر.');
  if (WC.PAYMENT_METHODS.indexOf(out['Payment Method']) < 0) throw new Error('طريقة الدفع غير صالحة.');
  if (WC.SIMPLE_PAYMENT_STATUS.indexOf(out['Payment Status']) < 0) throw new Error('حالة الدفع غير صالحة.');
  return out;
}

function api_addExpense(token, payload, attachment) {
  return apiCall_('api_addExpense', token, null, function (actor) {
    var fields = validateExpense_(payload || {});
    return withLock_(function () {
      var att = saveAttachment_(attachment, parseDateOnly_(fields['Expense Date']), 'EXP');
      fields['Attachment URL'] = att.url; fields['Attachment ID'] = att.id;
      var row = entryRow_(actor.username, fields, 'EXP');
      appendObjects_(WC.SHEETS.EXPENSES, [row]);
      logAudit_(actor, 'ADD_EXPENSE', 'Expenses', row['Internal ID'], fields['Expense Type'] + ' ' + money_(fields.Amount), 'OK');
      return { ok: true, id: row['Internal ID'], attachmentUrl: att.url };
    });
  });
}

function api_listExpenses(token, filters) {
  return apiCall_('api_listExpenses', token, null, function (actor) {
    return { ok: true, rows: listEntries_(WC.SHEETS.EXPENSES, actor, filters, 'Expense Date') };
  });
}
