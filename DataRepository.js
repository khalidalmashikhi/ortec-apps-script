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

/**
 * Transactional-like whole-table replace.
 *
 * replaceAllObjects_ clears the sheet before it writes, so a caller that hands
 * it an incomplete dataset destroys the rows it omitted, and a failure between
 * the clear and the write leaves the table empty. This wrapper refuses
 * implausible replacements and snapshots the current contents first, so a bad
 * import fails closed instead of shredding the table.
 *
 * options: { minRows, maxShrinkRatio, backupLabel, allowShrink }
 */
function replaceAllObjectsGuarded_(name, objects, options) {
  options = options || {};
  const rows = objects || [];
  const minRows = options.minRows == null ? 1 : Number(options.minRows);

  if (rows.length < minRows) {
    throw new Error(`Refusing to replace ${name}: got ${rows.length} rows, expected at least ${minRows}.`);
  }

  const current = sheetToObjects_(name);
  const maxShrinkRatio = options.maxShrinkRatio == null ? 0.5 : Number(options.maxShrinkRatio);
  if (!options.allowShrink && current.length > 0) {
    const floor = Math.floor(current.length * (1 - maxShrinkRatio));
    if (rows.length < floor) {
      throw new Error(
        `Refusing to replace ${name}: ${rows.length} new rows would drop it from ${current.length} ` +
        `(below the ${Math.round((1 - maxShrinkRatio) * 100)}% floor of ${floor}). ` +
        `Re-run with allowShrink if this is intended.`
      );
    }
  }

  const backup = backupSheetSnapshot_(name, current, options.backupLabel);
  const written = replaceAllObjects_(name, rows);
  return { written: written, previousCount: current.length, backupFileId: backup };
}

/** Write a JSON snapshot of a sheet to the Backups folder. Best effort. */
function backupSheetSnapshot_(name, rows, label) {
  try {
    const folderId = PropertiesService.getScriptProperties().getProperty('BACKUP_FOLDER_ID');
    if (!folderId || !rows || !rows.length) return '';
    const stamp = Utilities.formatDate(new Date(), ORTEC.TZ, "yyyy-MM-dd'T'HH-mm-ss");
    const fileName = `${name}_${label || 'replace'}_${stamp}.json`;
    const blob = Utilities.newBlob(JSON.stringify(rows), 'application/json', fileName);
    return DriveApp.getFolderById(folderId).createFile(blob).getId();
  } catch (e) {
    console.error('backupSheetSnapshot_ failed for %s: %s', name, e && e.message ? e.message : e);
    return '';
  }
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
