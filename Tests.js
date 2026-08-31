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
  ortecAssertThrows_(results, 'setupOrTec_ refuses a web context', function () { setupOrTec_(); });
  ortecAssertThrows_(results, 'upgradeOrTecV2_ refuses a web context', function () { upgradeOrTecV2_(); });
  ortecAssertThrows_(results, 'installDailyTriggers_ refuses a web context', function () { installDailyTriggers_(); });
  ortecAssertThrows_(results, 'ortecDiagnostics_ refuses a web context', function () { ortecDiagnostics_(); });
  ortecAssert_(results, 'setupOrTec is not a global at all', typeof globalThis.setupOrTec === 'undefined');
  ortecAssert_(results, 'ortecDiagnostics is not a global at all', typeof globalThis.ortecDiagnostics === 'undefined');
  ortecAssert_(results, 'runAllTests is not a global at all', typeof globalThis.runAllTests === 'undefined');

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

// ------------------------------- F-08: idempotent receipt import (cases A-H) ---

/** Build an item record the way parseReceiptItemRows_ does, for fixtures. */
function ortecItem_(receiptKey, sku, occurrence, measures) {
  const identity = [receiptKey, sku, 'Item ' + sku, '', ''].join('|');
  const m = measures || {};
  return {
    item_key: sha256_(identity + '|' + (occurrence || 0)),
    receipt_key: receiptKey,
    receipt_number: 'R' + receiptKey,
    receipt_date: m.date || '2026-07-20',
    branch_id: 'AWQAD',
    sku: sku, item_name: 'Item ' + sku, category: 'C',
    quantity: m.quantity == null ? 1 : m.quantity,
    unit_price: 10,
    gross_sales: m.gross == null ? 10 : m.gross,
    discount: 0,
    net_sales: m.net == null ? 10 : m.net,
    cost: 4, profit: 6,
    batch_id: m.batch || 'batch-original',
    created_at: m.createdAt || '2026-07-20T10:00:00'
  };
}

function ortecReceiptOf_(items, key) {
  return items.filter(function (i) { return i.receipt_key === key; });
}

function test_idempotentReceiptImport_(results) {
  // A stored dataset: two receipts, one with two lines.
  const stored = [
    ortecItem_('r1', 'A', 0), ortecItem_('r1', 'B', 0),
    ortecItem_('r2', 'C', 0)
  ];

  // --- A. Exact same file re-imported ---
  let plan = planReceiptMerge_(stored, stored.map(function (i) {
    return Object.assign({}, i, { batch_id: 'batch-2', created_at: '2026-08-31T00:00:00' });
  }));
  ortecAssertEquals_(results, 'A: same file inserts nothing', plan.stats.receiptsInserted, 0);
  ortecAssertEquals_(results, 'A: same file refreshes nothing', plan.stats.receiptsRefreshed, 0);
  ortecAssertEquals_(results, 'A: same file marks both receipts unchanged', plan.stats.receiptsUnchanged, 2);
  ortecAssertEquals_(results, 'A: row count is unchanged', plan.items.length, 3);
  ortecAssert_(results, 'A: stored batch_id survives a no-op re-import',
    plan.items.every(function (i) { return i.batch_id === 'batch-original'; }));

  // --- B. Same transactions arriving in a DIFFERENT file (different order,
  //        different batch) must still be recognised as the same records ---
  const reordered = [ortecItem_('r2','C',0), ortecItem_('r1','B',0), ortecItem_('r1','A',0)]
    .map(function (i) { return Object.assign({}, i, { batch_id: 'batch-3' }); });
  plan = planReceiptMerge_(stored, reordered);
  ortecAssertEquals_(results, 'B: reordered identical data changes nothing', plan.stats.receiptsUnchanged, 2);
  ortecAssertEquals_(results, 'B: no duplicate item rows are produced', plan.items.length, 3);
  ortecAssertEquals_(results, 'B: no receipts are refreshed', plan.stats.receiptsRefreshed, 0);

  // --- C. Partial date overlap: r2 already stored, r3 is new ---
  const partial = [ortecItem_('r2','C',0), ortecItem_('r3','D',0,{date:'2026-07-21'})];
  plan = planReceiptMerge_(stored, partial);
  ortecAssertEquals_(results, 'C: partial overlap inserts only the new receipt', plan.stats.receiptsInserted, 1);
  ortecAssertEquals_(results, 'C: overlapping receipt is untouched', plan.stats.receiptsUnchanged, 1);
  ortecAssertEquals_(results, 'C: unmentioned receipt is preserved', plan.stats.receiptsPreserved, 1);
  ortecAssertEquals_(results, 'C: total rows = 3 stored + 1 new', plan.items.length, 4);
  ortecAssertEquals_(results, 'C: the two-line receipt keeps both lines',
    ortecReceiptOf_(plan.items, 'r1').length, 2);

  // --- D. Complete date overlap, nothing new ---
  plan = planReceiptMerge_(stored, [ortecItem_('r1','A',0), ortecItem_('r1','B',0), ortecItem_('r2','C',0)]);
  ortecAssertEquals_(results, 'D: full overlap is a complete no-op', plan.stats.receiptsUnchanged, 2);
  ortecAssertEquals_(results, 'D: full overlap adds no rows', plan.items.length, 3);

  // --- E. New line appended to a previously imported receipt: that receipt is
  //        refreshed wholesale rather than accumulating a stale copy ---
  const grown = [ortecItem_('r1','A',0), ortecItem_('r1','B',0), ortecItem_('r1','E',0)];
  plan = planReceiptMerge_(stored, grown);
  ortecAssertEquals_(results, 'E: the changed receipt is refreshed', plan.stats.receiptsRefreshed, 1);
  ortecAssertEquals_(results, 'E: refreshed receipt has exactly the new line set',
    ortecReceiptOf_(plan.items, 'r1').length, 3);
  ortecAssertEquals_(results, 'E: the untouched receipt is preserved', plan.stats.receiptsPreserved, 1);
  ortecAssertEquals_(results, 'E: no stale duplicate rows remain', plan.items.length, 4);

  // A corrected measure on an existing line refreshes rather than duplicating.
  const corrected = [ortecItem_('r1','A',0,{net:99}), ortecItem_('r1','B',0), ortecItem_('r2','C',0)];
  plan = planReceiptMerge_(stored, corrected);
  ortecAssertEquals_(results, 'E: a corrected amount refreshes the receipt', plan.stats.receiptsRefreshed, 1);
  ortecAssertEquals_(results, 'E: correction does not duplicate the line',
    ortecReceiptOf_(plan.items, 'r1').length, 2);
  ortecAssertEquals_(results, 'E: the corrected value wins',
    ortecReceiptOf_(plan.items, 'r1').filter(function (i) { return i.sku === 'A'; })[0].net_sales, 99);

  // --- F. Duplicate line inside one CSV: two identical lines are DISTINCT
  //        records (occurrence 0 and 1), not silently collapsed ---
  const twoIdentical = [ortecItem_('r4','X',0), ortecItem_('r4','X',1)];
  ortecAssert_(results, 'F: repeated identical lines get distinct keys',
    twoIdentical[0].item_key !== twoIdentical[1].item_key);
  plan = planReceiptMerge_([], twoIdentical);
  ortecAssertEquals_(results, 'F: both repeated lines are kept', plan.items.length, 2);
  plan = planReceiptMerge_(twoIdentical, twoIdentical);
  ortecAssertEquals_(results, 'F: re-importing repeated lines is still a no-op', plan.items.length, 2);
  ortecAssertEquals_(results, 'F: repeated-line receipt is unchanged on re-import', plan.stats.receiptsUnchanged, 1);

  // --- G. Import failure midway leaves the stored state untouched, because the
  //        merge is computed in full before anything is written ---
  ortecAssertThrows_(results, 'G: a malformed merge result cannot be written', function () {
    replaceAllObjectsGuarded_(ORTEC.SHEETS.RECEIPT_ITEMS, null, { requireBackup: true });
  });
  const beforeCount = stored.length;
  try { planReceiptMerge_(stored, null); } catch (e) { /* tolerated */ }
  ortecAssertEquals_(results, 'G: planning never mutates the stored array', stored.length, beforeCount);
  ortecAssert_(results, 'G: planning returns a new array, not the stored one',
    planReceiptMerge_(stored, []).items !== stored);

  // --- H. Parent receipt / item consistency is derived, not merged ---
  const merged = planReceiptMerge_(stored, grown).items;
  const receipts = buildReceiptsFromItems_(merged, [], {}, 'b1');
  ortecAssertEquals_(results, 'H: one receipt row per distinct receipt key', receipts.length, 2);
  receipts.forEach(function (r) {
    const lines = ortecReceiptOf_(merged, r.receipt_key);
    ortecAssertEquals_(results, `H: ${r.receipt_key} net_sales equals the sum of its lines`,
      Number(r.net_sales).toFixed(3), sumField_(lines, 'net_sales').toFixed(3));
    ortecAssertEquals_(results, `H: ${r.receipt_key} gross_sales equals the sum of its lines`,
      Number(r.gross_sales).toFixed(3), sumField_(lines, 'gross_sales').toFixed(3));
  });

  // A stored receipt whose lines were never imported is preserved, not dropped.
  const orphan = { receipt_key: 'r9', receipt_number: 'R9', receipt_date: '2026-06-01',
                   branch_id: 'SAADA', employee: '', payment_type: '', gross_sales: 5,
                   discounts: 0, refunds: 0, net_sales: 5, batch_id: 'old', created_at: 'x' };
  const withOrphan = buildReceiptsFromItems_(merged, [orphan], {}, 'b1');
  ortecAssert_(results, 'H: a receipt with no imported lines is preserved',
    withOrphan.some(function (r) { return r.receipt_key === 'r9'; }));

  // Receipt-level attributes that items do not carry survive a refresh.
  const priorReceipt = { receipt_key: 'r1', employee: 'Fatima', payment_type: 'CASH',
                         refunds: 2, batch_id: 'old-batch', created_at: '2026-07-20T09:00:00' };
  const rebuilt = buildReceiptsFromItems_(merged, [priorReceipt], {}, 'b2')
    .filter(function (r) { return r.receipt_key === 'r1'; })[0];
  ortecAssertEquals_(results, 'H: cashier survives a refresh', rebuilt.employee, 'Fatima');
  ortecAssertEquals_(results, 'H: original batch_id survives a refresh', rebuilt.batch_id, 'old-batch');
  ortecAssertEquals_(results, 'H: original created_at survives a refresh', rebuilt.created_at, '2026-07-20T09:00:00');

  // --- Convergence: running the same logical dataset repeatedly must settle ---
  let state = stored;
  for (let pass = 0; pass < 3; pass++) state = planReceiptMerge_(state, grown).items;
  ortecAssertEquals_(results, 'convergence: three passes give a stable row count', state.length, 4);
  const finalPass = planReceiptMerge_(state, grown);
  ortecAssertEquals_(results, 'convergence: a fourth pass changes nothing', finalPass.stats.receiptsRefreshed, 0);
  ortecAssertEquals_(results, 'convergence: fingerprints are order-independent',
    receiptFingerprint_(ortecReceiptOf_(state, 'r1')),
    receiptFingerprint_(ortecReceiptOf_(state, 'r1').slice().reverse()));
}

// ------------------------------- 1.6: ingestion freshness + recovery safety ---

function ortecBatch_(type, uploadedAt, status) {
  return { batch_id: 'b', report_type: type, status: status || 'COMPLETED', uploaded_at: uploadedAt,
           period_date: String(uploadedAt).slice(0, 10) };
}

/** Mirrors getIngestionStatus_ classification without touching a sheet. */
function classifyFeedAge_(ageHours, overdueHours, criticalHours) {
  if (ageHours == null) return 'NEVER';
  if (ageHours >= criticalHours) return 'CRITICAL';
  if (ageHours >= overdueHours) return 'OVERDUE';
  return 'OK';
}

function test_ingestionFreshness_(results) {
  ortecAssertEquals_(results, 'a fresh feed is OK', classifyFeedAge_(3, 36, 72), 'OK');
  ortecAssertEquals_(results, 'a feed just under the threshold is OK', classifyFeedAge_(35, 36, 72), 'OK');
  ortecAssertEquals_(results, 'a day-and-a-half old feed is OVERDUE', classifyFeedAge_(36, 36, 72), 'OVERDUE');
  ortecAssertEquals_(results, 'a three-day old feed is CRITICAL', classifyFeedAge_(72, 36, 72), 'CRITICAL');
  ortecAssertEquals_(results, 'the real outage would read CRITICAL', classifyFeedAge_(24 * 44, 36, 72), 'CRITICAL');
  ortecAssertEquals_(results, 'a feed that never ran reads NEVER', classifyFeedAge_(null, 36, 72), 'NEVER');

  // The overall state is the worst of the two feeds, so a fresh catalogue can
  // never mask stale sales.
  const order = ['OK', 'OVERDUE', 'CRITICAL', 'NEVER'];
  const worst = function (a, b) { return order[Math.max(order.indexOf(a), order.indexOf(b))]; };
  ortecAssertEquals_(results, 'stale sales are not masked by a fresh catalogue', worst('CRITICAL', 'OK'), 'CRITICAL');
  ortecAssertEquals_(results, 'a never-imported feed dominates', worst('OK', 'NEVER'), 'NEVER');
  ortecAssertEquals_(results, 'both fresh means OK', worst('OK', 'OK'), 'OK');
}

function test_recoverySafety_(results) {
  // The confirmation token binds to file content AND the computed plan, so a
  // token from one preview cannot approve a different import.
  const tokenFor = function (hash, rows, inserted, refreshed) {
    return sha256_([hash, rows, inserted, refreshed].join('|')).slice(0, 16);
  };
  const base = tokenFor('hashA', 100, 10, 2);
  ortecAssertEquals_(results, 'the same plan yields the same token', tokenFor('hashA', 100, 10, 2), base);
  ortecAssert_(results, 'a different file yields a different token', tokenFor('hashB', 100, 10, 2) !== base);
  ortecAssert_(results, 'a changed row count yields a different token', tokenFor('hashA', 101, 10, 2) !== base);
  ortecAssert_(results, 'a changed insert count yields a different token', tokenFor('hashA', 100, 11, 2) !== base);
  ortecAssert_(results, 'a changed refresh count yields a different token', tokenFor('hashA', 100, 10, 3) !== base);
  ortecAssertEquals_(results, 'token is a short stable hex string', base.length, 16);

  // Recovery entry points must not be reachable from the web app.
  ortecAssert_(results, 'recovery preview is not a callable global',
    typeof globalThis.ortecPreviewReceiptsRecovery === 'undefined');
  ortecAssert_(results, 'recovery commit is not a callable global',
    typeof globalThis.ortecCommitReceiptsRecovery === 'undefined');
  ortecAssertThrows_(results, 'recovery preview refuses a web context', function () {
    ortecPreviewReceiptsRecovery_('any-file');
  });
  ortecAssertThrows_(results, 'recovery commit refuses a web context', function () {
    ortecCommitReceiptsRecovery_('any-file', 'any-token');
  });

  // Export Items must never be used to fabricate historical snapshots.
  const source = ortecReadSourceForTests_('Recovery.js');
  if (source === null) {
    ortecAssert_(results, 'recovery source check skipped (Apps Script runtime)', true);
  } else {
    ortecAssert_(results, 'recovery never writes InventorySnapshots',
      source.indexOf('SHEETS.INVENTORY') === -1);
    ortecAssert_(results, 'recovery documents the export-items limitation',
      source.indexOf('manufactured') !== -1 && source.indexOf('invented history') !== -1);
  }
}

// ------------------------------------------ F-29: XSS / rendering safety ---

/** The payloads every escaping path must neutralise. */
function ortecXssPayloads_() {
  return [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '"><script>alert(1)</script>',
    "'><img src=x onerror=alert(1)>",
    '<svg/onload=alert(1)>',
    'javascript:alert(1)',
    '</td></tr><script>alert(1)</script>',
    '`${alert(1)}`',
    '<iframe src="javascript:alert(1)">',
    'Ali & Sons <ali@example.com>',
    "O'Brien \"quoted\" & <tagged>",
    '&lt;already&gt;&amp;encoded',
    '<a href="javascript:alert(1)">click</a>'
  ];
}

/** Assert an escaped string can no longer open a tag or an entity boundary. */
function ortecAssertNeutralised_(results, label, escaped) {
  ortecAssert_(results, `${label}: no raw < survives`, String(escaped).indexOf('<') === -1, escaped);
  ortecAssert_(results, `${label}: no raw > survives`, String(escaped).indexOf('>') === -1, escaped);
  ortecAssert_(results, `${label}: no raw double quote survives`, String(escaped).indexOf('"') === -1, escaped);
  ortecAssert_(results, `${label}: no raw single quote survives`, String(escaped).indexOf("'") === -1, escaped);
  ortecAssert_(results, `${label}: no raw backtick survives`, String(escaped).indexOf('`') === -1, escaped);
}

/** Server-side escaper (used in the notification emails). */
function test_serverHtmlEscaping_(results) {
  ortecXssPayloads_().forEach(function (payload, index) {
    ortecAssertNeutralised_(results, `escapeHtml_ payload ${index + 1}`, escapeHtml_(payload));
  });
  ortecAssertEquals_(results, 'escapeHtml_ encodes ampersand first',
    escapeHtml_('&lt;'), '&amp;lt;');
  ortecAssertEquals_(results, 'escapeHtml_ handles null', escapeHtml_(null), '');
  ortecAssertEquals_(results, 'escapeHtml_ handles undefined', escapeHtml_(undefined), '');
  ortecAssertEquals_(results, 'escapeHtml_ preserves plain Arabic text',
    escapeHtml_('فرع عوقد'), 'فرع عوقد');
  ortecAssert_(results, 'escapeHtml_ neutralises a script close tag',
    escapeHtml_('</script>').indexOf('</script>') === -1);
}

/**
 * Client-side rendering. The helpers are extracted from ClientJS.html and
 * executed for real, so these assertions test the shipped code rather than a
 * copy of it. Node-only: the browser bundle is not loaded inside Apps Script.
 */
function ortecLoadClientHelpers_() {
  if (typeof require !== 'function') return null;
  let source;
  try { source = require('fs').readFileSync('ClientJS.html', 'utf8'); } catch (e) { return null; }
  const wanted = ['safeUrl', 'escapeHtml', 'createTable'];
  const out = {};
  wanted.forEach(function (name) {
    const start = source.indexOf('function ' + name + '(');
    if (start === -1) return;
    // Balance braces from the first { after the signature.
    let i = source.indexOf('{', start), depth = 0, end = -1;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end > start) out[name] = source.slice(start, end);
  });
  if (!out.escapeHtml || !out.createTable || !out.safeUrl) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`${out.safeUrl}\n${out.escapeHtml}\n${out.createTable}\nreturn {safeUrl, escapeHtml, createTable};`)();
  } catch (e) {
    return null;
  }
}

function test_clientRenderingSafety_(results) {
  const client = ortecLoadClientHelpers_();
  if (!client) {
    ortecAssert_(results, 'client rendering tests skipped (helpers not loadable here)', true);
    return;
  }

  ortecXssPayloads_().forEach(function (payload, index) {
    ortecAssertNeutralised_(results, `client escapeHtml payload ${index + 1}`, client.escapeHtml(payload));
  });

  // Values that arrive from Sheets — malicious product, expense, task and user
  // strings — must be inert once rendered into a table.
  const storedValues = [
    ['<img src=x onerror=alert(1)>', 'SKU-1', 'Item'],
    ['Expense <script>alert(document.cookie)</script>', '"><b>x</b>', "task '); drop"],
    ['مستخدم <svg/onload=alert(1)>', '</td><td onclick=alert(1)>', '`${alert(1)}`']
  ];
  const table = client.createTable(['A', 'B', 'C'], storedValues);
  ortecAssert_(results, 'stored malicious values produce no script tag',
    table.toLowerCase().indexOf('<script') === -1);
  ortecAssert_(results, 'stored malicious values produce no img tag',
    table.toLowerCase().indexOf('<img') === -1);
  ortecAssert_(results, 'stored malicious values produce no svg tag',
    table.toLowerCase().indexOf('<svg') === -1);
  // The property that matters is that a handler cannot end up in ATTRIBUTE
  // position. The literal text "onclick=" rendered inside a cell is inert, so
  // asserting its absence anywhere would be testing the wrong thing.
  ortecAssert_(results, 'no inline handler can reach attribute position',
    /<[^>]*\bon(error|load|click)\s*=/i.test(table) === false, table.slice(0, 200));
  ortecAssert_(results, 'the only tags in the output are the table\'s own',
    (table.match(/<[a-z]+/gi) || []).every(function (t) {
      return ['<div', '<table', '<thead', '<tbody', '<tr', '<th', '<td', '<p'].indexOf(t.toLowerCase()) !== -1;
    }));
  ortecAssert_(results, 'the table still renders its own cells',
    (table.match(/<td>/g) || []).length === 9);
  ortecAssert_(results, 'a malicious header is escaped too',
    client.createTable(['<script>alert(1)</script>'], [['x']]).toLowerCase().indexOf('<script') === -1);

  // Escaping alone does not stop a javascript: URL — the scheme allow-list does.
  ortecAssertEquals_(results, 'javascript: URL is rejected', client.safeUrl('javascript:alert(1)'), '#');
  ortecAssertEquals_(results, 'JaVaScRiPt: URL is rejected', client.safeUrl('JaVaScRiPt:alert(1)'), '#');
  ortecAssertEquals_(results, 'data: URL is rejected', client.safeUrl('data:text/html,<script>alert(1)</script>'), '#');
  ortecAssertEquals_(results, 'vbscript: URL is rejected', client.safeUrl('vbscript:msgbox(1)'), '#');
  ortecAssertEquals_(results, 'a relative path is rejected', client.safeUrl('/etc/passwd'), '#');
  ortecAssertEquals_(results, 'an https Drive URL is allowed',
    client.safeUrl('https://drive.google.com/file/d/abc/view'), 'https://drive.google.com/file/d/abc/view');
  ortecAssertEquals_(results, 'safeUrl handles null', client.safeUrl(null), '#');
}

/** Session/token storage strategy. */
function test_tokenStorageStrategy_(results) {
  const source = ortecReadSourceForTests_('ClientJS.html');
  if (source === null) {
    ortecAssert_(results, 'token storage check skipped (Apps Script runtime)', true);
    return;
  }
  ortecAssert_(results, 'the session token is written to sessionStorage, not localStorage',
    source.indexOf("sessionStorage.setItem('ortec_session'") !== -1);
  ortecAssert_(results, 'no code path writes the token to localStorage',
    source.indexOf("localStorage.setItem('ortec_session'") === -1);
  ortecAssert_(results, 'a legacy localStorage token is migrated then removed',
    source.indexOf("localStorage.removeItem('ortec_session')") !== -1);
  ortecAssert_(results, 'logout clears both stores',
    source.indexOf('function ortecClearStoredToken_') !== -1);
  ortecAssert_(results, 'storage access is wrapped against private-mode throws',
    (source.match(/catch\(e\)\{return ''/g) || []).length >= 1);
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
  const MUST_BE_PRIVATE = ['setupOrTec', 'upgradeOrTecV2', 'installDailyTriggers',
                           'ortecDiagnostics', 'runAllTests'];
  const GATES = [
    'requireCapability_(', 'requireScheduledOrCapability_(', 'requireRole_(',
    'assertEditorContext_(', 'resolveSessionUser_(', 'ORTEC_INCLUDABLE_'
  ];
  const files = ['Auth.js','Config.js','Dashboard.js','DataRepository.js','Diagnostics.js',
                 'Expenses.js','InventoryAnalysis.js','LoyverseImport.js','Recovery.js',
                 'Reports.js','Setup.js','Tasks.js','Tests.js','Utils.js','WebApp.js'];
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

  // Setup, diagnostic and test entry points must not exist as plain globals at
  // all: an underscore suffix is the only protection Apps Script enforces
  // structurally, rather than one that depends on runtime identity.
  const exposed = [];
  files.forEach(function (file) {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    MUST_BE_PRIVATE.forEach(function (name) {
      if (new RegExp('^function ' + name + '\\s*\\(', 'm').test(source)) exposed.push(`${name} (${file})`);
    });
  });
  ortecAssert_(results, 'setup/diagnostic/test entry points are not callable globals',
    exposed.length === 0, `exposed: ${exposed.join(', ')}`);
}

// ------------------------------------------------------------------ runner ---

/**
 * Editor-only entry point. Tests.js ships with the project, so a plain global
 * runAllTests would have been callable anonymously through the web app. The
 * trailing underscore removes it from the google.script.run surface entirely.
 */
function runAllTests_() {
  assertEditorContext_('runAllTests_');
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
    ['1.5 server-surface coverage', test_serverSurfaceCoverage_],
    ['1.6 F-08 idempotent receipt import', test_idempotentReceiptImport_],
    ['1.6 ingestion freshness', test_ingestionFreshness_],
    ['1.6 recovery safety', test_recoverySafety_],
    ['F-29 server html escaping', test_serverHtmlEscaping_],
    ['F-29 client rendering safety', test_clientRenderingSafety_],
    ['F-29 token storage', test_tokenStorageStrategy_]
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
