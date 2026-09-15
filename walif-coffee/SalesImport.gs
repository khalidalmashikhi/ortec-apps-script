/**
 * Loyverse CSV import: parse → validate → preview → import (deduplicated, batched, locked).
 */

// ---------------------------------------------------------------- CSV parsing (RFC 4180, BOM-safe)

function parseCsv_(text) {
  text = String(text || '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var rows = [], row = [], field = '', inQ = false, started = false, i = 0, n = text.length;
  while (i < n) {
    var c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    // A quote only opens a quoted field at the very start of the field (RFC 4180); elsewhere it is literal.
    if (c === '"' && !started) { inQ = true; started = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; started = false; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; started = false; i++; continue; }
    field += c; started = true; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // drop fully empty rows
  return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
}

/** Map header names → column index, case/space-insensitive. */
function mapHeaders_(headerRow) {
  var norm = function (s) { return String(s || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_]+/g, ' '); };
  var idx = {};
  headerRow.forEach(function (h, i) { var k = norm(h); if (k && idx[k] === undefined) idx[k] = i; });
  var map = {}, missing = [];
  WC.LOYVERSE_COLUMNS.forEach(function (col) {
    var k = norm(col);
    if (idx[k] !== undefined) map[col] = idx[k];
  });
  WC.LOYVERSE_REQUIRED.forEach(function (col) { if (map[col] === undefined) missing.push(col); });
  return { map: map, missing: missing };
}

function uniqueKey_(rec) {
  return [rec.Store, rec['Receipt number'], rec._dateIso, rec.SKU, rec.Item, rec.Quantity, money_(rec['Net sales'])]
    .map(function (v) { return String(v == null ? '' : v).trim(); }).join('|');
}

/**
 * Converts a CSV row into a normalised record. Returns {rec, reject}.
 */
function normaliseSalesRow_(row, map, lineNo) {
  var rec = {};
  WC.LOYVERSE_COLUMNS.forEach(function (col) {
    var i = map[col];
    rec[col] = i === undefined ? '' : cleanText_(row[i], 500);
  });
  WC.LOYVERSE_NUMERIC.forEach(function (col) { rec[col] = round3_(toNum_(rec[col])); });

  var date = parseLoyverseDate_(rec.Date);
  if (!date) return { reject: 'سطر ' + lineNo + ': تاريخ غير صالح "' + rec.Date + '"' };
  rec._date = date;
  rec._dateIso = fmtDateTime_(date);
  rec['Sale Date'] = fmtDate_(date);
  rec['Sale Hour'] = +fmtDate_(date, 'H');

  var type = String(rec['Receipt type']).toLowerCase().trim();
  var status = String(rec.Status).toLowerCase().trim();
  if (!rec['Receipt number']) return { reject: 'سطر ' + lineNo + ': رقم الفاتورة فارغ' };
  if (!rec.Item) return { reject: 'سطر ' + lineNo + ': اسم الصنف فارغ' };
  if (WC.ACCEPTED_RECEIPT_TYPES.indexOf(type) < 0) return { reject: 'سطر ' + lineNo + ': نوع فاتورة غير مقبول "' + rec['Receipt type'] + '"' };
  if (status && WC.REJECTED_STATUSES.indexOf(status) >= 0) return { reject: 'سطر ' + lineNo + ': حالة الفاتورة "' + rec.Status + '" مستبعدة' };

  // Refunds must be negative. Loyverse usually exports them negative already; normalise either way.
  if (type === 'refund') {
    ['Quantity', 'Gross sales', 'Discounts', 'Net sales', 'Cost of goods', 'Gross profit', 'Taxes'].forEach(function (c) {
      if (rec[c] > 0) rec[c] = -rec[c];
    });
  }
  rec['Receipt type'] = type === 'refund' ? 'Refund' : 'Sale';
  rec['Unique Key'] = uniqueKey_(rec);
  return { rec: rec };
}

/** Parses + validates + summarises. Used by both preview and import. */
function analyseSalesCsv_(csvText, fileName) {
  if (csvText.length > WC.MAX_CSV_CHARS) throw new Error('حجم الملف كبير جدًا.');
  var rows = parseCsv_(csvText);
  if (rows.length < 2) throw new Error('الملف فارغ أو لا يحتوي على بيانات.');
  var hm = mapHeaders_(rows[0]);
  if (hm.missing.length) throw new Error('الأعمدة الأساسية ناقصة: ' + hm.missing.join(', '));

  var existing = existingSalesKeys_();
  var seen = {};
  var accepted = [], rejected = [], duplicatesInFile = 0, duplicatesExisting = 0;
  var receipts = {}, minDate = null, maxDate = null;

  for (var r = 1; r < rows.length; r++) {
    var res = normaliseSalesRow_(rows[r], hm.map, r + 1);
    if (res.reject) { rejected.push(res.reject); continue; }
    var rec = res.rec, key = rec['Unique Key'];
    if (seen[key]) { duplicatesInFile++; continue; }
    seen[key] = true;
    if (existing[key]) { duplicatesExisting++; continue; }
    accepted.push(rec);
    receipts[rec['Receipt number']] = true;
    if (!minDate || rec._date < minDate) minDate = rec._date;
    if (!maxDate || rec._date > maxDate) maxDate = rec._date;
  }

  var sum = function (k) { return round3_(accepted.reduce(function (t, x) { return t + x[k]; }, 0)); };
  var summary = {
    fileName: cleanText_(fileName, 200) || 'sales.csv',
    totalRows: rows.length - 1,
    acceptedRows: accepted.length,
    rejectedRows: rejected.length,
    duplicateRows: duplicatesInFile + duplicatesExisting,
    duplicatesInFile: duplicatesInFile,
    duplicatesExisting: duplicatesExisting,
    dateFrom: minDate ? fmtDate_(minDate) : '',
    dateTo: maxDate ? fmtDate_(maxDate) : '',
    receipts: Object.keys(receipts).length,
    quantity: sum('Quantity'),
    grossSales: sum('Gross sales'),
    discounts: sum('Discounts'),
    netSales: sum('Net sales'),
    costOfGoods: sum('Cost of goods'),
    grossProfit: sum('Gross profit'),
    taxes: sum('Taxes'),
    refunds: accepted.filter(function (x) { return x['Receipt type'] === 'Refund'; }).length,
    rejectedSamples: rejected.slice(0, 20),
    columnsFound: Object.keys(hm.map).length,
    columnsMissingOptional: WC.LOYVERSE_COLUMNS.filter(function (c) { return hm.map[c] === undefined; })
  };
  return { summary: summary, accepted: accepted };
}

function existingSalesKeys_() {
  var sh = getSheet_(WC.SHEETS.SALES_RAW);
  var headers = headersOf_(sh);
  var col = headers.indexOf('Unique Key');
  var last = sh.getLastRow();
  var set = {};
  if (col < 0 || last < 2) return set;
  var vals = sh.getRange(2, col + 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) { var k = String(vals[i][0]); if (k) set[k.charAt(0) === "'" ? k.slice(1) : k] = true; }
  return set;
}

// ---------------------------------------------------------------- API

function api_previewSalesCsv(token, csvText, fileName) {
  return apiCall_('api_previewSalesCsv', token, null, function (actor) {
    var a = analyseSalesCsv_(String(csvText || ''), fileName);
    logAudit_(actor, 'UPLOAD_FILE', 'Sales', '', 'preview ' + a.summary.fileName + ' rows=' + a.summary.totalRows, 'OK');
    return { ok: true, preview: a.summary };
  });
}

function api_importSalesCsv(token, csvText, fileName) {
  return apiCall_('api_importSalesCsv', token, null, function (actor) {
    return withLock_(function () {
      var a = analyseSalesCsv_(String(csvText || ''), fileName);
      var s = a.summary;
      var importId = newId_('IMP');
      var t = now_();
      var objs = a.accepted.map(function (rec) {
        var o = {};
        WC.LOYVERSE_COLUMNS.forEach(function (c) { o[c] = rec[c]; });
        o.Date = rec._date;
        o['Internal ID'] = newId_('SAL');
        o['Import ID'] = importId;
        o['Imported At'] = t;
        o['Imported By'] = actor.username;
        o['Unique Key'] = rec['Unique Key'];
        o['Source File Name'] = s.fileName;
        o['Record Status'] = WC.STATUS.ACTIVE;
        o['Sale Date'] = rec['Sale Date'];
        o['Sale Hour'] = rec['Sale Hour'];
        return o;
      });
      var status = 'OK', errorMsg = '';
      try {
        appendObjects_(WC.SHEETS.SALES_RAW, objs);
      } catch (e) {
        status = 'FAILED'; errorMsg = e.message; logError_('api_importSalesCsv', actor, e, importId);
        throw e;
      } finally {
        appendObjects_(WC.SHEETS.SALES_IMPORTS, [{
          'Import ID': importId, 'File Name': s.fileName, 'Uploaded At': t, 'Uploaded By': actor.username,
          'Date From': s.dateFrom, 'Date To': s.dateTo, 'Total Rows': s.totalRows, 'Imported Rows': objs.length,
          'Duplicate Rows': s.duplicateRows, 'Rejected Rows': s.rejectedRows, 'Net Sales': s.netSales,
          'Cost of Goods': s.costOfGoods, 'Gross Profit': s.grossProfit, Status: status, 'Error Message': errorMsg
        }]);
        logAudit_(actor, 'IMPORT_SALES', 'Sales', importId,
          'file=' + s.fileName + ' imported=' + objs.length + ' dup=' + s.duplicateRows + ' rejected=' + s.rejectedRows + ' net=' + money_(s.netSales), status);
      }
      return { ok: true, importId: importId, imported: objs.length, duplicates: s.duplicateRows, rejected: s.rejectedRows,
        netSales: s.netSales, dateFrom: s.dateFrom, dateTo: s.dateTo, rejectedSamples: s.rejectedSamples };
    });
  });
}

function api_listImports(token, limit) {
  return apiCall_('api_listImports', token, null, function (actor) {
    var rows = readRows_(WC.SHEETS.SALES_IMPORTS);
    if (actor.role !== WC.ROLES.MANAGER) rows = rows.filter(function (r) { return String(r['Uploaded By']) === actor.username; });
    var n = Math.min(Math.max(toNum_(limit) || 30, 1), 200);
    return { ok: true, rows: rows.slice(-n).reverse().map(function (r) {
      delete r._row; r['Date From'] = dateCell_(r['Date From']); r['Date To'] = dateCell_(r['Date To']); return r;
    }) };
  });
}

/** Active sales rows with a derived date string, shared by dashboard + reports. */
function loadSales_() {
  return readRows_(WC.SHEETS.SALES_RAW).filter(function (r) { return String(r['Record Status'] || 'ACTIVE') === 'ACTIVE'; })
    .map(function (r) {
      r._d = dateCell_(r['Sale Date']) || dateCell_(r.Date);
      r._hour = r['Sale Hour'] !== '' && r['Sale Hour'] != null ? +r['Sale Hour'] : (r.Date instanceof Date ? +fmtDate_(r.Date, 'H') : 0);
      WC.LOYVERSE_NUMERIC.forEach(function (c) { r[c] = toNum_(r[c]); });
      return r;
    });
}
