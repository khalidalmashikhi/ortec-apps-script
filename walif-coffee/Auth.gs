/**
 * Authentication: salted password hashes in Script Properties, random session tokens with expiry.
 * The Users sheet only holds metadata (never a hash, never a password).
 */

var PW_ITERATIONS_ = 2000;
var SESSION_PREFIX_ = 'WC_SESSION_';
var USER_PREFIX_ = 'WC_USER_';

function hashPassword_(password, salt) {
  var h = salt + ':' + password;
  for (var i = 0; i < PW_ITERATIONS_; i++) h = sha256Hex_(h + salt);
  return h;
}

function setUserPassword_(username, password) {
  var salt = randomToken_(16);
  var rec = { salt: salt, hash: hashPassword_(String(password), salt), updatedAt: fmtDateTime_(now_()) };
  props_().setProperty(USER_PREFIX_ + username, JSON.stringify(rec));
}

function verifyPassword_(username, password) {
  var raw = props_().getProperty(USER_PREFIX_ + username);
  if (!raw) return false;
  var rec = JSON.parse(raw);
  return hashPassword_(String(password), rec.salt) === rec.hash;
}

function findUser_(username) {
  var rows = readRows_(WC.SHEETS.USERS);
  for (var i = 0; i < rows.length; i++) if (String(rows[i].Username) === username) return rows[i];
  return null;
}

function createUser_(username, password, role, displayName, mustChange) {
  username = cleanText_(username, 40).toLowerCase();
  if (!/^[a-z0-9_.-]{2,40}$/.test(username)) throw new Error('اسم مستخدم غير صالح.');
  if (role !== WC.ROLES.MANAGER && role !== WC.ROLES.ACCOUNTANT) throw new Error('دور غير صالح.');
  setUserPassword_(username, password);
  appendObjects_(WC.SHEETS.USERS, [{
    Username: username, Role: role, 'Display Name': cleanText_(displayName, 60) || username, Status: 'ACTIVE',
    'Created At': now_(), 'Last Login': '', 'Must Change Password': mustChange ? 'TRUE' : 'FALSE'
  }]);
}

// ---------------------------------------------------------------- Sessions

function sessionKey_(token) { return SESSION_PREFIX_ + sha256Hex_(String(token)).slice(0, 40); }

function createSession_(user) {
  var token = randomToken_(32);
  var exp = now_().getTime() + WC.SESSION_HOURS * 3600 * 1000;
  var data = { u: String(user.Username), r: String(user.Role), n: String(user['Display Name'] || user.Username), exp: exp };
  var key = sessionKey_(token);
  props_().setProperty(key, JSON.stringify(data));
  try { CacheService.getScriptCache().put(key, JSON.stringify(data), 21600); } catch (e) {}
  return { token: token, exp: exp };
}

function readSession_(token) {
  if (!token) return null;
  var key = sessionKey_(token);
  var raw = null;
  try { raw = CacheService.getScriptCache().get(key); } catch (e) {}
  if (!raw) raw = props_().getProperty(key);
  if (!raw) return null;
  var data;
  try { data = JSON.parse(raw); } catch (e) { return null; }
  if (!data || !data.exp || data.exp < now_().getTime()) { destroySession_(token); return null; }
  return data;
}

function destroySession_(token) {
  if (!token) return;
  var key = sessionKey_(token);
  props_().deleteProperty(key);
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}

function purgeExpiredSessions_() {
  var p = props_(), all = p.getProperties(), t = now_().getTime();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(SESSION_PREFIX_) !== 0) return;
    try { var d = JSON.parse(all[k]); if (!d.exp || d.exp < t) p.deleteProperty(k); } catch (e) { p.deleteProperty(k); }
  });
}

/**
 * Every sensitive server function calls this first. Throws when the token is missing/expired
 * or the role is not allowed. Returns {username, role, displayName}.
 */
function requireSession_(token, roles) {
  var s = readSession_(token);
  if (!s) { var e = new Error('انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى.'); e.code = 'AUTH'; throw e; }
  if (roles && roles.length && roles.indexOf(s.r) < 0) {
    logAudit_({ username: s.u, role: s.r }, 'FORBIDDEN', 'Auth', '', 'attempted a ' + roles.join('/') + '-only action', 'DENIED');
    var f = new Error('ليس لديك صلاحية لتنفيذ هذا الإجراء.'); f.code = 'FORBIDDEN'; throw f;
  }
  return { username: s.u, role: s.r, displayName: s.n, exp: s.exp };
}

// ---------------------------------------------------------------- Public API

function api_login(username, password) {
  username = cleanText_(username, 40).toLowerCase();
  password = String(password == null ? '' : password);
  var actor = { username: username || '?', role: '' };
  if (!username || !password) {
    logAudit_(actor, 'LOGIN', 'Auth', '', 'missing credentials', 'FAILED');
    return { ok: false, error: 'أدخل اسم المستخدم وكلمة المرور.' };
  }
  var user = findUser_(username);
  if (!user || String(user.Status) !== 'ACTIVE' || !verifyPassword_(username, password)) {
    logAudit_(actor, 'LOGIN', 'Auth', '', 'invalid credentials', 'FAILED');
    Utilities.sleep(400); // slow brute force a little
    return { ok: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
  }
  purgeExpiredSessions_();
  var s = createSession_(user);
  updateRowFields_(WC.SHEETS.USERS, user._row, { 'Last Login': now_() });
  logAudit_({ username: username, role: String(user.Role) }, 'LOGIN', 'Auth', '', 'login ok', 'OK');
  return {
    ok: true, token: s.token, exp: s.exp,
    user: { username: username, role: String(user.Role), displayName: String(user['Display Name'] || username),
      mustChangePassword: String(user['Must Change Password']) === 'TRUE' },
    demoPasswordsActive: getSetting_('DEMO_PASSWORDS_ACTIVE') === 'true',
    app: { name: WC.APP_NAME, nameAr: WC.APP_NAME_AR, version: WC.VERSION, currency: WC.CURRENCY }
  };
}

function api_logout(token) {
  var s = readSession_(token);
  if (s) logAudit_({ username: s.u, role: s.r }, 'LOGOUT', 'Auth', '', '', 'OK');
  destroySession_(token);
  return { ok: true };
}

function api_checkSession(token) {
  var s = readSession_(token);
  if (!s) return { ok: false, error: 'انتهت الجلسة.' };
  return { ok: true, user: { username: s.u, role: s.r, displayName: s.n }, exp: s.exp };
}

/** Manager only: change any user's password. */
function api_changePassword(token, targetUsername, newPassword) {
  return apiCall_('api_changePassword', token, [WC.ROLES.MANAGER], function (actor) {
    targetUsername = cleanText_(targetUsername, 40).toLowerCase();
    newPassword = String(newPassword == null ? '' : newPassword);
    var user = findUser_(targetUsername);
    if (!user) throw new Error('المستخدم غير موجود.');
    if (newPassword.length < 6) throw new Error('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
    var isDemo = WC.DEMO_USERS.some(function (u) { return u.username === targetUsername && u.password === newPassword; });
    if (isDemo) throw new Error('لا يمكن استخدام كلمة المرور التجريبية.');
    setUserPassword_(targetUsername, newPassword);
    updateRowFields_(WC.SHEETS.USERS, user._row, { 'Must Change Password': 'FALSE' });
    // Demo flag clears when neither demo password works any more.
    var stillDemo = WC.DEMO_USERS.some(function (u) { return verifyPassword_(u.username, u.password); });
    setSetting_('DEMO_PASSWORDS_ACTIVE', stillDemo ? 'true' : 'false', actor.username);
    logAudit_(actor, 'CHANGE_PASSWORD', 'Users', targetUsername, 'password changed for ' + targetUsername, 'OK');
    return { ok: true, demoPasswordsActive: stillDemo };
  });
}

function api_listUsers(token) {
  return apiCall_('api_listUsers', token, [WC.ROLES.MANAGER], function () {
    return { ok: true, users: readRows_(WC.SHEETS.USERS).map(function (r) {
      return { username: String(r.Username), role: String(r.Role), displayName: String(r['Display Name']), status: String(r.Status),
        lastLogin: r['Last Login'] instanceof Date ? fmtDateTime_(r['Last Login']) : String(r['Last Login'] || ''),
        mustChangePassword: String(r['Must Change Password']) === 'TRUE' };
    }) };
  });
}
