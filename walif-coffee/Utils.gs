/**
 * Shared helpers: ids, dates (Asia/Muscat), numbers, sanitising, sheet access.
 */

function ss_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('المشروع غير مرتبط بملف Google Sheets.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

function props_() { return PropertiesService.getScriptProperties(); }

function now_() { return new Date(); }

function fmtDate_(d, pattern) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, WC.TZ, pattern || 'yyyy-MM-dd');
}
function fmtDateTime_(d) { return fmtDate_(d, 'yyyy-MM-dd HH:mm:ss'); }
function todayStr_() { return fmtDate_(now_()); }

/** Parse "yyyy-MM-dd" as midnight in Muscat time. */
function parseDateOnly_(s) {
  if (s instanceof Date) return new Date(s.getTime());
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return makeMuscatDate_(+m[1], +m[2], +m[3], 0, 0, 0);
}

/** Build a Date representing the given wall-clock time in Asia/Muscat (UTC+4, no DST). */
function makeMuscatDate_(y, mo, d, h, mi, s) {
  return new Date(Date.UTC(y, mo - 1, d, (h || 0) - 4, mi || 0, s || 0));
}

function addDays_(d, n) { return new Date(d.getTime() + n * 86400000); }

/** Robust parser for Loyverse date strings. Returns Date or null. */
function parseLoyverseDate_(raw) {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  var s = String(raw || '').trim();
  if (!s) return null;
  var m;
  // 2026-09-10 14:23[:45]  or 2026-09-10T14:23
  if ((m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i.exec(s))) {
    return makeMuscatDate_(+m[1], +m[2], +m[3], ampm_(+m[4] || 0, m[7]), +m[5] || 0, +m[6] || 0);
  }
  // 10/09/2026 14:23  (DD/MM/YYYY)  or 9/10/26 2:23 PM (MM/DD/YY)
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i.exec(s))) {
    var a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    var day, mon;
    if (a > 12) { day = a; mon = b; }          // must be DD/MM
    else if (b > 12) { mon = a; day = b; }     // must be MM/DD
    else { day = a; mon = b; }                 // ambiguous: assume DD/MM (Oman locale)
    return makeMuscatDate_(y, mon, day, ampm_(+m[4] || 0, m[7]), +m[5] || 0, +m[6] || 0);
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function ampm_(h, marker) {
  if (!marker) return h;
  var up = marker.toUpperCase();
  if (up === 'PM' && h < 12) return h + 12;
  if (up === 'AM' && h === 12) return 0;
  return h;
}

/** Numbers: accept "1,234.500", "(12.5)", "-3", "" → number. */
function toNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  var neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.\-]/g, '');
  var n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}
function round3_(n) { return Math.round((toNum_(n) + Number.EPSILON) * 1000) / 1000; }
function money_(n) { return round3_(n).toFixed(3); }

/** Trim + strip control chars + limit length. Never returns HTML-executable content (client escapes on render). */
function cleanText_(v, max) {
  var s = String(v == null ? '' : v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/** Formula-injection guard for values written to Sheets. */
function safeCell_(v) {
  if (typeof v !== 'string') return v;
  if (/^[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

function escapeHtml_(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function newId_(prefix) {
  var ts = fmtDate_(now_(), 'yyyyMMddHHmmss');
  var rand = Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
  return (prefix || 'ID') + '-' + ts + '-' + rand;
}

function randomToken_(bytes) {
  var out = '';
  var n = bytes || 32;
  for (var i = 0; i < n; i++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
  // Mix in a uuid so two calls in the same millisecond still differ.
  return out + Utilities.getUuid().replace(/-/g, '');
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function withLock_(fn, timeoutMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 30000)) throw new Error('النظام مشغول حاليًا، حاول مرة أخرى بعد لحظات.');
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- Sheets

function getSheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('الورقة غير موجودة: ' + name + ' — شغّل setupSystem() أولًا.');
  return sh;
}

function headersOf_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
}

/** Read every data row as an object keyed by header. */
function readRows_(name) {
  var sh = getSheet_(name);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0].map(String);
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], obj = { _row: r + 1 }, empty = true;
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
      if (row[c] !== '' && row[c] !== null) empty = false;
    }
    if (!empty) out.push(obj);
  }
  return out;
}

function objectsToRows_(headers, objects) {
  return objects.map(function (o) {
    return headers.map(function (h) {
      var v = o[h];
      if (v === undefined || v === null) return '';
      return safeCell_(v);
    });
  });
}

/** Batch append. */
function appendObjects_(name, objects) {
  if (!objects || !objects.length) return 0;
  var sh = getSheet_(name);
  var headers = headersOf_(sh);
  var rows = objectsToRows_(headers, objects);
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function findRowById_(name, id) {
  var sh = getSheet_(name);
  var headers = headersOf_(sh);
  var col = headers.indexOf('Internal ID');
  if (col < 0) throw new Error('الورقة لا تحتوي عمود Internal ID: ' + name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var ids = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      var vals = sh.getRange(i + 2, 1, 1, headers.length).getValues()[0];
      var obj = { _row: i + 2 };
      headers.forEach(function (h, k) { obj[h] = vals[k]; });
      return obj;
    }
  }
  return null;
}

function updateRowFields_(name, rowIndex, fields) {
  var sh = getSheet_(name);
  var headers = headersOf_(sh);
  Object.keys(fields).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c >= 0) sh.getRange(rowIndex, c + 1).setValue(safeCell_(fields[h]));
  });
}

/** Serialise for the client: Dates → strings, undefined → null. */
function clientSafe_(value) {
  return JSON.parse(JSON.stringify(value, function (k, v) {
    if (v instanceof Date) return fmtDateTime_(v);
    if (typeof v === 'undefined') return null;
    if (typeof v === 'number' && !isFinite(v)) return 0;
    return v;
  }));
}

function dateCell_(v) {
  if (v instanceof Date) return fmtDate_(v);
  var d = parseDateOnly_(v) || parseLoyverseDate_(v);
  return d ? fmtDate_(d) : '';
}

/** Month/period cell → 'yyyy-MM' whether stored as text or auto-converted to a Date. */
function ymCell_(v) {
  if (v instanceof Date) return fmtDate_(v, 'yyyy-MM');
  var s = String(v == null ? '' : v).trim();
  var m = /^(\d{4})-(\d{1,2})/.exec(s);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) : s;
}

function inRange_(dateStr, from, to) {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

function sumBy_(rows, key) {
  var t = 0;
  for (var i = 0; i < rows.length; i++) t += toNum_(rows[i][key]);
  return round3_(t);
}

function groupSum_(rows, keyField, valueField) {
  var map = {};
  rows.forEach(function (r) {
    var k = String(r[keyField] == null || r[keyField] === '' ? '—' : r[keyField]);
    map[k] = round3_((map[k] || 0) + toNum_(r[valueField]));
  });
  return map;
}

function mapToSortedArray_(map, labelKey, valueKey, desc) {
  var arr = Object.keys(map).map(function (k) { var o = {}; o[labelKey] = k; o[valueKey] = map[k]; return o; });
  arr.sort(function (a, b) { return desc === false ? a[valueKey] - b[valueKey] : b[valueKey] - a[valueKey]; });
  return arr;
}
