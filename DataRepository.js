function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error(`Missing sheet: ${name}`);
  return sh;
}

function sheetToObjects_(name) {
  const sh = getSheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1)
    .filter(row => row.some(v => v !== ''))
    .map(row => headers.reduce((o, h, i) => (o[h] = row[i], o), {}));
}

function appendObject_(name, object) {
  const sh = getSheet_(name);
  const headers = ORTEC.HEADERS[name];
  sh.appendRow(headers.map(h => object[h] !== undefined ? object[h] : ''));
  return object;
}

function appendObjects_(name, objects) {
  if (!objects || !objects.length) return 0;
  const sh = getSheet_(name);
  const headers = ORTEC.HEADERS[name];
  const rows = objects.map(o => headers.map(h => o[h] !== undefined ? o[h] : ''));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}


function replaceAllObjects_(name, objects) {
  const sh = getSheet_(name);
  const headers = ORTEC.HEADERS[name];
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
  }
  if (!objects || !objects.length) return 0;
  const rows = objects.map(o => headers.map(h => o[h] !== undefined ? o[h] : ''));
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function findBy_(name, field, value) {
  return sheetToObjects_(name).find(r => String(r[field]) === String(value)) || null;
}

function filterByDate_(name, field, dateString) {
  return sheetToObjects_(name).filter(r => normalizeDate_(r[field]) === dateString);
}

function updateById_(name, idField, idValue, patch) {
  const sh = getSheet_(name);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const idCol = headers.indexOf(idField);
  if (idCol < 0) throw new Error(`Unknown ID field ${idField}`);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(idValue)) {
      Object.entries(patch).forEach(([key, value]) => {
        const col = headers.indexOf(key);
        if (col >= 0) sh.getRange(i + 1, col + 1).setValue(value);
      });
      return true;
    }
  }
  return false;
}

function normalizeDate_(value) {
  if (!value) return '';
  if (value instanceof Date) return Utilities.formatDate(value, ORTEC.TZ, 'yyyy-MM-dd');
  const s = String(value).trim();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, ORTEC.TZ, 'yyyy-MM-dd');
  const m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}` : s.slice(0,10);
}

function audit_(entityType, entityId, action, beforeObj, afterObj) {
  appendObject_(ORTEC.SHEETS.AUDIT, {
    audit_id: uuid_(),
    entity_type: entityType,
    entity_id: entityId,
    action,
    before_json: JSON.stringify(beforeObj || {}),
    after_json: JSON.stringify(afterObj || {}),
    user_email: ORTEC_RUNTIME_USER_ ? (ORTEC_RUNTIME_USER_.username || ORTEC_RUNTIME_USER_.email) : (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail()),
    timestamp: nowIso_()
  });
}
