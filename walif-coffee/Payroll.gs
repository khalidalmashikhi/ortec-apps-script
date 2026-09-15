/**
 * Payroll.  Net = Basic + Allowance + Overtime − Deduction − Advance
 */

function validatePayroll_(p) {
  var out = {};
  out.Employee = cleanText_(p.employee, 120);
  out.Month = cleanText_(p.month, 7);
  out['Basic Salary'] = round3_(p.basicSalary);
  out.Allowance = round3_(p.allowance);
  out.Overtime = round3_(p.overtime);
  out.Deduction = round3_(p.deduction);
  out.Advance = round3_(p.advance);
  out['Net Salary'] = round3_(out['Basic Salary'] + out.Allowance + out.Overtime - out.Deduction - out.Advance);
  out['Payment Date'] = dateCell_(p.paymentDate);
  out['Payment Method'] = cleanText_(p.paymentMethod, 30);
  out['Payment Status'] = cleanText_(p.paymentStatus, 30);
  out.Notes = cleanText_(p.notes, 1000);
  if (!out.Employee) throw new Error('اسم العامل مطلوب.');
  if (!/^\d{4}-\d{2}$/.test(out.Month)) throw new Error('الشهر يجب أن يكون بصيغة YYYY-MM.');
  if (out['Basic Salary'] < 0 || out.Allowance < 0 || out.Overtime < 0 || out.Deduction < 0 || out.Advance < 0) throw new Error('القيم لا يمكن أن تكون سالبة.');
  if (out['Net Salary'] < 0) throw new Error('صافي الراتب سالب، راجع الخصم والسلفة.');
  if (WC.SIMPLE_PAYMENT_STATUS.indexOf(out['Payment Status']) < 0) throw new Error('حالة الدفع غير صالحة.');
  if (out['Payment Status'] === 'مدفوع') {
    if (!out['Payment Date']) throw new Error('تاريخ الدفع مطلوب للراتب المدفوع.');
    if (WC.PAYMENT_METHODS.indexOf(out['Payment Method']) < 0) throw new Error('طريقة الدفع غير صالحة.');
  }
  return out;
}

function api_addPayroll(token, payload) {
  return apiCall_('api_addPayroll', token, null, function (actor) {
    var fields = validatePayroll_(payload || {});
    return withLock_(function () {
      var dup = readRows_(WC.SHEETS.PAYROLL).some(function (r) {
        return String(r['Record Status']) === WC.STATUS.ACTIVE && String(r.Employee).toLowerCase() === fields.Employee.toLowerCase() && ymCell_(r.Month) === fields.Month;
      });
      if (dup) throw new Error('يوجد راتب مسجل لهذا العامل في الشهر نفسه.');
      var row = entryRow_(actor.username, fields, 'PAY');
      appendObjects_(WC.SHEETS.PAYROLL, [row]);
      logAudit_(actor, 'ADD_PAYROLL', 'Payroll', row['Internal ID'], fields.Employee + ' ' + fields.Month + ' net=' + money_(fields['Net Salary']), 'OK');
      return { ok: true, id: row['Internal ID'], netSalary: fields['Net Salary'] };
    });
  });
}

function api_listPayroll(token, filters) {
  return apiCall_('api_listPayroll', token, null, function (actor) {
    return { ok: true, rows: listEntries_(WC.SHEETS.PAYROLL, actor, filters, 'Payment Date') };
  });
}
