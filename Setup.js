/**
 * Editor-only. Rewrites every sheet header, seeds the owner account and
 * reinstalls triggers.
 *
 * The trailing underscore is the protection that matters: Apps Script refuses
 * to expose such functions to google.script.run at all, so this cannot be
 * reached from the web app regardless of who is calling or what their session
 * looks like. assertEditorContext_ stays as defence in depth.
 */
function setupOrTec_() {
  assertEditorContext_('setupOrTec_');
  const props = PropertiesService.getScriptProperties();
  let ss;
  const current = props.getProperty('SPREADSHEET_ID');
  if (current) ss = SpreadsheetApp.openById(current);
  else {
    ss = SpreadsheetApp.create('OrTec OS Database');
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }

  Object.keys(ORTEC.HEADERS).forEach(function(name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    ensureSheetHeaders_(sh, ORTEC.HEADERS[name]);
  });

  seedBranches_();
  seedSettings_();
  ensureDriveFolders_();
  const owner = seedOwnerUser_();
  installDailyTriggers_();
  return {
    ok: true,
    spreadsheetId: ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    ownerUsername: owner.username,
    temporaryPassword: owner.temporaryPassword || '',
    message: 'تم تجهيز OrTec OS v2 بنجاح.'
  };
}

function upgradeOrTecV2_() {
  assertEditorContext_('upgradeOrTecV2_');
  return setupOrTec_();
}

function ensureSheetHeaders_(sheet, requiredHeaders) {
  const rows = sheet.getLastRow() > 0 && sheet.getLastColumn() > 0
    ? sheet.getDataRange().getValues()
    : [];
  const currentHeaders = rows.length ? rows[0].map(String) : [];
  const allHeaders = requiredHeaders.slice();
  currentHeaders.forEach(function(header) {
    if (header && allHeaders.indexOf(header) === -1) allHeaders.push(header);
  });

  const normalizedRows = rows.slice(1).map(function(row) {
    const object = {};
    currentHeaders.forEach(function(header, index) { if (header) object[header] = row[index]; });
    return allHeaders.map(function(header) { return object[header] !== undefined ? object[header] : ''; });
  });

  // This clears the sheet and rewrites it from memory. Anything that fails in
  // between — the execution time limit, a transient Sheets error — would leave
  // the sheet permanently blank, so take a verified backup first. Same
  // fail-closed rule as the catalogue replacement: no backup, no clear.
  if (normalizedRows.length) {
    const asObjects = normalizedRows.map(function (row) {
      return allHeaders.reduce(function (o, header, index) { o[header] = row[index]; return o; }, {});
    });
    createVerifiedBackup_(sheet.getName(), asObjects, 'schema_migration');
  }
  sheet.clearContents();
  sheet.getRange(1, 1, 1, allHeaders.length).setValues([allHeaders]);
  if (normalizedRows.length) sheet.getRange(2, 1, normalizedRows.length, allHeaders.length).setValues(normalizedRows);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, allHeaders.length).setFontWeight('bold');
}

function seedOwnerUser_() {
  const rows = sheetToObjects_(ORTEC.SHEETS.USERS);
  let owner = rows.find(function(row) { return row.role === 'OWNER'; });
  const temporaryPassword = 'OrTec@2026';
  if (!owner) {
    const salt = Utilities.getUuid();
    owner = {
      user_id: uuid_(), username: 'khalid',
      email: Session.getEffectiveUser().getEmail() || '',
      name_ar: 'خالد المشيخي', name_en: 'Khalid Al-Mashikhi',
      role: 'OWNER', branch_id: 'ALL', language: 'ar', active: true,
      password_hash: hashPassword_(temporaryPassword, salt), password_salt: salt,
      must_change_password: true, last_login: '', failed_attempts: 0,
      locked_until: '', created_at: nowIso_()
    };
    appendObject_(ORTEC.SHEETS.USERS, owner);
    return { username: 'khalid', temporaryPassword: temporaryPassword };
  }
  const patch = {};
  if (!owner.username) patch.username = 'khalid';
  if (!owner.password_hash) {
    const salt = Utilities.getUuid();
    patch.password_salt = salt;
    patch.password_hash = hashPassword_(temporaryPassword, salt);
    patch.must_change_password = true;
  }
  if (Object.keys(patch).length) updateById_(ORTEC.SHEETS.USERS, 'user_id', owner.user_id, patch);
  return { username: patch.username || owner.username || 'khalid', temporaryPassword: patch.password_hash ? temporaryPassword : '' };
}

function seedBranches_() {
  const existing = sheetToObjects_(ORTEC.SHEETS.BRANCHES);
  ORTEC.BRANCHES.forEach(function(b) {
    if (!existing.some(function(x) { return x.branch_id === b.id; })) {
      appendObject_(ORTEC.SHEETS.BRANCHES, { branch_id: b.id, name_ar: b.ar, name_en: b.en, active: true, created_at: nowIso_() });
    }
  });
}

function seedSettings_() {
  const defaults = {
    COMPANY_NAME_AR: 'شركة الأصلي للتكنولوجيا - OrTec', COMPANY_NAME_EN: 'Original Technology - OrTec',
    REPORT_RECIPIENTS: Session.getEffectiveUser().getEmail() || '', DAILY_REPORT_HOUR: '22',
    EXPENSE_APPROVAL_LIMIT: '50', REQUIRE_INVOICE_FOR_EXPENSE: 'true', ENABLE_AI_SUMMARY: 'false', GEMINI_MODEL: 'gemini-2.5-flash'
  };
  const existing = sheetToObjects_(ORTEC.SHEETS.SETTINGS);
  Object.entries(defaults).forEach(function(entry) {
    const key = entry[0], value = entry[1];
    if (!existing.some(function(x) { return x.key === key; })) appendObject_(ORTEC.SHEETS.SETTINGS, {
      key: key, value: value, description: '', updated_at: nowIso_(), updated_by: Session.getEffectiveUser().getEmail()
    });
  });
}

function ensureDriveFolders_() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ROOT_FOLDER_ID')) {
    const root = DriveApp.createFolder('OrTec OS');
    props.setProperty('ROOT_FOLDER_ID', root.getId());
    props.setProperty('UPLOAD_FOLDER_ID', root.createFolder('Uploads').getId());
    props.setProperty('EXPENSE_FOLDER_ID', root.createFolder('Expense Invoices').getId());
    props.setProperty('REPORT_FOLDER_ID', root.createFolder('Daily Reports').getId());
    props.setProperty('BACKUP_FOLDER_ID', root.createFolder('Backups').getId());
  }
}

/** Editor-only: deletes and recreates this project's scheduled triggers. */
function installDailyTriggers_() {
  assertEditorContext_('installDailyTriggers_');
  ScriptApp.getProjectTriggers().filter(function(t) {
    return ['sendDailyAccountingReport','checkMissingLoyverseUpload','sendTaskReminders'].indexOf(t.getHandlerFunction()) !== -1;
  }).forEach(function(t) { ScriptApp.deleteTrigger(t); });
  const hour = Number(getSetting_('DAILY_REPORT_HOUR', 22));
  ScriptApp.newTrigger('checkMissingLoyverseUpload').timeBased().everyDays(1).atHour(Math.max(0, hour - 1)).create();
  ScriptApp.newTrigger('sendDailyAccountingReport').timeBased().everyDays(1).atHour(hour).create();
  ScriptApp.newTrigger('sendTaskReminders').timeBased().everyDays(1).atHour(8).create();
  return { ok: true };
}
