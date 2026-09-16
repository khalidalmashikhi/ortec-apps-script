/**
 * Walif Coffee one-shot installer.
 * 1) Project Settings → tick "Show appsscript.json manifest file in editor", replace its content with installer/appsscript.json
 * 2) Replace Code.gs with THIS file, save, run installWalifCoffee(), approve the permissions.
 * 3) Reload the editor: all project files are now in place. Then run setupSystem(), then deployWebApp().
 *
 * Requires "Google Apps Script API" ON at https://script.google.com/home/usersettings
 */
var WC_SOURCE_ = 'https://raw.githubusercontent.com/khalidalmashikhi/ortec-apps-script/claude/nice-tesla-lc2heo/walif-coffee/';
var WC_FILES_ = [
  'appsscript.json',
  'Config.gs', 'Utils.gs', 'Code.gs', 'Setup.gs', 'Auth.gs', 'Audit.gs', 'SalesImport.gs', 'Attachments.gs', 'Purchases.gs',
  'Expenses.gs', 'Payroll.gs', 'Rent.gs', 'Withdrawals.gs', 'Records.gs', 'Analytics.gs', 'Reports.gs', 'EmailReports.gs', 'Settings.gs', 'Deploy.gs', 'Tests.gs',
  'Index.html', 'Login.html', 'Accountant.html', 'Dashboard.html', 'Styles.html', 'Scripts.html'
];

function installWalifCoffee() {
  var files = WC_FILES_.map(function (name) {
    var res = UrlFetchApp.fetch(WC_SOURCE_ + name + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('تعذر تنزيل ' + name + ' (' + res.getResponseCode() + ')');
    var base = name.replace(/\.(gs|html|json)$/, '');
    var type = /\.gs$/.test(name) ? 'SERVER_JS' : (/\.html$/.test(name) ? 'HTML' : 'JSON');
    return { name: base, type: type, source: res.getContentText() };
  });
  var url = 'https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + '/content';
  var res = UrlFetchApp.fetch(url, {
    method: 'put', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify({ files: files })
  });
  var code = res.getResponseCode();
  if (code === 403) throw new Error('فعّل "Google Apps Script API" من https://script.google.com/home/usersettings ثم أعد التشغيل.\n' + res.getContentText().slice(0, 300));
  if (code !== 200) throw new Error('فشل التثبيت (' + code + '): ' + res.getContentText().slice(0, 500));
  Logger.log('✅ تم تثبيت ' + files.length + ' ملفًا. أعد تحميل صفحة المحرر، ثم شغّل setupSystem() ثم deployWebApp().');
  return files.length;
}
