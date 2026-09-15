/**
 * Shop rent.
 */

function validateRent_(p) {
  var out = {};
  out.Period = cleanText_(p.period, 40);
  out.Landlord = cleanText_(p.landlord, 120);
  out.Amount = round3_(p.amount);
  out['Due Date'] = dateCell_(p.dueDate);
  out['Payment Date'] = dateCell_(p.paymentDate);
  out['Payment Method'] = cleanText_(p.paymentMethod, 30);
  out.Status = cleanText_(p.status, 30);
  out.Notes = cleanText_(p.notes, 1000);
  if (!out.Period) throw new Error('الشهر أو الفترة مطلوب.');
  if (!out.Landlord) throw new Error('اسم المؤجر مطلوب.');
  if (!(out.Amount > 0)) throw new Error('قيمة الإيجار يجب أن تكون أكبر من صفر.');
  if (!out['Due Date']) throw new Error('تاريخ الاستحقاق غير صالح.');
  if (WC.RENT_STATUS.indexOf(out.Status) < 0) throw new Error('حالة الإيجار غير صالحة.');
  if (out.Status === 'مدفوع') {
    if (!out['Payment Date']) throw new Error('تاريخ الدفع مطلوب للإيجار المدفوع.');
    if (WC.PAYMENT_METHODS.indexOf(out['Payment Method']) < 0) throw new Error('طريقة الدفع غير صالحة.');
  } else if (out['Payment Method'] && WC.PAYMENT_METHODS.indexOf(out['Payment Method']) < 0) {
    out['Payment Method'] = '';
  }
  return out;
}

function api_addRent(token, payload, attachment) {
  return apiCall_('api_addRent', token, null, function (actor) {
    var fields = validateRent_(payload || {});
    return withLock_(function () {
      var att = saveAttachment_(attachment, parseDateOnly_(fields['Due Date']), 'RENT');
      fields['Attachment URL'] = att.url; fields['Attachment ID'] = att.id;
      var row = entryRow_(actor.username, fields, 'RNT');
      appendObjects_(WC.SHEETS.RENT, [row]);
      logAudit_(actor, 'ADD_RENT', 'Rent', row['Internal ID'], fields.Period + ' ' + money_(fields.Amount) + ' ' + fields.Status, 'OK');
      return { ok: true, id: row['Internal ID'], attachmentUrl: att.url };
    });
  });
}

function api_listRent(token, filters) {
  return apiCall_('api_listRent', token, null, function (actor) {
    return { ok: true, rows: listEntries_(WC.SHEETS.RENT, actor, filters, 'Due Date') };
  });
}
