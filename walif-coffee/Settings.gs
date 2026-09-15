/**
 * Manager settings (e-mail report configuration). Accountants never see these.
 */

function publicSettings_() {
  var s = getAllSettings_();
  return {
    reportEmail: s.REPORT_EMAIL, reportHour: toNum_(s.REPORT_HOUR), reportEnabled: s.REPORT_ENABLED === 'true', reportMode: s.REPORT_MODE || 'previous_day',
    demoPasswordsActive: s.DEMO_PASSWORDS_ACTIVE === 'true', trigger: triggerInfo_(), timezone: WC.TZ, version: WC.VERSION
  };
}

function api_getSettings(token) {
  return apiCall_('api_getSettings', token, [WC.ROLES.MANAGER], function () {
    return { ok: true, settings: publicSettings_() };
  });
}

function api_saveSettings(token, s) {
  return apiCall_('api_saveSettings', token, [WC.ROLES.MANAGER], function (actor) {
    s = s || {};
    var email = cleanText_(s.reportEmail, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('البريد الإلكتروني غير صالح.');
    var hour = Math.floor(toNum_(s.reportHour));
    if (hour < 0 || hour > 23) throw new Error('ساعة الإرسال يجب أن تكون بين 0 و 23.');
    var enabled = s.reportEnabled === true || String(s.reportEnabled) === 'true';
    if (enabled && !email) throw new Error('لا يمكن تفعيل الإرسال اليومي بدون بريد مستلم.');
    var mode = String(s.reportMode) === 'today' ? 'today' : 'previous_day';
    return withLock_(function () {
      setSetting_('REPORT_EMAIL', email, actor.username);
      setSetting_('REPORT_HOUR', String(hour), actor.username);
      setSetting_('REPORT_ENABLED', enabled ? 'true' : 'false', actor.username);
      setSetting_('REPORT_MODE', mode, actor.username);
      var trig = null;
      if (enabled) { rebuildDailyTrigger_(hour); trig = triggerInfo_(); logAudit_(actor, 'CREATE_TRIGGER', 'Settings', '', 'daily trigger at ' + hour + ':00', 'OK'); }
      logAudit_(actor, 'CHANGE_SETTINGS', 'Settings', '', 'email=' + email + ' hour=' + hour + ' enabled=' + enabled + ' mode=' + mode, 'OK');
      return { ok: true, settings: publicSettings_() };
    });
  });
}
