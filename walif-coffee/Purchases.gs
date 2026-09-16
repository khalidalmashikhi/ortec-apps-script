/**
 * Purchase invoices.
 */

/**
 * Simple entry: only description ("what did you buy"), amount and payment method are required.
 * Missing fields get sensible defaults: today's date, auto invoice number, supplier "غير محدد",
 * category "مخزون آخر" (inventory), paid in full.
 */
function validatePurchase_(p) {
  var out = {};
  var blank = function (v) { return v === undefined || v === null || String(v).trim() === ''; };
  out['Invoice Number'] = cleanText_(p.invoiceNumber, 60) || 'AUTO-' + fmtDate_(now_(), 'yyyyMMdd-HHmmss');
  out['Invoice Date'] = dateCell_(blank(p.invoiceDate) ? todayStr_() : p.invoiceDate);
  out.Supplier = cleanText_(p.supplier, 120) || 'غير محدد';
  out.Category = cleanText_(p.category, 60) || 'مخزون آخر';
  out.Description = cleanText_(p.description, 500);
  out.Subtotal = round3_(blank(p.subtotal) ? p.amount : p.subtotal);
  out.Tax = round3_(p.tax);
  out.Discount = round3_(p.discount);
  out.Total = round3_(out.Subtotal + out.Tax - out.Discount);
  out['Paid Amount'] = blank(p.paidAmount) ? out.Total : round3_(p.paidAmount);
  out['Remaining Amount'] = round3_(out.Total - out['Paid Amount']);
  out['Payment Method'] = cleanText_(p.paymentMethod, 30) || 'نقد';
  out['Payment Status'] = cleanText_(p.paymentStatus, 30);
  var isInv = blank(p.isInventory) ? WC.INVENTORY_CATEGORIES.indexOf(out.Category) >= 0
    : (p.isInventory === true || String(p.isInventory).toLowerCase() === 'true' || String(p.isInventory) === 'نعم');
  out['Is Inventory'] = isInv ? 'نعم' : 'لا';
  out.Notes = cleanText_(p.notes, 1000);

  if (!out['Invoice Date']) throw new Error('تاريخ الفاتورة غير صالح.');
  if (!out.Description && out.Supplier === 'غير محدد') throw new Error('اكتب ماذا اشتريت.');
  if (WC.PURCHASE_CATEGORIES.indexOf(out.Category) < 0) throw new Error('تصنيف المشتريات غير صالح.');
  if (out.Subtotal < 0 || out.Tax < 0 || out.Discount < 0) throw new Error('المبالغ لا يمكن أن تكون سالبة.');
  if (out.Total <= 0) throw new Error('إجمالي الفاتورة يجب أن يكون أكبر من صفر.');
  if (out['Paid Amount'] < 0 || out['Paid Amount'] > out.Total + 0.0005) throw new Error('المبلغ المدفوع غير صالح.');
  if (WC.PAYMENT_METHODS.indexOf(out['Payment Method']) < 0) throw new Error('طريقة الدفع غير صالحة.');
  // Derive/validate status against amounts.
  var expected = out['Paid Amount'] >= out.Total - 0.0005 ? 'مدفوعة' : (out['Paid Amount'] > 0 ? 'مدفوعة جزئيًا' : 'غير مدفوعة');
  if (WC.PURCHASE_PAYMENT_STATUS.indexOf(out['Payment Status']) < 0) out['Payment Status'] = expected;
  if (out['Payment Status'] !== expected) throw new Error('حالة الدفع لا تطابق المبلغ المدفوع (المتوقع: ' + expected + ').');
  out['Dedupe Key'] = [out.Supplier.toLowerCase(), out['Invoice Number'].toLowerCase(), out['Invoice Date'], money_(out.Total)].join('|');
  return out;
}

function api_addPurchase(token, payload, attachment) {
  return apiCall_('api_addPurchase', token, null, function (actor) {
    var fields = validatePurchase_(payload || {});
    return withLock_(function () {
      var dup = readRows_(WC.SHEETS.PURCHASES).some(function (r) {
        return String(r['Record Status']) === WC.STATUS.ACTIVE && String(r['Dedupe Key']).replace(/^'/, '') === fields['Dedupe Key'];
      });
      if (dup) throw new Error('هذه الفاتورة مسجلة مسبقًا (نفس المورد ورقم الفاتورة والتاريخ والإجمالي).');
      var att = saveAttachment_(attachment, parseDateOnly_(fields['Invoice Date']), 'INV-' + fields['Invoice Number'].replace(/[^\w-]/g, '_'));
      fields['Attachment URL'] = att.url; fields['Attachment ID'] = att.id;
      var row = entryRow_(actor.username, fields, 'PUR');
      appendObjects_(WC.SHEETS.PURCHASES, [row]);
      logAudit_(actor, 'ADD_PURCHASE', 'Purchases', row['Internal ID'], 'supplier=' + fields.Supplier + ' total=' + money_(fields.Total) + (att.url ? ' +attachment' : ''), 'OK');
      return { ok: true, id: row['Internal ID'], attachmentUrl: att.url, total: fields.Total, remaining: fields['Remaining Amount'] };
    });
  });
}

function api_listPurchases(token, filters) {
  return apiCall_('api_listPurchases', token, null, function (actor) {
    return { ok: true, rows: listEntries_(WC.SHEETS.PURCHASES, actor, filters, 'Invoice Date') };
  });
}
