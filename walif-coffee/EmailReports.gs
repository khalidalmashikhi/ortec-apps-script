/**
 * Daily e-mail report + trigger management.
 */

var DAILY_JOB_ = 'sendDailyReportJob';

/** Trigger entry point. Never throws; failures go to Error_Log. */
function sendDailyReportJob() {
  var actor = { username: 'system-trigger', role: 'system' };
  try {
    var s = getAllSettings_();
    if (s.REPORT_ENABLED !== 'true') { logAudit_(actor, 'SEND_EMAIL', 'Reports', '', 'daily report disabled — skipped', 'SKIPPED'); return; }
    if (!s.REPORT_EMAIL) { logAudit_(actor, 'SEND_EMAIL', 'Reports', '', 'no recipient configured — skipped', 'SKIPPED'); return; }
    var date = s.REPORT_MODE === 'today' ? todayStr_() : fmtDate_(addDays_(parseDateOnly_(todayStr_()), -1));
    var res = sendDailyReport_(actor, s.REPORT_EMAIL, date, s.REPORT_MODE === 'today');
    logAudit_(actor, 'SEND_EMAIL', 'Reports', res.fileId, 'daily report ' + date + ' → ' + s.REPORT_EMAIL, 'OK');
  } catch (err) {
    logError_(DAILY_JOB_, actor, err, '');
    logAudit_(actor, 'SEND_EMAIL', 'Reports', '', 'failed: ' + (err && err.message), 'FAILED');
  }
}

function sendDailyReport_(actor, to, date, partialDay) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) throw new Error('بريد المستلم غير صالح.');
  var b = brand_();
  var rep = buildReport_('daily', date, date);
  var pdf = renderReportPdf_(rep);
  var bank = bankBalance_();
  var k = {};
  rep.kpis.forEach(function (r) { k[r[0]] = r[1]; });
  var row = function (label) {
    var v = k[label]; var txt = typeof v === 'number' && label.indexOf('عدد') < 0 && label.indexOf('%') < 0 ? money_(v) + ' ' + b.currency : String(v);
    return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">' + escapeHtml_(label) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold">' + escapeHtml_(txt) + '</td></tr>';
  };
  var html = '<div dir="rtl" style="font-family:Arial,Tahoma,sans-serif;color:#1f2d27;max-width:560px">' +
    '<h2 style="color:' + b.primary + ';margin:0 0 4px">' + escapeHtml_(b.nameAr) + ' — ' + escapeHtml_(rep.title) + '</h2>' +
    '<p style="margin:0 0 12px;color:#6b7a72">' + escapeHtml_(rep.subtitle) + (partialDay ? ' (حتى وقت الإرسال)' : '') + '</p>' +
    '<table style="border-collapse:collapse;width:100%;background:#fff">' +
    ['صافي المبيعات', 'تكلفة البضاعة المباعة', 'مجمل الربح', 'المشتريات المدفوعة', 'المصروفات', 'الرواتب المدفوعة', 'الإيجار المدفوع', 'صافي الربح التشغيلي', 'صافي الحركة النقدية', 'عدد الفواتير', 'متوسط الفاتورة'].map(row).join('') +
    (bank.configured ? '<tr><td style="padding:8px 10px;background:' + b.cream + ';font-weight:bold">رصيد الحساب البنكي (حتى ' + escapeHtml_(bank.asOf) + ')</td><td style="padding:8px 10px;background:' + b.cream + ';font-weight:bold">' + money_(bank.balance) + ' ' + b.currency + '</td></tr>' : '') +
    '</table>' +
    (rep.notes.length ? '<p style="margin-top:12px"><b>ملاحظات:</b><br>' + rep.notes.map(escapeHtml_).join('<br>') + '</p>' : '') +
    '<p style="color:#8a9690;font-size:12px;margin-top:16px">التقرير الكامل مرفق بصيغة PDF. رابط الملف: <a href="' + escapeHtml_(pdf.url) + '">' + escapeHtml_(pdf.name) + '</a></p></div>';
  MailApp.sendEmail({
    to: to, subject: b.nameAr + ' — التقرير اليومي ' + date, htmlBody: html, name: b.name, attachments: [pdf.blob]
  });
  return { fileId: pdf.fileId, url: pdf.url, name: pdf.name };
}

// ---------------------------------------------------------------- trigger

function rebuildDailyTrigger_(hour) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === DAILY_JOB_) ScriptApp.deleteTrigger(t); });
  hour = Math.min(Math.max(Math.floor(toNum_(hour)), 0), 23);
  ScriptApp.newTrigger(DAILY_JOB_).timeBased().everyDays(1).atHour(hour).inTimezone(WC.TZ).create();
  return hour;
}

function triggerInfo_() {
  var found = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === DAILY_JOB_; });
  return { exists: found.length > 0, count: found.length };
}

// ---------------------------------------------------------------- API (manager)

function api_sendTestReport(token, date) {
  return apiCall_('api_sendTestReport', token, [WC.ROLES.MANAGER], function (actor) {
    var s = getAllSettings_();
    if (!s.REPORT_EMAIL) throw new Error('أدخل بريد المستلم في الإعدادات أولًا واحفظه.');
    var d = parseDateOnly_(date) ? cleanText_(date, 10) : (s.REPORT_MODE === 'today' ? todayStr_() : fmtDate_(addDays_(parseDateOnly_(todayStr_()), -1)));
    var res = sendDailyReport_(actor, s.REPORT_EMAIL, d, false);
    logAudit_(actor, 'SEND_EMAIL', 'Reports', res.fileId, 'test report ' + d + ' → ' + s.REPORT_EMAIL, 'OK');
    return { ok: true, sentTo: s.REPORT_EMAIL, date: d, url: res.url, remainingQuota: safeQuota_() };
  });
}

function safeQuota_() { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return null; } }

function api_rebuildTrigger(token) {
  return apiCall_('api_rebuildTrigger', token, [WC.ROLES.MANAGER], function (actor) {
    var hour = rebuildDailyTrigger_(getSetting_('REPORT_HOUR'));
    logAudit_(actor, 'CREATE_TRIGGER', 'Settings', '', 'daily trigger at ' + hour + ':00 ' + WC.TZ, 'OK');
    return { ok: true, hour: hour, trigger: triggerInfo_() };
  });
}
