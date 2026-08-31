#!/usr/bin/env node
/**
 * Local runner for the OrTec regression suite.
 *
 * Loads the Apps Script sources into a sandboxed context backed by stub Google
 * services, then runs Tests.js. The stubs are deliberately hostile: anything
 * that would touch production (a sheet write, an email, a Drive file, a trigger
 * change) throws immediately, so a test that violates the safety contract fails
 * loudly instead of silently doing damage when the same file runs for real.
 *
 * This file is developer tooling and is excluded from clasp push via .claspignore.
 *
 *   node tools/run-tests.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TZ_OFFSET_MINUTES = 4 * 60; // Asia/Muscat, UTC+4, no DST

function forbid(api) {
  return new Proxy({}, {
    get(_target, prop) {
      return () => {
        throw new Error(`SAFETY VIOLATION: test touched ${api}.${String(prop)}()`);
      };
    }
  });
}

function formatInTz(date, pattern) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60 * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fields = {
    yyyy: pad(shifted.getUTCFullYear(), 4),
    MM: pad(shifted.getUTCMonth() + 1),
    dd: pad(shifted.getUTCDate()),
    HH: pad(shifted.getUTCHours()),
    mm: pad(shifted.getUTCMinutes()),
    ss: pad(shifted.getUTCSeconds())
  };
  // Single pass so quoted literals (e.g. the 'T' in yyyy-MM-dd'T'HH:mm:ss) are
  // emitted verbatim and never rescanned as field tokens.
  return pattern.replace(/'([^']*)'|yyyy|MM|dd|HH|mm|ss/g,
    (token, quoted) => (quoted !== undefined ? quoted : fields[token]));
}

const Utilities = {
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  formatDate: (date, _tz, pattern) => formatInTz(date, pattern),
  computeDigest(_algorithm, text) {
    // Apps Script returns signed bytes; mirror that so sha256_ produces the
    // same hex string here as it does in production.
    return Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest())
      .map(b => (b > 127 ? b - 256 : b));
  },
  getUuid: () => crypto.randomUUID(),
  parseCsv: text => text.trim().split('\n').map(line => line.split(',')),
  newBlob: () => { throw new Error('SAFETY VIOLATION: test created a Blob'); },
  base64Decode: () => { throw new Error('SAFETY VIOLATION: test decoded an upload'); }
};

const LockService = {
  getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined })
};

const CacheService = {
  getScriptCache: () => ({
    get: () => null,          // no session exists, so protected calls must throw
    put: () => { throw new Error('SAFETY VIOLATION: test wrote to the session cache'); },
    remove: () => undefined
  })
};

const ScriptApp = {
  getProjectTriggers: () => [], // no installed triggers => forged events are rejected
  newTrigger: () => { throw new Error('SAFETY VIOLATION: test created a trigger'); },
  deleteTrigger: () => { throw new Error('SAFETY VIOLATION: test deleted a trigger'); }
};

const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: () => null,
    setProperty: () => { throw new Error('SAFETY VIOLATION: test wrote a script property'); }
  })
};

const Session = {
  getActiveUser: () => ({ getEmail: () => '' }),
  getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' })
};

const sandbox = {
  Utilities,
  CacheService,
  LockService,
  ScriptApp,
  PropertiesService,
  Session,
  SpreadsheetApp: forbid('SpreadsheetApp'),
  DriveApp: forbid('DriveApp'),
  MailApp: forbid('MailApp'),
  GmailApp: forbid('GmailApp'),
  DocumentApp: forbid('DocumentApp'),
  HtmlService: forbid('HtmlService'),
  UrlFetchApp: forbid('UrlFetchApp'),
  console,
  require,
  module: undefined,
  // Lets the integration tests swap service globals to prove ordering
  // (backup-before-clear). Absent in Apps Script, where those tests skip.
  __ORTEC_TEST_HARNESS__: true
};
sandbox.globalThis = sandbox;

// Snapshot the hostile stubs so the integration suite can restore them. Without
// this, the in-memory sheet double it installs would stay live for later suites
// and quietly weaken the "no production writes" guarantee they rely on.
const HOSTILE_STUBS = {
  SpreadsheetApp: sandbox.SpreadsheetApp,
  DriveApp: sandbox.DriveApp,
  PropertiesService: sandbox.PropertiesService,
  newBlob: Utilities.newBlob
};
sandbox.__ortecRestoreHostileStubs__ = () => {
  sandbox.SpreadsheetApp = HOSTILE_STUBS.SpreadsheetApp;
  sandbox.DriveApp = HOSTILE_STUBS.DriveApp;
  sandbox.PropertiesService = HOSTILE_STUBS.PropertiesService;
  Utilities.newBlob = HOSTILE_STUBS.newBlob;
};

// Config.js first so ORTEC and the shared helpers are defined before anything
// that reads them at load time; the rest are plain function declarations.
const SOURCES = [
  'Config.js', 'Auth.js', 'DataRepository.js', 'Dashboard.js', 'Expenses.js',
  'InventoryAnalysis.js', 'LoyverseImport.js', 'Reports.js', 'Setup.js',
  'Tasks.js', 'Utils.js', 'WebApp.js', 'Diagnostics.js', 'Recovery.js', 'Tests.js'
];

const context = vm.createContext(sandbox);
for (const file of SOURCES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.error(`missing source: ${file}`);
    process.exit(2);
  }
  try {
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: file });
  } catch (error) {
    console.error(`failed to load ${file}: ${error.message}`);
    process.exit(2);
  }
}

process.chdir(ROOT); // so the payment-honesty source check can read Dashboard.js
const summary = vm.runInContext('ortecRunAllTests_()', context);

console.log('');
if (summary.failures.length) {
  console.log(`FAILED — ${summary.failures.length} of ${summary.total} assertions`);
  summary.failures.forEach(f => console.log(`  ✗ ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  process.exit(1);
}
console.log(`OK — ${summary.passed}/${summary.total} assertions passed`);
