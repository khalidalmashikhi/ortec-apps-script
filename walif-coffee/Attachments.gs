/**
 * Attachment upload: validates type/size, stores under  Walif Coffee Accounting/Invoices/YYYY/MM.
 * Client sends {name, mimeType, base64}.
 */

function saveAttachment_(file, dateForFolder, prefix) {
  if (!file || !file.base64) return { url: '', id: '' };
  var name = cleanText_(file.name, 120) || 'attachment';
  var ext = (name.split('.').pop() || '').toLowerCase();
  var mime = String(file.mimeType || '').toLowerCase();
  if (WC.ALLOWED_ATTACHMENT_EXT.indexOf(ext) < 0) throw new Error('نوع المرفق غير مسموح. المسموح: PDF, JPG, JPEG, PNG');
  if (mime && WC.ALLOWED_ATTACHMENT_TYPES.indexOf(mime) < 0) throw new Error('نوع الملف غير مسموح (' + mime + ').');
  var b64 = String(file.base64).replace(/^data:[^;]+;base64,/, '');
  var approxBytes = Math.floor(b64.length * 3 / 4);
  if (approxBytes > WC.MAX_ATTACHMENT_BYTES) throw new Error('حجم المرفق يتجاوز الحد المسموح (' + Math.round(WC.MAX_ATTACHMENT_BYTES / 1024 / 1024) + ' MB).');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length > WC.MAX_ATTACHMENT_BYTES) throw new Error('حجم المرفق يتجاوز الحد المسموح.');
  if (!mime) mime = ext === 'pdf' ? 'application/pdf' : (ext === 'png' ? 'image/png' : 'image/jpeg');
  var folder = monthlyFolder_('INVOICES_FOLDER_ID', dateForFolder || now_());
  var safeName = (prefix ? prefix + '-' : '') + fmtDate_(now_(), 'yyyyMMdd-HHmmss') + '.' + ext;
  var blob = Utilities.newBlob(bytes, mime, safeName);
  var f = folder.createFile(blob);
  return { url: f.getUrl(), id: f.getId() };
}
