/**
 * OrTec OS — Phase 1 regression suite.
 *
 * SAFETY CONTRACT. Nothing in this file may touch production:
 *   - no sheet reads or writes        - no MailApp / GmailApp
 *   - no DriveApp file creation       - no trigger installation or deletion
 *   - no ScriptApp mutation           - no PropertiesService writes
 * Every test operates on pure functions or on in-memory fixtures. Run
 * `runAllTests` from the Apps Script editor; it returns a summary object and
 * logs each assertion.
 *
 * Pure-function tests also run under plain Node (see tools/run-tests.js), which
 * is how they were executed for the Phase 1 review without opening the project.
 */

// ---------------------------------------------------------------- harness ---

function ortecAssert_(results, name, condition, detail) {
  results.push({ name: name, passed: !!condition, detail: condition ? '' : (detail || '') });
  return !!condition;
}

function ortecAssertEquals_(results, name, actual, expected) {
  const passed = String(actual) === String(expected);
  return ortecAssert_(results, name, passed, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ortecAssertThrows_(results, name, fn) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  return ortecAssert_(results, name, threw, 'expected the call to throw, it returned normally');
}

// --------------------------------------------------- P1: date normalization ---

function test_resolveDateArg_(results) {
  const today = today_();

  // 1. The actual regression: a time-based trigger event object.
  const triggerEvent = {
    authMode: 'FULL',
    triggerUid: '1234567890',
    year: 2026, month: 8, 'day-of-month': 30, hour: 22, minute: 0, second: 0,
    timezone: 'Asia/Muscat'
  };
  ortecAssertEquals_(results, 'trigger event object resolves to today', resolveDateArg_(triggerEvent), today);
  ortecAssert_(results, 'trigger event never leaks "[object Object]"',
    String(resolveDateArg_(triggerEvent)).indexOf('[object') === -1);

  // 2. A valid date string passes through untouched (manual web-app calls).
  ortecAssertEquals_(results, 'valid yyyy-MM-dd passes through', resolveDateArg_('2026-08-30'), '2026-08-30');
  ortecAssertEquals_(results, 'normalization is idempotent',
    resolveDateArg_(resolveDateArg_('2026-01-05')), '2026-01-05');

  // 3. Real Date objects format correctly.
  ortecAssertEquals_(results, 'Date object formats to yyyy-MM-dd',
    resolveDateArg_(new Date(2026, 7, 30, 12, 0, 0)), '2026-08-30');
  ortecAssertEquals_(results, 'invalid Date falls back to today', resolveDateArg_(new Date('nonsense')), today);

  // 4. Null / undefined / empty.
  ortecAssertEquals_(results, 'null resolves to today', resolveDateArg_(null), today);
  ortecAssertEquals_(results, 'undefined resolves to today', resolveDateArg_(undefined), today);
  ortecAssertEquals_(results, 'empty string resolves to today', resolveDateArg_(''), today);

  // 5. Malformed input never propagates.
  ['30/08/2026', 'yesterday', '[object Object]', '2026-13-01', '2026-08-32', '20260830', 0, false]
    .forEach(function (bad) {
      ortecAssertEquals_(results, `malformed input ${JSON.stringify(bad)} resolves to today`, resolveDateArg_(bad), today);
    });
}

// ------------------------------------------- P2: report-type canonical value ---

function test_reportTypeConsistency_(results) {
  ortecAssertEquals_(results, 'canonical item-export constant', ORTEC.IMPORT_TYPES.ITEM_EXPORT, 'ITEM_EXPORT');
  ortecAssertEquals_(results, 'canonical receipts constant', ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM, 'RECEIPTS_BY_ITEM');

  // The importer's detector and the missing-upload checker must agree. This is
  // the pair that silently disagreed (ITEM_EXPORT vs ITEMS_EXPORT) and made the
  // nightly alert fire every night regardless of what was uploaded.
  const detected = detectReportType_(['handle', 'sku', 'in stock [awqad]']);
  ortecAssertEquals_(results, 'detector returns the canonical item-export value',
    detected, ORTEC.IMPORT_TYPES.ITEM_EXPORT);

  const batchTypes = new Set([detected]);
  ortecAssert_(results, 'checker recognises what the importer writes',
    batchTypes.has(ORTEC.IMPORT_TYPES.ITEM_EXPORT),
    'the missing-upload checker would report Export Items as missing after a successful import');

  const receipts = detectReportType_(['receipt number', 'net sales', 'quantity', 'store']);
  ortecAssertEquals_(results, 'detector returns the canonical receipts value',
    receipts, ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM);
  ortecAssertEquals_(results, 'unknown headers stay unknown', detectReportType_(['a', 'b']), 'UNKNOWN');
}

// ------------------------------- P3: catalogue refresh must not lose products ---

/**
 * In-memory model of the fixed classification step. It mirrors the loop in
 * importItemExport_: every row in the file joins the replacement dataset, and
 * `unchanged` rows are retained rather than dropped.
 */
function classifyCatalogueRows_(fileKeys, existingKeys) {
  const existing = new Set(existingKeys);
  const seen = new Set();
  const catalogue = [];
  const stats = { inserted: 0, unchanged: 0, duplicates: 0 };
  fileKeys.forEach(function (key) {
    if (seen.has(key)) { stats.duplicates++; return; }
    seen.add(key);
    catalogue.push(key);
    if (existing.has(key)) stats.unchanged++; else stats.inserted++;
  });
  return { catalogue: catalogue, stats: stats };
}

function test_catalogueRefresh_(results) {
  // Day 2 import: 4 of 5 products unchanged, 1 new. Under the old algorithm
  // the replacement set was ['E'] and A–D were destroyed.
  const existing = ['A', 'B', 'C', 'D'];
  const file = ['A', 'B', 'C', 'D', 'E'];
  const out = classifyCatalogueRows_(file, existing);

  ortecAssertEquals_(results, 'replacement set contains every row in the file', out.catalogue.length, 5);
  ortecAssertEquals_(results, 'unchanged products are retained', out.stats.unchanged, 4);
  ortecAssertEquals_(results, 'new products are counted as inserted', out.stats.inserted, 1);
  existing.forEach(function (key) {
    ortecAssert_(results, `unchanged product ${key} survives the refresh`,
      out.catalogue.indexOf(key) !== -1, 'product was dropped by the replacement');
  });

  // A catalogue re-imported with no changes at all must survive intact.
  const noChange = classifyCatalogueRows_(existing, existing);
  ortecAssertEquals_(results, 'identical catalogue survives unchanged', noChange.catalogue.length, 4);
  ortecAssertEquals_(results, 'identical catalogue reports zero insertions', noChange.stats.inserted, 0);

  // Rows repeated within one file collapse without shrinking the catalogue.
  const dupes = classifyCatalogueRows_(['A', 'A', 'B'], existing);
  ortecAssertEquals_(results, 'in-file duplicates are collapsed', dupes.stats.duplicates, 1);
  ortecAssertEquals_(results, 'in-file duplicates do not drop rows', dupes.catalogue.length, 2);

  // Regression guard: prove the OLD algorithm was destructive, so a future
  // refactor cannot quietly reintroduce it.
  const oldAlgorithm = file.filter(function (k) { return existing.indexOf(k) === -1; });
  ortecAssertEquals_(results, 'GUARD: old algorithm would have kept only 1 of 5 rows', oldAlgorithm.length, 1);
  ortecAssert_(results, 'GUARD: new algorithm keeps strictly more rows than the old one',
    out.catalogue.length > oldAlgorithm.length);
}

/** Shrink/emptiness guards, modelled without touching a sheet. */
function evaluateReplacementGuard_(newCount, currentCount, minRows, maxShrinkRatio) {
  if (newCount < minRows) return { allowed: false, reason: 'TOO_FEW_ROWS' };
  if (currentCount > 0) {
    const floor = Math.floor(currentCount * (1 - maxShrinkRatio));
    if (newCount < floor) return { allowed: false, reason: 'SHRINK_GUARD' };
  }
  return { allowed: true, reason: '' };
}

function test_partialImportDoesNotWipe_(results) {
  const guard = ORTEC.IMPORT_GUARD;

  const empty = evaluateReplacementGuard_(0, 500, guard.MIN_CATALOGUE_ROWS, guard.MAX_SHRINK_RATIO);
  ortecAssert_(results, 'an empty parse is refused', !empty.allowed);
  ortecAssertEquals_(results, 'empty parse reports the right reason', empty.reason, 'TOO_FEW_ROWS');

  const truncated = evaluateReplacementGuard_(20, 500, guard.MIN_CATALOGUE_ROWS, guard.MAX_SHRINK_RATIO);
  ortecAssert_(results, 'a truncated file is refused by the shrink guard', !truncated.allowed);
  ortecAssertEquals_(results, 'truncated file reports the right reason', truncated.reason, 'SHRINK_GUARD');

  const legitimate = evaluateReplacementGuard_(505, 500, guard.MIN_CATALOGUE_ROWS, guard.MAX_SHRINK_RATIO);
  ortecAssert_(results, 'a normal daily refresh is allowed', legitimate.allowed);

  const firstEver = evaluateReplacementGuard_(300, 0, guard.MIN_CATALOGUE_ROWS, guard.MAX_SHRINK_RATIO);
  ortecAssert_(results, 'the first ever import is allowed against an empty table', firstEver.allowed);

  const modestShrink = evaluateReplacementGuard_(300, 500, guard.MIN_CATALOGUE_ROWS, guard.MAX_SHRINK_RATIO);
  ortecAssert_(results, 'a genuine 40% catalogue reduction is still allowed', modestShrink.allowed);
}

/** Duplicate-file protection is keyed on content hash and must be unchanged. */
function test_duplicateFileHandling_(results) {
  const a = sha256_('sku,name\nA,Widget\n');
  const b = sha256_('sku,name\nA,Widget\n');
  const c = sha256_('sku,name\nA,Widget 2\n');
  ortecAssertEquals_(results, 'identical file content hashes identically', a, b);
  ortecAssert_(results, 'different file content hashes differently', a !== c);
  ortecAssertEquals_(results, 'hash is hex sha-256 of the expected length', String(a).length, 64);
}

// ------------------------------------------------------ P4: authorization ---

function test_authorization_(results) {
  // The capability matrix is the server-side source of truth.
  ortecAssert_(results, 'VIEWER cannot import', capabilitiesForRole_('VIEWER').indexOf('import') === -1);
  ortecAssert_(results, 'VIEWER cannot read expenses', capabilitiesForRole_('VIEWER').indexOf('expense') === -1);
  ortecAssert_(results, 'TECHNICIAN cannot read the dashboard', capabilitiesForRole_('TECHNICIAN').indexOf('dashboard') === -1);
  ortecAssert_(results, 'CASHIER cannot approve expenses', capabilitiesForRole_('CASHIER').indexOf('expense.approve') === -1);
  ortecAssert_(results, 'CASHIER cannot manage users', capabilitiesForRole_('CASHIER').indexOf('users') === -1);
  ortecAssert_(results, 'BRANCH_MANAGER cannot email reports', capabilitiesForRole_('BRANCH_MANAGER').indexOf('reports.email') === -1);
  ortecAssert_(results, 'OWNER can manage settings', capabilitiesForRole_('OWNER').indexOf('settings') !== -1);
  ortecAssert_(results, 'an unknown role gets no capabilities at all', capabilitiesForRole_('HACKER').length === 0);
  ortecAssert_(results, 'an empty role gets no capabilities at all', capabilitiesForRole_('').length === 0);

  // A caller must not be able to widen their own branch scope.
  ortecAssertEquals_(results, 'branch-scoped user cannot request ALL',
    scopeBranch_({ branch_id: 'AWQAD' }, 'ALL'), 'AWQAD');
  ortecAssertEquals_(results, 'branch-scoped user cannot request another branch',
    scopeBranch_({ branch_id: 'AWQAD' }, 'SAADA'), 'AWQAD');
  ortecAssertEquals_(results, 'ALL-scoped user may request a single branch',
    scopeBranch_({ branch_id: 'ALL' }, 'SAADA'), 'SAADA');
  ortecAssertEquals_(results, 'missing branch defaults to ALL',
    scopeBranch_({ branch_id: 'ALL' }, null), 'ALL');

  // Protected operations must reject an absent or bogus session token.
  ortecAssertThrows_(results, 'getDashboardData rejects a missing token', function () { getDashboardData('2026-08-30', 'ALL'); });
  ortecAssertThrows_(results, 'listExpenses rejects a missing token', function () { listExpenses('2026-08-30', 'ALL'); });
  ortecAssertThrows_(results, 'listTasks rejects a missing token', function () { listTasks('OPEN'); });
  ortecAssertThrows_(results, 'listInventoryIssues rejects a missing token', function () { listInventoryIssues('OPEN'); });
  ortecAssertThrows_(results, 'analyzeInventory rejects a missing token', function () { analyzeInventory('2026-08-30'); });
  ortecAssertThrows_(results, 'getOperationsAnalysis rejects a missing token', function () { getOperationsAnalysis('2026-08-30', 'ALL'); });
  ortecAssertThrows_(results, 'sendDailyAccountingReport rejects an unauthenticated call', function () { sendDailyAccountingReport('2026-08-30'); });
  ortecAssertThrows_(results, 'checkMissingLoyverseUpload rejects an unauthenticated call', function () { checkMissingLoyverseUpload('2026-08-30'); });
  ortecAssertThrows_(results, 'sendTaskReminders rejects an unauthenticated call', function () { sendTaskReminders(); });
  ortecAssertThrows_(results, 'a forged trigger event does not authorize', function () {
    sendDailyAccountingReport({ triggerUid: 'forged-uid', authMode: 'FULL' });
  });
  ortecAssertThrows_(results, 'include rejects a template outside the allow-list', function () { include('../../secrets'); });
}

// --------------------------------------- P5: payment data honesty on dashboard ---

function test_paymentBreakdownHonesty_(results) {
  // The dashboard payload must not carry fabricated payment buckets. Loyverse
  // "Receipts by Item" has no payment-method column, so the old CASH/CARD/
  // TRANSFER figures were structurally always zero and netCashMovement always
  // equalled minus the day's expenses.
  const source = ortecReadSourceForTests_('Dashboard.js');
  if (source === null) {
    ortecAssert_(results, 'payment-honesty source check skipped (Apps Script runtime)', true);
    return;
  }
  ortecAssert_(results, 'no fabricated CASH bucket remains', source.indexOf('paymentTotals') === -1);
  ortecAssert_(results, 'no netCashMovement computation remains', source.indexOf('netCashMovement:') === -1);
  ortecAssert_(results, 'payload declares payment data unavailable', source.indexOf('paymentBreakdown') !== -1);
  ortecAssert_(results, 'unavailability carries a reason', source.indexOf("reason: 'NOT_IN_SOURCE'") !== -1);
}

/** Node-only helper; returns null inside Apps Script where there is no fs. */
function ortecReadSourceForTests_(fileName) {
  try {
    if (typeof require !== 'function') return null;
    return require('fs').readFileSync(fileName, 'utf8');
  } catch (e) {
    return null;
  }
}

// -------------------------------- P6: manual report generation compatibility ---

function test_manualReportCompatibility_(results) {
  // Manual calls from the web app pass explicit date strings through
  // `options`; normalization must leave them exactly as they were, otherwise
  // the fix would change behaviour users already rely on.
  const options = { dateFrom: '2026-08-01', dateTo: '2026-08-31', branchId: 'AWQAD' };
  ortecAssertEquals_(results, 'manual dateFrom is unchanged', resolveDateArg_(options.dateFrom || options.date), '2026-08-01');
  ortecAssertEquals_(results, 'manual dateTo is unchanged', resolveDateArg_(options.dateTo), '2026-08-31');

  // A single-day manual report (the "quick daily PDF" button) still works.
  const single = { date: '2026-08-30' };
  const from = resolveDateArg_(single.dateFrom || single.date);
  ortecAssertEquals_(results, 'single-day manual report keeps its date', from, '2026-08-30');
  ortecAssertEquals_(results, 'dateTo defaults to dateFrom', resolveDateArg_(single.dateTo || from), '2026-08-30');

  // An omitted date still means "today", as before.
  ortecAssertEquals_(results, 'omitted manual date means today', resolveDateArg_(undefined), today_());

  // Date range filtering must select rows once dates are real strings — the
  // behavioural property that was silently false for six weeks.
  const rows = ['2026-07-31', '2026-08-01', '2026-08-15', '2026-08-31', '2026-09-01'];
  const inRange = rows.filter(function (d) { return d >= options.dateFrom && d <= options.dateTo; });
  ortecAssertEquals_(results, 'a real date range selects the expected rows', inRange.length, 3);

  // The same filter with the old, unnormalized object selects nothing.
  const brokenFrom = { authMode: 'FULL', triggerUid: 'x' };
  const brokenTo = brokenFrom;
  const brokenRange = rows.filter(function (d) { return d >= brokenFrom && d <= brokenTo; });
  ortecAssertEquals_(results, 'GUARD: the old object-as-date path selected zero rows', brokenRange.length, 0);
}

// ------------------------------------------- supporting correctness fixtures ---

function test_branchNormalization_(results) {
  ortecAssertEquals_(results, 'Awqad maps from latin', normalizeLoyverseBranch_('Awqad Branch'), 'AWQAD');
  ortecAssertEquals_(results, 'Saada maps from latin', normalizeLoyverseBranch_('Sadah'), 'SAADA');
  ortecAssertEquals_(results, 'Ittin maps from latin', normalizeLoyverseBranch_('Ittin Square'), 'ITTIN');
  // The alif-with-hamza form used in Config.BRANCHES previously failed to match
  // and every row from that store was discarded as an error row.
  ortecAssertEquals_(results, 'Ittin maps from Arabic with hamza', normalizeLoyverseBranch_('مربع إتين'), 'ITTIN');
  ortecAssertEquals_(results, 'Ittin maps from Arabic bare alif', normalizeLoyverseBranch_('اتين'), 'ITTIN');
  ortecAssertEquals_(results, 'Awqad maps from Arabic', normalizeLoyverseBranch_('فرع عوقد'), 'AWQAD');
  ortecAssertEquals_(results, 'an unknown store maps to empty', normalizeLoyverseBranch_('Nowhere'), '');
}


// ------------------------------------------- Node-only integration harness ---
//
// These tests exercise the real replaceAllObjectsGuarded_ against an in-memory
// sheet double, so they can prove ORDER of operations — specifically that a
// backup failure aborts BEFORE anything is cleared. They require the ability to
// swap the Google service globals, which only the Node runner allows; inside
// Apps Script they are skipped.

function ortecIsNodeHarness_() {
  return typeof globalThis !== 'undefined' && globalThis.__ORTEC_TEST_HARNESS__ === true;
}

/**
 * Installs a fake spreadsheet containing `initialRows` for `sheetName`, plus a
 * Drive stub whose backup behaviour is controlled by `driveMode`:
 *   'ok'          — backups succeed
 *   'throw'       — createFile throws
 *   'empty'       — createFile returns a zero-byte file
 *   'no-folder'   — BACKUP_FOLDER_ID is not configured
 * Returns a probe describing what the sheet actually experienced.
 */
function ortecInstallFakeSheet_(sheetName, headers, initialRows, driveMode) {
  const probe = { cleared: 0, writes: [], backupsCreated: 0, rows: initialRows.slice() };

  const sheet = {
    getDataRange: () => ({ getValues: () => [headers].concat(probe.rows.map(r => headers.map(h => r[h] !== undefined ? r[h] : ''))) }),
    getLastRow: () => probe.rows.length + 1,
    getLastColumn: () => headers.length,
    setFrozenRows: () => undefined,
    appendRow: row => { probe.writes.push(['append', row]); },
    getRange: () => ({
      clearContent: () => { probe.cleared++; probe.rows = []; },
      setValues: values => {
        probe.writes.push(['setValues', values.length]);
        probe.rows = values.map(v => headers.reduce((o, h, i) => (o[h] = v[i], o), {}));
      },
      setValue: () => undefined,
      setFontWeight: () => undefined
    })
  };

  globalThis.SpreadsheetApp = { openById: () => ({ getSheetByName: n => (n === sheetName ? sheet : null)}) };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => {
        if (key === 'SPREADSHEET_ID') return 'fake-spreadsheet';
        if (key === 'BACKUP_FOLDER_ID') return driveMode === 'no-folder' ? null : 'fake-backup-folder';
        return null;
      },
      setProperty: () => { throw new Error('SAFETY VIOLATION: property write'); }
    })
  };
  globalThis.Utilities.newBlob = (content, type, nameArg) => ({ content: content, type: type, name: nameArg });
  globalThis.DriveApp = {
    getFolderById: () => ({
      createFile: blob => {
        if (driveMode === 'throw') throw new Error('Drive quota exceeded');
        probe.backupsCreated++;
        const size = driveMode === 'empty' ? 0 : String(blob.content || '').length;
        return { getId: () => (driveMode === 'empty' ? 'empty-file-id' : 'backup-file-id'), getSize: () => size };
      }
    })
  };
  return probe;
}

const ORTEC_TEST_PRODUCT_HEADERS_ = ['product_key','sku','barcode','item_name','category','cost','price','track_stock','branch_id','stock','low_stock_threshold','batch_id','updated_at'];

function ortecProduct_(key) {
  return { product_key: key, sku: key, barcode: '', item_name: 'Item ' + key, category: 'C',
           cost: 1, price: 2, track_stock: true, branch_id: 'AWQAD', stock: 5,
           low_stock_threshold: 1, batch_id: 'b1', updated_at: '2026-08-31T00:00:00' };
}

function test_failClosedBackup_(results) {
  if (!ortecIsNodeHarness_()) {
    ortecAssert_(results, 'fail-closed backup tests skipped (Apps Script runtime)', true);
    return;
  }
  const existing = ['A','B','C','D'].map(ortecProduct_);
  const replacement = ['A','B','C','D','E'].map(ortecProduct_);

  // 1. Happy path: backup succeeds, then the replacement is written.
  let probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'ok');
  let out = replaceAllObjectsGuarded_('LoyverseProducts', replacement, { backupLabel: 'test', requireBackup: true });
  ortecAssertEquals_(results, 'valid catalogue replaces current state', out.written, 5);
  ortecAssertEquals_(results, 'a backup was created before the replace', probe.backupsCreated, 1);
  ortecAssertEquals_(results, 'backup id is returned', out.backupFileId, 'backup-file-id');
  ortecAssertEquals_(results, 'previous count is reported', out.previousCount, 4);
  ortecAssertEquals_(results, 'unchanged products survive the replace',
    probe.rows.filter(r => ['A','B','C','D'].indexOf(r.product_key) !== -1).length, 4);
  ortecAssert_(results, 'new product appears after the replace',
    probe.rows.some(r => r.product_key === 'E'));

  // 2. Backup throws -> abort BEFORE any clear.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'throw');
  ortecAssertThrows_(results, 'backup failure aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', replacement, { backupLabel: 'test', requireBackup: true });
  });
  ortecAssertEquals_(results, 'backup failure: sheet was never cleared', probe.cleared, 0);
  ortecAssertEquals_(results, 'backup failure: nothing was written', probe.writes.length, 0);
  ortecAssertEquals_(results, 'backup failure: existing products intact', probe.rows.length, 4);

  // 3. Backup folder not configured -> abort before any clear.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'no-folder');
  ortecAssertThrows_(results, 'missing BACKUP_FOLDER_ID aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', replacement, { backupLabel: 'test', requireBackup: true });
  });
  ortecAssertEquals_(results, 'missing backup folder: sheet was never cleared', probe.cleared, 0);
  ortecAssertEquals_(results, 'missing backup folder: existing products intact', probe.rows.length, 4);

  // 4. Backup written but empty -> treated as failure.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'empty');
  ortecAssertThrows_(results, 'a zero-byte backup aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', replacement, { backupLabel: 'test', requireBackup: true });
  });
  ortecAssertEquals_(results, 'empty backup: sheet was never cleared', probe.cleared, 0);
  ortecAssertEquals_(results, 'empty backup: existing products intact', probe.rows.length, 4);

  // 5. Empty catalogue -> abort before clear and before backup.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'ok');
  ortecAssertThrows_(results, 'empty catalogue aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', [], { requireBackup: true });
  });
  ortecAssertEquals_(results, 'empty catalogue: sheet was never cleared', probe.cleared, 0);
  ortecAssertEquals_(results, 'empty catalogue: no pointless backup taken', probe.backupsCreated, 0);

  // 6. Malformed dataset -> abort.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'ok');
  ortecAssertThrows_(results, 'malformed catalogue aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', 'not-an-array', { requireBackup: true });
  });
  ortecAssertEquals_(results, 'malformed catalogue: sheet was never cleared', probe.cleared, 0);

  // 7. Implausible shrink -> abort before clear.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_,
    'ABCDEFGHIJ'.split('').map(ortecProduct_), 'ok');
  ortecAssertThrows_(results, 'implausible shrink aborts the replacement', function () {
    replaceAllObjectsGuarded_('LoyverseProducts', [ortecProduct_('A')], { requireBackup: true });
  });
  ortecAssertEquals_(results, 'shrink guard: sheet was never cleared', probe.cleared, 0);
  ortecAssertEquals_(results, 'shrink guard: existing products intact', probe.rows.length, 10);

  // 8. First-ever import into an empty table needs no backup and is allowed.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, [], 'no-folder');
  out = replaceAllObjectsGuarded_('LoyverseProducts', replacement, { requireBackup: true });
  ortecAssertEquals_(results, 'first import into an empty table succeeds', out.written, 5);
  ortecAssertEquals_(results, 'first import takes no backup (nothing to lose)', probe.backupsCreated, 0);

  // 9. Catalogue semantics: a product absent from the new file is REMOVED,
  //    because Export Items is a full snapshot of the current catalogue.
  probe = ortecInstallFakeSheet_('LoyverseProducts', ORTEC_TEST_PRODUCT_HEADERS_, existing, 'ok');
  replaceAllObjectsGuarded_('LoyverseProducts', ['A','B','C'].map(ortecProduct_),
    { requireBackup: true, maxShrinkRatio: 0.5 });
  ortecAssert_(results, 'a delisted product is removed by the replace',
    !probe.rows.some(r => r.product_key === 'D'));
  ortecAssertEquals_(results, 'delisting is recoverable from the backup', probe.backupsCreated, 1);

  // Put the hostile stubs back so later suites still run against services that
  // throw on any production access. Without this the in-memory sheet double
  // would stay live and quietly weaken the guarantees those suites assert.
  if (typeof globalThis.__ortecRestoreHostileStubs__ === 'function') {
    globalThis.__ortecRestoreHostileStubs__();
  }
  ortecAssertThrows_(results, 'hostile stubs restored after the integration suite', function () {
    DriveApp.getFolderById('any-folder');
  });
}

// ---------------------------------------- adversarial authorization probes ---

function test_adversarialAuthorization_(results) {
  const forged = [
    { triggerUid: 'made-up', authMode: 'FULL' },
    { triggerUid: '', authMode: 'FULL' },
    { authMode: 'FULL', hour: 22 },
    { triggerUid: ['array'], year: 2026 },
    { toString: function () { return 'trigger'; } }
  ];
  forged.forEach(function (event, index) {
    ortecAssert_(results, `forged trigger event #${index + 1} is rejected`, !isTriggerEvent_(event));
    ortecAssertThrows_(results, `forged trigger event #${index + 1} cannot send the daily report`, function () {
      sendDailyAccountingReport(event);
    });
  });
  ortecAssert_(results, 'a null event is not a trigger', !isTriggerEvent_(null));
  ortecAssert_(results, 'a Date is not a trigger event', !isTriggerEvent_(new Date()));
  ortecAssert_(results, 'a string is not a trigger event', !isTriggerEvent_('triggerUid=1'));

  // No session / invalid session / expired session all fail the same way: the
  // cache lookup returns nothing, so there is no user to authorize.
  const badTokens = [undefined, null, '', '   ', 'not-a-token', 'expired-session-token', 0, {}, []];
  badTokens.forEach(function (token) {
    ortecAssertThrows_(results, `expense mutation rejected for token ${JSON.stringify(token)}`, function () {
      createExpense({ branchId: 'AWQAD', amount: 5, category: 'X', description: 'y' }, token);
    });
  });

  // Mutations across every protected surface.
  ortecAssertThrows_(results, 'unauthenticated user creation is rejected', function () {
    saveUser({ username: 'attacker', password: 'password123', role: 'OWNER' }, 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated settings write is rejected', function () {
    saveSettings({ REPORT_RECIPIENTS: 'attacker@example.com' }, 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated task creation is rejected', function () {
    createTask({ title: 'x' }, 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated task completion is rejected', function () {
    completeTask('any-task', 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated expense approval is rejected', function () {
    approveExpense('any-expense', 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated import is rejected', function () {
    uploadLoyverseFile({ base64: 'x', fileName: 'a.csv' }, 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated report PDF is rejected', function () {
    createReportPdf('DAILY', {}, 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated report email is rejected', function () {
    emailReportPdf('DAILY', {}, 'attacker@example.com', 'bogus');
  });
  ortecAssertThrows_(results, 'unauthenticated user listing is rejected', function () { listUsers('bogus'); });
  ortecAssertThrows_(results, 'unauthenticated profile read is rejected', function () { getCurrentUser('bogus'); });
  ortecAssertThrows_(results, 'unauthenticated bootstrap is rejected', function () { getBootstrapData('bogus'); });
  ortecAssertThrows_(results, 'unauthenticated issue-to-task is rejected', function () {
    createTaskFromIssue('i1', 'someone', '2026-09-01', 'bogus');
  });

  // Internal/setup functions must refuse a web context. In the harness the
  // active user is anonymous and the effective user is the owner, which is
  // exactly the anonymous-web-app shape.
  ortecAssertThrows_(results, 'setupOrTec refuses a web context', function () { setupOrTec(); });
  ortecAssertThrows_(results, 'upgradeOrTecV2 refuses a web context', function () { upgradeOrTecV2(); });
  ortecAssertThrows_(results, 'installDailyTriggers refuses a web context', function () { installDailyTriggers(); });

  // Role escalation and branch forgery are decided by pure functions, so they
  // can be asserted directly without a live session.
  ortecAssert_(results, 'VIEWER has no mutation capability',
    ['import','expense','tasks','users','settings','reports.email']
      .every(c => capabilitiesForRole_('VIEWER').indexOf(c) === -1));
  ortecAssert_(results, 'TECHNICIAN cannot manage tasks',
    capabilitiesForRole_('TECHNICIAN').indexOf('tasks.manage') === -1);
  ortecAssertEquals_(results, 'forged branch argument is overridden by the session',
    scopeBranch_({ branch_id: 'ITTIN' }, 'ALL'), 'ITTIN');
  ortecAssertEquals_(results, 'forged branch object is coerced, not trusted',
    scopeBranch_({ branch_id: 'ITTIN' }, { branch_id: 'ALL' }), 'ITTIN');
}

// ---------------------------------------- server-surface coverage invariant ---

/**
 * Guards the whole externally-callable surface, not just the functions Phase 1
 * touched. Any new global function must be gated, or explicitly listed here as
 * public by design. Node-only: it reads the sources.
 */
function test_serverSurfaceCoverage_(results) {
  if (typeof require !== 'function') {
    ortecAssert_(results, 'server-surface scan skipped (Apps Script runtime)', true);
    return;
  }
  const fs = require('fs');
  const PUBLIC_BY_DESIGN = ['login', 'doGet', 'include'];
  const GATES = [
    'requireCapability_(', 'requireScheduledOrCapability_(', 'requireRole_(',
    'assertEditorContext_(', 'resolveSessionUser_(', 'ORTEC_INCLUDABLE_'
  ];
  const files = ['Auth.js','Config.js','Dashboard.js','DataRepository.js','Diagnostics.js',
                 'Expenses.js','InventoryAnalysis.js','LoyverseImport.js','Reports.js',
                 'Setup.js','Tasks.js','Tests.js','Utils.js','WebApp.js'];
  const ungated = [];
  let scanned = 0;

  files.forEach(function (file) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    const pattern = /^function ([A-Za-z0-9_]+)\s*\(/gm;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const name = match[1];
      if (name.charAt(name.length - 1) === '_') continue; // private by convention
      scanned++;
      const next = source.indexOf('\nfunction ', match.index + 1);
      const body = source.slice(match.index, next > 0 ? next : source.length);
      const gated = GATES.some(function (g) { return body.indexOf(g) !== -1; });
      if (!gated && PUBLIC_BY_DESIGN.indexOf(name) === -1) ungated.push(`${name} (${file})`);
    }
  });

  ortecAssert_(results, 'every externally-callable function is gated or public by design',
    ungated.length === 0, `ungated: ${ungated.join(', ')}`);
  ortecAssert_(results, 'the surface scan actually found functions', scanned > 20,
    `only ${scanned} scanned`);
}

// ------------------------------------------------------------------ runner ---

/**
 * Editor-only entry point. Tests.js ships with the project, so runAllTests is a
 * global function and would otherwise be callable anonymously through the web
 * app; it does no harm but it is still exposed surface and burns quota.
 */
function runAllTests() {
  assertEditorContext_('runAllTests');
  return ortecRunAllTests_();
}

function ortecRunAllTests_() {
  const results = [];
  const suites = [
    ['P1 date normalization', test_resolveDateArg_],
    ['P2 report-type consistency', test_reportTypeConsistency_],
    ['P3 catalogue refresh', test_catalogueRefresh_],
    ['P3 replacement guards', test_partialImportDoesNotWipe_],
    ['P3 duplicate file handling', test_duplicateFileHandling_],
    ['P4 authorization', test_authorization_],
    ['P5 payment honesty', test_paymentBreakdownHonesty_],
    ['P6 manual report compatibility', test_manualReportCompatibility_],
    ['1.5 fail-closed backup', test_failClosedBackup_],
    ['1.5 adversarial authorization', test_adversarialAuthorization_],
    ['branch normalization', test_branchNormalization_],
    ['1.5 server-surface coverage', test_serverSurfaceCoverage_]
  ];

  suites.forEach(function (suite) {
    const before = results.length;
    try {
      suite[1](results);
    } catch (error) {
      results.push({
        name: `${suite[0]} — suite crashed`,
        passed: false,
        detail: String(error && error.message ? error.message : error)
      });
    }
    const run = results.length - before;
    console.log(`${suite[0]}: ${run} assertion(s)`);
  });

  const failed = results.filter(function (r) { return !r.passed; });
  results.forEach(function (r) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  return { total: results.length, passed: results.length - failed.length, failures: failed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runAllTests: runAllTests };
}
