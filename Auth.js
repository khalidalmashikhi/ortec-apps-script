var ORTEC_RUNTIME_USER_ = null;

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + '|' + String(password),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    const value = (b + 256) % 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function normalizeUsername_(value) {
  return String(value || '').trim().toLowerCase();
}

function safeDateString_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, ORTEC.TZ || 'Asia/Muscat', "yyyy-MM-dd'T'HH:mm:ss");
  return String(value);
}

function publicUser_(user) {
  if (!user) return null;
  return {
    user_id: String(user.user_id || ''), username: String(user.username || ''),
    email: String(user.email || ''), name_ar: String(user.name_ar || ''), name_en: String(user.name_en || ''),
    role: String(user.role || ''), branch_id: String(user.branch_id || 'ALL'), language: String(user.language || 'ar'),
    active: String(user.active).toLowerCase() !== 'false',
    must_change_password: String(user.must_change_password).toLowerCase() === 'true',
    last_login: safeDateString_(user.last_login)
  };
}

function login(username, password, rememberMe) {
  const normalized = normalizeUsername_(username);
  if (!normalized || !password) throw new Error('أدخل اسم المستخدم وكلمة المرور.');

  const user = sheetToObjects_(ORTEC.SHEETS.USERS)
    .find(function(row) { return normalizeUsername_(row.username) === normalized; });

  if (!user || String(user.active).toLowerCase() === 'false') {
    auditAuth_(normalized, 'LOGIN_FAILED', 'USER_NOT_FOUND_OR_DISABLED');
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  }

  const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
  if (lockedUntil && !isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > Date.now()) {
    throw new Error('الحساب مقفل مؤقتًا بسبب محاولات دخول متكررة.');
  }

  const expected = String(user.password_hash || '');
  const actual = hashPassword_(password, user.password_salt || '');
  if (!expected || expected !== actual) {
    const attempts = (Number(user.failed_attempts) || 0) + 1;
    const patch = { failed_attempts: attempts };
    if (attempts >= 5) {
      patch.locked_until = Utilities.formatDate(new Date(Date.now() + 15 * 60 * 1000), ORTEC.TZ, "yyyy-MM-dd'T'HH:mm:ss");
      patch.failed_attempts = 0;
    }
    updateById_(ORTEC.SHEETS.USERS, 'user_id', user.user_id, patch);
    auditAuth_(normalized, 'LOGIN_FAILED', 'BAD_PASSWORD');
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة.');
  }

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const ttlSeconds = rememberMe ? 21600 : 7200;
  const session = {
    user_id: user.user_id,
    username: user.username,
    created_at: nowIso_(),
    expires_at: Date.now() + ttlSeconds * 1000
  };
  CacheService.getScriptCache().put('session:' + token, JSON.stringify(session), ttlSeconds);

  updateById_(ORTEC.SHEETS.USERS, 'user_id', user.user_id, {
    failed_attempts: 0,
    locked_until: '',
    last_login: nowIso_()
  });
  ORTEC_RUNTIME_USER_ = user;
  audit_('AUTH', user.user_id, 'LOGIN', null, { username: user.username });

  return JSON.parse(JSON.stringify({ ok: true, token: String(token), user: publicUser_(user), expiresIn: Number(ttlSeconds) }));
}

function logout(sessionToken) {
  const user = resolveSessionUser_(sessionToken, false);
  if (sessionToken) CacheService.getScriptCache().remove('session:' + sessionToken);
  if (user) {
    ORTEC_RUNTIME_USER_ = user;
    audit_('AUTH', user.user_id, 'LOGOUT', null, { username: user.username });
  }
  ORTEC_RUNTIME_USER_ = null;
  return { ok: true };
}

function resolveSessionUser_(sessionToken, required) {
  if (ORTEC_RUNTIME_USER_) return ORTEC_RUNTIME_USER_;
  const token = String(sessionToken || '').trim();
  if (!token) {
    if (required !== false) throw new Error('انتهت جلسة الدخول. سجّل الدخول من جديد.');
    return null;
  }
  const raw = CacheService.getScriptCache().get('session:' + token);
  if (!raw) {
    if (required !== false) throw new Error('انتهت جلسة الدخول. سجّل الدخول من جديد.');
    return null;
  }
  const session = JSON.parse(raw);
  if (!session.expires_at || Number(session.expires_at) < Date.now()) {
    CacheService.getScriptCache().remove('session:' + token);
    if (required !== false) throw new Error('انتهت جلسة الدخول. سجّل الدخول من جديد.');
    return null;
  }
  const user = findBy_(ORTEC.SHEETS.USERS, 'user_id', session.user_id);
  if (!user || String(user.active).toLowerCase() === 'false') {
    if (required !== false) throw new Error('الحساب غير متاح.');
    return null;
  }
  ORTEC_RUNTIME_USER_ = user;
  return user;
}

function getCurrentUser(sessionToken) {
  return resolveSessionUser_(sessionToken, true);
}

function requireRole_(allowed, sessionToken) {
  const user = getCurrentUser(sessionToken);
  if (allowed.indexOf(String(user.role)) === -1) throw new Error('ليس لديك صلاحية لتنفيذ هذه العملية.');
  return user;
}

function listUsers(sessionToken) {
  requireRole_(['OWNER','ADMIN'], sessionToken);
  return sheetToObjects_(ORTEC.SHEETS.USERS).map(publicUser_);
}

function saveUser(input, sessionToken) {
  const actor = requireRole_(['OWNER','ADMIN'], sessionToken);
  input = input || {};
  const username = normalizeUsername_(input.username);
  if (!username) throw new Error('اسم المستخدم مطلوب.');
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error('اسم المستخدم يجب أن يكون إنجليزيًا من 3 إلى 30 رمزًا.');

  const rows = sheetToObjects_(ORTEC.SHEETS.USERS);
  const duplicate = rows.find(function(row) {
    return normalizeUsername_(row.username) === username && String(row.user_id) !== String(input.user_id || '');
  });
  if (duplicate) throw new Error('اسم المستخدم مستخدم مسبقًا.');

  const existing = input.user_id ? findBy_(ORTEC.SHEETS.USERS, 'user_id', input.user_id) : null;
  const patch = {
    username: username,
    email: String(input.email || '').trim(),
    name_ar: String(input.name_ar || '').trim(),
    name_en: String(input.name_en || '').trim(),
    role: input.role || 'VIEWER',
    branch_id: input.branch_id || 'ALL',
    language: input.language || 'ar',
    active: input.active !== false && String(input.active).toLowerCase() !== 'false'
  };

  if (input.password) {
    const salt = Utilities.getUuid();
    patch.password_salt = salt;
    patch.password_hash = hashPassword_(input.password, salt);
    patch.must_change_password = Boolean(input.must_change_password);
  }

  if (existing) {
    updateById_(ORTEC.SHEETS.USERS, 'user_id', existing.user_id, patch);
    ORTEC_RUNTIME_USER_ = actor;
    audit_('USER', existing.user_id, 'UPDATE', publicUser_(existing), publicUser_(Object.assign({}, existing, patch)));
    return { ok: true, user_id: existing.user_id };
  }

  if (!input.password) throw new Error('كلمة المرور مطلوبة للمستخدم الجديد.');
  const row = Object.assign({
    user_id: uuid_(), created_at: nowIso_(), last_login: '', failed_attempts: 0,
    locked_until: '', must_change_password: Boolean(input.must_change_password)
  }, patch);
  appendObject_(ORTEC.SHEETS.USERS, row);
  ORTEC_RUNTIME_USER_ = actor;
  audit_('USER', row.user_id, 'CREATE', null, publicUser_(row));
  return { ok: true, user_id: row.user_id };
}

function changeMyPassword(currentPassword, newPassword, sessionToken) {
  const user = getCurrentUser(sessionToken);
  if (hashPassword_(currentPassword, user.password_salt || '') !== String(user.password_hash || '')) {
    throw new Error('كلمة المرور الحالية غير صحيحة.');
  }
  if (String(newPassword || '').length < 8) throw new Error('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف.');
  const salt = Utilities.getUuid();
  updateById_(ORTEC.SHEETS.USERS, 'user_id', user.user_id, {
    password_salt: salt,
    password_hash: hashPassword_(newPassword, salt),
    must_change_password: false
  });
  audit_('USER', user.user_id, 'PASSWORD_CHANGE', null, {});
  return { ok: true };
}

function auditAuth_(username, action, reason) {
  try {
    appendObject_(ORTEC.SHEETS.AUDIT, {
      audit_id: uuid_(), entity_type: 'AUTH', entity_id: username,
      action: action, before_json: '', after_json: JSON.stringify({ reason: reason }),
      user_email: username, timestamp: nowIso_()
    });
  } catch (e) {}
}
