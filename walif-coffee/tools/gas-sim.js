/**
 * Minimal in-memory simulator of the Google Apps Script services used by Walif Coffee.
 * Enough fidelity to run setupSystem(), imports, entries, dashboard, reports, e-mail and triggers locally.
 *
 *   const sim = require('./gas-sim'); const ctx = sim.load();   // ctx has every server function
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const TZ_OFFSET = 4 * 60; // Asia/Muscat

function formatInTz(date, pattern) {
  const d = new Date(date.getTime() + TZ_OFFSET * 60000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const f = { yyyy: pad(d.getUTCFullYear(), 4), MM: pad(d.getUTCMonth() + 1), dd: pad(d.getUTCDate()), HH: pad(d.getUTCHours()), H: String(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()), u: String(d.getUTCDay() === 0 ? 7 : d.getUTCDay()) };
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|H|mm|ss|u/g, (t, q) => (q !== undefined ? q : f[t]));
}

// ------------------------------------------------------------ Spreadsheet
class Sheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this.data = []; this.frozen = 0; this.hidden = false; this.filter = null; this.formats = {}; }
  getName() { return this.name; }
  getLastRow() { let last = 0; this.data.forEach((r, i) => { if (r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; }); return last; }
  getLastColumn() { let last = 0; this.data.forEach(r => { r.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, i + 1); }); }); return last; }
  getMaxRows() { return Math.max(this.data.length, 1000); }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sh = this;
    return {
      getValues() { const out = []; for (let r = 0; r < numRows; r++) { const line = []; for (let c = 0; c < numCols; c++) { const v = (sh.data[row - 1 + r] || [])[col - 1 + c]; line.push(v === undefined ? '' : v); } out.push(line); } return out; },
      setValues(vals) { if (vals.length !== numRows || vals[0].length !== numCols) throw new Error('setValues dimension mismatch'); vals.forEach((line, r) => { const ri = row - 1 + r; while (sh.data.length <= ri) sh.data.push([]); line.forEach((v, c) => { sh.data[ri][col - 1 + c] = sh._coerce(v, col + c); }); }); return this; },
      setValue(v) { const ri = row - 1; while (sh.data.length <= ri) sh.data.push([]); sh.data[ri][col - 1] = sh._coerce(v, col); return this; },
      setNumberFormat(f) { sh.formats[col] = f; return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      createFilter() { sh.filter = true; return this; }
    };
  }
  _coerce(v, col) {
    if (typeof v === 'string' && v.charAt(0) === '=') throw new Error('FORMULA INJECTION: a value starting with "=" reached the sheet: ' + v);
    if (typeof v === 'string' && v.charAt(0) === "'") return v.slice(1); // Sheets strips the text-forcing apostrophe
    if (v instanceof Date) return new Date(v.getTime());
    // Like the real Sheets (USER_ENTERED), date-looking strings become Dates unless the column is plain text (@).
    if (typeof v === 'string' && this.formats[col] !== '@') {
      let m;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], -4));
      if ((m = /^(\d{4})-(\d{2})$/.exec(v))) return new Date(Date.UTC(+m[1], +m[2] - 1, 1, -4));
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    }
    return v;
  }
  setFrozenRows(n) { this.frozen = n; } getFilter() { return this.filter; } hideSheet() { this.hidden = true; } showSheet() { this.hidden = false; }
  deleteRow(i) { this.data.splice(i - 1, 1); }
}
class Spreadsheet {
  constructor() { this.sheets = [new Sheet(this, 'Sheet1')]; this.tz = 'Etc/GMT'; this.id = 'SS_' + crypto.randomUUID(); }
  getId() { return this.id; } getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  setSpreadsheetTimeZone(tz) { this.tz = tz; } getSpreadsheetTimeZone() { return this.tz; }
}

// ------------------------------------------------------------ Drive / Docs
class DriveFile {
  constructor(name, blob, parent, mime) { this.id = 'F_' + crypto.randomUUID(); this.name = name; this.blob = blob; this.parent = parent; this.trashed = false; this.mime = mime || (blob && blob.mime) || 'application/octet-stream'; }
  getId() { return this.id; } getName() { return this.name; } getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; }
  setTrashed(t) { this.trashed = t; return this; } isTrashed() { return this.trashed; }
  getAs(mime) { if (mime !== 'application/pdf') throw new Error('unsupported getAs'); return makeBlob(Buffer.from('%PDF-1.4 simulated pdf of ' + this.name), 'application/pdf', this.name + '.pdf'); }
  getBlob() { return this.blob; }
}
class Folder {
  constructor(name, parent) { this.id = 'D_' + crypto.randomUUID(); this.name = name; this.parent = parent; this.folders = []; this.files = []; this.trashed = false; }
  getId() { return this.id; } getName() { return this.name; } isTrashed() { return this.trashed; }
  getFoldersByName(n) { return iter(this.folders.filter(f => f.name === n && !f.trashed)); }
  getFilesByName(n) { return iter(this.files.filter(f => f.name === n && !f.trashed)); }
  createFolder(n) { const f = new Folder(n, this); this.folders.push(f); DRIVE.folders[f.id] = f; return f; }
  createFile(blob) { const f = new DriveFile(blob.name, blob, this); this.files.push(f); DRIVE.files[f.id] = f; return f; }
  path() { return (this.parent ? this.parent.path() + '/' : '') + this.name; }
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
function makeBlob(bytes, mime, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { bytes: buf, mime, name, getBytes: () => Array.from(buf), getName: () => name, setName(n) { this.name = n; return this; }, getContentType: () => mime, getAs(m) { return makeBlob(buf, m, name); } };
}
const DRIVE = { root: null, folders: {}, files: {}, docs: {} };

class Doc {
  constructor(name) { this.id = 'DOC_' + crypto.randomUUID(); this.name = name; this.lines = []; this.closed = false; const file = new DriveFile(name, null, null, 'application/vnd.google-apps.document'); file.id = this.id; file.getAs = (m) => makeBlob(Buffer.from('%PDF-1.4\n' + this.lines.join('\n')), m, name); DRIVE.files[this.id] = file; }
  getId() { return this.id; }
  getBody() {
    const doc = this;
    const para = (text) => { doc.lines.push(text); return { setHeading() { return this; }, setAlignment() { return this; }, setLeftToRight() { return this; }, setItalic() { return this; }, setBold() { return this; }, setForegroundColor() { return this; } }; };
    return {
      appendParagraph: para, appendListItem: para,
      appendTable(rows) {
        rows.forEach(r => doc.lines.push(r.join(' | ')));
        const cell = () => ({ setBackgroundColor() { return this; }, getChild() { return { asParagraph: () => ({ setForegroundColor() { return this; }, setBold() { return this; }, setLeftToRight() { return this; }, setAlignment() { return this; } }) }; } });
        const row = (i) => ({ getNumCells: () => rows[i].length, getCell: cell });
        return { setBorderWidth() { return this; }, getRow: row, getNumRows: () => rows.length };
      }
    };
  }
  saveAndClose() { this.closed = true; }
}

// ------------------------------------------------------------ misc services
const STATE = { props: {}, cache: {}, triggers: [], mails: [], logs: [], lockHeld: false };
const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
  formatDate: (d, tz, p) => formatInTz(d, p),
  computeDigest: (a, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
  getUuid: () => crypto.randomUUID(),
  base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
  base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
  newBlob: (bytes, mime, name) => makeBlob(Buffer.from(bytes), mime, name),
  sleep: () => {}
};
const PropertiesService = { getScriptProperties: () => ({
  getProperty: k => (k in STATE.props ? STATE.props[k] : null), setProperty(k, v) { STATE.props[k] = String(v); return this; },
  deleteProperty(k) { delete STATE.props[k]; return this; }, getProperties: () => Object.assign({}, STATE.props) }) };
const CacheService = { getScriptCache: () => ({ get: k => STATE.cache[k] || null, put: (k, v) => { STATE.cache[k] = v; }, remove: k => { delete STATE.cache[k]; } }) };
const LockService = { getScriptLock: () => ({ tryLock() { if (STATE.lockHeld) return false; STATE.lockHeld = true; return true; }, releaseLock() { STATE.lockHeld = false; } }) };
const MailApp = { sendEmail: (o) => { if (!o.to) throw new Error('no recipient'); STATE.mails.push(o); }, getRemainingDailyQuota: () => 99 };
const ScriptApp = {
  getProjectTriggers: () => STATE.triggers.slice(),
  deleteTrigger: t => { STATE.triggers = STATE.triggers.filter(x => x !== t); },
  newTrigger: fn => { const t = { fn, hour: null, tz: null, getHandlerFunction: () => fn }; const b = { timeBased: () => b, everyDays: () => b, atHour: h => { t.hour = h; return b; }, inTimezone: z => { t.tz = z; return b; }, create: () => { STATE.triggers.push(t); return t; } }; return b; }
};
const DriveApp = {
  getRootFolder: () => DRIVE.root, createFolder: n => DRIVE.root.createFolder(n),
  getFolderById: id => { const f = DRIVE.folders[id]; if (!f) throw new Error('folder not found ' + id); return f; },
  getFileById: id => { const f = DRIVE.files[id]; if (!f) throw new Error('file not found ' + id); return f; }
};
const DocumentApp = { create: n => { const d = new Doc(n); DRIVE.docs[d.id] = d; return d; }, ParagraphHeading: { TITLE: 1, HEADING1: 2, HEADING2: 3 }, HorizontalAlignment: { RIGHT: 'RIGHT' } };
const HtmlService = { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }), createHtmlOutputFromFile: () => ({ getContent: () => '' }), XFrameOptionsMode: { DEFAULT: 1 } };
const Logger = { log: (m) => STATE.logs.push(String(m)) };

function load() {
  const ss = new Spreadsheet();
  DRIVE.root = new Folder('My Drive', null); DRIVE.folders[DRIVE.root.id] = DRIVE.root;
  Object.keys(STATE.props).forEach(k => delete STATE.props[k]); Object.keys(STATE.cache).forEach(k => delete STATE.cache[k]);
  STATE.triggers.length = 0; STATE.mails.length = 0; STATE.logs.length = 0; STATE.lockHeld = false;
  const SpreadsheetApp = { getActiveSpreadsheet: () => ss, openById: () => ss };
  const ctx = vm.createContext({ Utilities, PropertiesService, CacheService, LockService, MailApp, ScriptApp, DriveApp, DocumentApp, HtmlService, Logger, SpreadsheetApp, console, JSON, Math, Date, Number, String, Array, Object, RegExp, Error, parseFloat, parseInt, isFinite, isNaN });
  const dir = path.resolve(__dirname, '..');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.gs')).sort((a, b) => (a === 'Config.gs' ? -1 : b === 'Config.gs' ? 1 : a.localeCompare(b)));
  for (const f of files) new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }).runInContext(ctx);
  ctx.__sim = { ss, STATE, DRIVE, findFolder: (p) => { let cur = DRIVE.root; for (const seg of p.split('/')) { const it = cur.getFoldersByName(seg); if (!it.hasNext()) return null; cur = it.next(); } return cur; } };
  return ctx;
}
module.exports = { load };
