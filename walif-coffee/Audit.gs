/**
 * Audit log + error log. Never logs passwords or session tokens.
 */

function scrub_(text) {
  return String(text == null ? '' : text)
    .replace(/(password|token|كلمة المرور)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 2000);
}

function logAudit_(actor, action, entity, recordId, details, result) {
  try {
    appendObjects_(WC.SHEETS.AUDIT, [{
      Timestamp: now_(), User: actor && actor.username ? actor.username : '', Role: actor && actor.role ? actor.role : '',
      Action: action, Entity: entity || '', 'Record ID': recordId || '', Details: scrub_(details), Result: result || 'OK'
    }]);
  } catch (e) { Logger.log('audit failed: ' + e); }
}

function logError_(fnName, actor, err, relatedId) {
  try {
    appendObjects_(WC.SHEETS.ERRORS, [{
      Timestamp: now_(), Function: fnName, User: actor && actor.username ? actor.username : '',
      'Error Message': scrub_(err && err.message ? err.message : err),
      Stack: scrub_(err && err.stack ? err.stack : ''), 'Related Record ID': relatedId || '', Resolved: 'FALSE'
    }]);
  } catch (e) { Logger.log('error log failed: ' + e); }
}

function api_getAuditLog(token, limit) {
  return apiCall_('api_getAuditLog', token, [WC.ROLES.MANAGER], function () {
    var rows = readRows_(WC.SHEETS.AUDIT);
    var n = Math.min(Math.max(toNum_(limit) || 200, 1), 1000);
    rows = rows.slice(-n).reverse();
    return { ok: true, rows: clientSafe_(rows.map(function (r) { delete r._row; return r; })) };
  });
}

function api_getErrorLog(token, limit) {
  return apiCall_('api_getErrorLog', token, [WC.ROLES.MANAGER], function () {
    var rows = readRows_(WC.SHEETS.ERRORS);
    var n = Math.min(Math.max(toNum_(limit) || 100, 1), 500);
    rows = rows.slice(-n).reverse();
    return { ok: true, rows: clientSafe_(rows.map(function (r) { delete r._row; return r; })) };
  });
}

/** Accountant: only their own audit entries (no settings/email details). */
function api_getMyActivity(token, limit) {
  return apiCall_('api_getMyActivity', token, null, function (actor) {
    var rows = readRows_(WC.SHEETS.AUDIT).filter(function (r) { return String(r.User) === actor.username; });
    var n = Math.min(Math.max(toNum_(limit) || 50, 1), 200);
    rows = rows.slice(-n).reverse();
    return { ok: true, rows: clientSafe_(rows.map(function (r) {
      return { Timestamp: r.Timestamp, Action: r.Action, Entity: r.Entity, 'Record ID': r['Record ID'], Result: r.Result };
    })) };
  });
}
