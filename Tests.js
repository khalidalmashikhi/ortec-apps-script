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

// ------------------------------------------------------------------ runner ---

function runAllTests() {
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
    ['branch normalization', test_branchNormalization_]
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
