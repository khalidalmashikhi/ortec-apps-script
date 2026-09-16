/**
 * Cash withdrawals: cash taken out of the till/drawer, with where it went
 * (deposited in the bank, used for expenses, other) and a photo/receipt.
 *
 * Cash effect: a deposit to the bank is an internal transfer (no change to the overall balance);
 * "expenses" / "other" leave the business and reduce the cash movement once.
 * Expenses later paid out of that cash are entered with payment method "كاش مسحوب" so they
 * count in profit & loss but are never subtracted from cash a second time.
 */

function validateWithdrawal_(p) {
  var out = {};
  out['Withdrawal Date'] = dateCell_(p.withdrawalDate);
  out.Amount = round3_(p.amount);
  out.Destination = cleanText_(p.destination, 40);
  out.Description = cleanText_(p.description, 500);
  out.Notes = cleanText_(p.notes, 1000);
  if (!out['Withdrawal Date']) throw new Error('تاريخ السحب غير صالح.');
  if (out['Withdrawal Date'] > todayStr_()) throw new Error('تاريخ السحب لا يمكن أن يكون في المستقبل.');
  if (!(out.Amount > 0)) throw new Error('المبلغ يجب أن يكون أكبر من صفر.');
  if (WC.WITHDRAWAL_DESTINATIONS.indexOf(out.Destination) < 0) throw new Error('وجهة السحب غير صالحة.');
  if (!out.Description) throw new Error('البيان مطلوب.');
  return out;
}

function api_addWithdrawal(token, payload, attachment) {
  return apiCall_('api_addWithdrawal', token, null, function (actor) {
    var fields = validateWithdrawal_(payload || {});
    return withLock_(function () {
      var att = saveAttachment_(attachment, parseDateOnly_(fields['Withdrawal Date']), 'CASH');
      fields['Attachment URL'] = att.url; fields['Attachment ID'] = att.id;
      var row = entryRow_(actor.username, fields, 'CASH');
      appendObjects_(WC.SHEETS.WITHDRAWALS, [row]);
      logAudit_(actor, 'ADD_WITHDRAWAL', 'Cash_Withdrawals', row['Internal ID'], fields.Destination + ' ' + money_(fields.Amount), 'OK');
      return { ok: true, id: row['Internal ID'], attachmentUrl: att.url };
    });
  });
}

function api_listWithdrawals(token, filters) {
  return apiCall_('api_listWithdrawals', token, null, function (actor) {
    return { ok: true, rows: listEntries_(WC.SHEETS.WITHDRAWALS, actor, filters, 'Withdrawal Date') };
  });
}
