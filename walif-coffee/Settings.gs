/**
 * Manager settings (e-mail report configuration). Accountants never see these.
 */

function publicSettings_() {
  var s = getAllSettings_();
  return {
    reportEmail: s.REPORT_EMAIL, reportHour: toNum_(s.REPORT_HOUR), reportEnabled: s.REPORT_ENABLED === 'true', reportMode: s.REPORT_MODE || 'previous_day',
    demoPasswordsActive: s.DEMO_PASSWORDS_ACTIVE === 'true', trigger: triggerInfo_(), timezone: WC.TZ, version: WC.VERSION,
    brand: brand_(), brandRaw: { logoUrl: String(s.BRAND_LOGO_URL || '') }
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

/** Manager: white-label identity (name, logo words, colours, currency). */
function api_saveBrand(token, b) {
  return apiCall_('api_saveBrand', token, [WC.ROLES.MANAGER], function (actor) {
    b = b || {};
    var name = cleanText_(b.name, 60), nameAr = cleanText_(b.nameAr, 60);
    if (!name || !nameAr) throw new Error('اسم المحل مطلوب بالعربية والإنجليزية.');
    var hex = function (v) { v = cleanText_(v, 7); if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error('اللون يجب أن يكون بصيغة #RRGGBB.'); return v.toLowerCase(); };
    var logo = cleanText_(b.logoUrl, 500);
    if (logo && !/^https:\/\//.test(logo)) throw new Error('رابط الشعار يجب أن يبدأ بـ https://');
    var currency = cleanText_(b.currency, 8).toUpperCase() || 'OMR';
    var vals = { BRAND_NAME: name, BRAND_NAME_AR: nameAr, BRAND_SHORT: cleanText_(b.short, 14).toUpperCase() || name.split(' ')[0].toUpperCase(), BRAND_SHORT_AR: cleanText_(b.shortAr, 14),
      BRAND_TAGLINE: cleanText_(b.tagline, 40).toUpperCase(), BRAND_PRIMARY: hex(b.primary), BRAND_CREAM: hex(b.cream), BRAND_LOGO_URL: logo, CURRENCY: currency };
    return withLock_(function () {
      Object.keys(vals).forEach(function (k) { setSetting_(k, vals[k], actor.username); });
      logAudit_(actor, 'CHANGE_SETTINGS', 'Settings', '', 'brand updated: ' + name + ' / ' + nameAr, 'OK');
      return { ok: true, brand: brand_() };
    });
  });
}
