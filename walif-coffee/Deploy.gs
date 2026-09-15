/**
 * Self-deployment through the Apps Script API (needs "Google Apps Script API" ON at
 * https://script.google.com/home/usersettings). Run deployWebApp() from the editor after setupSystem().
 * Creates a new version and creates/updates ONE web-app deployment, so the URL never changes.
 */

var SCRIPT_API_ = 'https://script.googleapis.com/v1/projects/';

function scriptApi_(method, path, payload) {
  var res = UrlFetchApp.fetch(SCRIPT_API_ + ScriptApp.getScriptId() + path, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: payload ? JSON.stringify(payload) : undefined
  });
  var code = res.getResponseCode(), body = res.getContentText();
  if (code === 403 && /not been used|is disabled|PERMISSION_DENIED/.test(body)) {
    throw new Error('فعّل "Google Apps Script API" من https://script.google.com/home/usersettings ثم أعد التشغيل. (' + code + ')');
  }
  if (code < 200 || code >= 300) throw new Error('Apps Script API ' + method + ' ' + path + ' → ' + code + ': ' + body.slice(0, 400));
  return body ? JSON.parse(body) : {};
}

/** Creates a version + web-app deployment (or updates the existing one) and returns the /exec URL. */
function deployWebApp() {
  var desc = WC.APP_NAME + ' v' + WC.VERSION + ' ' + fmtDateTime_(now_());
  var version = scriptApi_('post', '/versions', { description: desc });
  var p = props_();
  var depId = p.getProperty('DEPLOYMENT_ID');
  if (!depId) {
    // Reuse a web-app deployment created earlier (e.g. by clasp) so the public URL never changes.
    var list = scriptApi_('get', '/deployments');
    (list.deployments || []).forEach(function (d) {
      var isHead = !d.deploymentConfig || !d.deploymentConfig.versionNumber;
      var isWeb = (d.entryPoints || []).some(function (ep) { return ep.entryPointType === 'WEB_APP'; });
      if (!depId && !isHead && (isWeb || /Walif/i.test(d.deploymentConfig.description || ''))) depId = d.deploymentId;
    });
  }
  var config = { deploymentConfig: { scriptId: ScriptApp.getScriptId(), versionNumber: version.versionNumber, manifestFileName: 'appsscript', description: desc } };
  var dep = null;
  if (depId) {
    try { dep = scriptApi_('put', '/deployments/' + depId, config); } catch (e) { depId = null; }
  }
  if (!dep) dep = scriptApi_('post', '/deployments', config.deploymentConfig);
  depId = dep.deploymentId;
  p.setProperty('DEPLOYMENT_ID', depId);
  // Entry points may only be populated on GET.
  var full = scriptApi_('get', '/deployments/' + depId);
  var url = '';
  (full.entryPoints || dep.entryPoints || []).forEach(function (ep) { if (ep.webApp && ep.webApp.url) url = ep.webApp.url; });
  if (!url) url = 'https://script.google.com/macros/s/' + depId + '/exec';
  p.setProperty('WEBAPP_URL', url);
  logAudit_({ username: 'system', role: 'system' }, 'DEPLOY', 'System', depId, 'version ' + version.versionNumber + ' → ' + url, 'OK');
  Logger.log('✅ Web App URL: ' + url + '\nVersion: ' + version.versionNumber + '\nDeployment: ' + depId + '\nSheet: ' + ss_().getUrl());
  return url;
}

/** Prints the links a manager needs. */
function showLinks() {
  var out = 'Sheet:   ' + ss_().getUrl() + '\nWeb App: ' + (props_().getProperty('WEBAPP_URL') || '(run deployWebApp first)');
  Logger.log(out);
  return out;
}
