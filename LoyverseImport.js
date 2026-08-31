function uploadLoyverseFile(payload, sessionToken) {
  requireCapability_('import', sessionToken);

  if (!payload || !payload.base64 || !payload.fileName) {
    throw new Error('اختر ملفًا صالحًا.');
  }

  const rawBase64 = String(payload.base64).split(',').pop();
  const bytes = Utilities.base64Decode(rawBase64);

  const blob = Utilities.newBlob(
    bytes,
    payload.mimeType || 'text/csv',
    payload.fileName
  );

  const uploadFolderId =
    PropertiesService.getScriptProperties().getProperty('UPLOAD_FOLDER_ID');

  if (!uploadFolderId) {
    throw new Error('مجلد الرفع غير مهيأ. شغّل setupOrTec أولًا.');
  }

  const storedFile = DriveApp
    .getFolderById(uploadFolderId)
    .createFile(blob);

  const fileName = String(payload.fileName).toLowerCase();

  if (!fileName.endsWith('.csv')) {
    throw new Error('ارفع ملف CSV من Loyverse.');
  }

  const csvText = blob.getDataAsString('UTF-8');

  return importLoyverseCsv_(csvText, {
    fileName: payload.fileName,
    branchId: payload.branchId || 'AUTO',
    reportDate: payload.reportDate || today_(),
    sourceFileId: storedFile.getId(),
    sessionToken: sessionToken
  });
}


function importLoyverseCsv_(csvText, meta) {
  const rows = Utilities.parseCsv(csvText);

  if (!rows || rows.length < 2) {
    throw new Error('الملف لا يحتوي بيانات.');
  }

  const originalHeaders = rows[0].map(value => String(value || '').trim());
  const normalizedHeaders = originalHeaders.map(normalizeHeader_);

  const reportType = detectReportType_(normalizedHeaders);
  const fileHash = sha256_(csvText);

  const previousImport = findBy_(
    ORTEC.SHEETS.IMPORT_BATCHES,
    'file_hash',
    fileHash
  );

  if (previousImport) {
    return {
      ok: false,
      duplicateFile: true,
      message: 'تم استيراد هذا الملف مسبقًا.',
      batch: previousImport
    };
  }

  const batchId = uuid_();
  let result;

  if (reportType === ORTEC.IMPORT_TYPES.ITEM_EXPORT) {
    result = importItemExport_(
      originalHeaders,
      normalizedHeaders,
      rows.slice(1),
      batchId,
      meta
    );
  } else if (reportType === ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM) {
    result = importReceiptsByItem_(
      normalizedHeaders,
      rows.slice(1),
      batchId,
      meta
    );
  } else {
    throw new Error(
      'نوع التقرير غير مدعوم. استخدم Export Items أو Receipts by Item من Loyverse.'
    );
  }

  appendObject_(ORTEC.SHEETS.IMPORT_BATCHES, {
    batch_id: batchId,
    file_name: meta.fileName,
    file_hash: fileHash,
    report_type: reportType,
    branch_id: meta.branchId,
    period_date: resolveDateArg_(meta.reportDate),
    total_rows: rows.length - 1,
    inserted_rows: result.inserted,
    duplicate_rows: result.duplicates,
    error_rows: result.errors,
    status: result.errors > 0
      ? 'COMPLETED_WITH_WARNINGS'
      : 'COMPLETED',
    uploaded_by: (function(u){return u.username || u.email;})(resolveSessionUser_(meta.sessionToken, true)),
    uploaded_at: nowIso_()
  });

  audit_(
    'IMPORT_BATCH',
    batchId,
    'CREATE',
    null,
    {
      reportType: reportType,
      fileName: meta.fileName,
      result: result
    }
  );

  return Object.assign(
    {
      ok: true,
      batchId: batchId,
      reportType: reportType
    },
    result
  );
}


function detectReportType_(headers) {
  const headerSet = new Set(headers);

  if (
    headerSet.has('receipt number') &&
    headerSet.has('net sales') &&
    headerSet.has('quantity') &&
    headerSet.has('store')
  ) {
    return ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM;
  }

  if (
    headerSet.has('handle') &&
    headerSet.has('sku') &&
    headers.some(header => header.indexOf('in stock [') === 0)
  ) {
    return ORTEC.IMPORT_TYPES.ITEM_EXPORT;
  }

  return 'UNKNOWN';
}


function importItemExport_(
  originalHeaders,
  normalizedHeaders,
  rows,
  batchId,
  meta
) {
  const branchColumns = findInventoryBranchColumns_(
    originalHeaders,
    normalizedHeaders
  );

  if (!branchColumns.length) {
    throw new Error('لم يتم العثور على أعمدة مخزون الفروع.');
  }

  // An Export Items file IS the current Loyverse catalogue, so the replacement
  // set must be every product/branch row the file contains — not just the rows
  // that happen to be new. The previous code built this list from unseen keys
  // only and then handed it to a whole-table replace, so re-importing a broadly
  // unchanged catalogue wiped every pre-existing product.
  const existingProducts = sheetToObjects_(ORTEC.SHEETS.PRODUCTS);
  const existingKeys = new Set(
    existingProducts.map(row => String(row.product_key || ''))
  );

  const catalogueRows = [];        // complete replacement dataset
  const seenKeysInFile = new Set(); // detects rows repeated WITHIN this file
  const snapshotRows = [];

  const stats = {
    inserted: 0,        // rows in this file not previously in the table
    unchanged: 0,       // rows already present — retained, never dropped
    duplicates: 0,      // rows repeated within this file — collapsed
    errors: 0,
    productsRead: 0,
    branchesDetected: branchColumns.map(branch => branch.branchId)
  };

  rows.forEach(row => {
    try {
      if (isEmptyRow_(row)) {
        return;
      }

      const item = rowToObject_(normalizedHeaders, row);

      const sku = cleanText_(item.sku);
      const itemName = cleanText_(item.name);
      const barcode = cleanText_(item.barcode);
      const category = cleanText_(item.category);
      const supplier = cleanText_(item.supplier);

      const cost = firstPositiveNumber_([
        item.cost,
        item['purchase cost']
      ]);

      const trackStock =
        String(item['track stock'] || '').toUpperCase() === 'Y';

      if (!sku && !itemName) {
        stats.errors++;
        return;
      }

      stats.productsRead++;

      branchColumns.forEach(branch => {
        const stock = number_(row[branch.stockIndex], 0);
        const price = number_(row[branch.priceIndex], 0);
        const lowStock = number_(row[branch.lowStockIndex], 0);

        const available =
          branch.availableIndex >= 0
            ? String(row[branch.availableIndex] || '').toUpperCase() === 'Y'
            : true;

        const productKey = sha256_(
          [
            branch.branchId,
            sku,
            barcode,
            itemName
          ].join('|')
        );

        const product = {
          product_key: productKey,
          sku: sku,
          barcode: barcode,
          item_name: itemName,
          category: category,
          cost: cost,
          price: price,
          track_stock: trackStock,
          branch_id: branch.branchId,
          stock: stock,
          low_stock_threshold: lowStock,
          batch_id: batchId,
          updated_at: nowIso_()
        };

        if (seenKeysInFile.has(productKey)) {
          // The same product/branch twice in one file: keep the first, count it.
          stats.duplicates++;
        } else {
          seenKeysInFile.add(productKey);
          catalogueRows.push(product);
          if (existingKeys.has(productKey)) stats.unchanged++;
          else stats.inserted++;
        }

        snapshotRows.push({
          snapshot_id: uuid_(),
          snapshot_date: resolveDateArg_(meta.reportDate),
          branch_id: branch.branchId,
          sku: sku,
          item_name: itemName,
          stock: stock,
          cost: cost,
          value: stock * cost,
          batch_id: batchId,
          created_at: nowIso_()
        });
      });
    } catch (error) {
      stats.errors++;
      console.error('ITEM_EXPORT row failed: %s', error && error.message ? error.message : error);
    }
  });

  // Export Items represents the latest current catalogue/stock. Replace the
  // current product table while keeping InventorySnapshots as historical daily
  // records — snapshots are append-only and are never touched by this replace.
  //
  // Order matters: validate the prepared dataset, snapshot the table, then
  // replace. replaceAllObjectsGuarded_ refuses a replacement that would shrink
  // the catalogue implausibly, so a truncated or misparsed file fails closed
  // rather than destroying the table.
  if (!catalogueRows.length) {
    throw new Error('لم يتم استخراج أي منتجات من الملف. لم يتم تعديل جدول المنتجات.');
  }
  const errorRatio = stats.productsRead > 0 ? stats.errors / (stats.productsRead + stats.errors) : 1;
  if (errorRatio > ORTEC.IMPORT_GUARD.MAX_ERROR_RATIO) {
    throw new Error(
      `تم رفض الاستيراد: ${stats.errors} صف غير صالح من أصل ${stats.productsRead + stats.errors}. ` +
      'لم يتم تعديل جدول المنتجات.'
    );
  }

  const replacement = replaceAllObjectsGuarded_(ORTEC.SHEETS.PRODUCTS, catalogueRows, {
    minRows: ORTEC.IMPORT_GUARD.MIN_CATALOGUE_ROWS,
    maxShrinkRatio: ORTEC.IMPORT_GUARD.MAX_SHRINK_RATIO,
    backupLabel: 'item_export'
  });
  stats.catalogueSize = replacement.written;
  stats.previousCatalogueSize = replacement.previousCount;
  stats.backupFileId = replacement.backupFileId;

  // Snapshots are historical and additive; written only after the catalogue
  // replacement has succeeded.
  appendObjectsInChunks_(
    ORTEC.SHEETS.INVENTORY,
    snapshotRows,
    1000
  );

  const inventoryAnalysis = analyzeInventory_(resolveDateArg_(meta.reportDate));
  stats.inventoryIssuesCreated = inventoryAnalysis.count;
  return stats;
}


function findInventoryBranchColumns_(originalHeaders, normalizedHeaders) {
  const branches = [];

  normalizedHeaders.forEach((header, index) => {
    const match = header.match(/^in stock \[(.+)\]$/);

    if (!match) {
      return;
    }

    const rawBranchName = originalHeaders[index]
      .replace(/^In stock \[/i, '')
      .replace(/\]$/, '')
      .trim();

    const branchId = normalizeLoyverseBranch_(rawBranchName);

    if (!branchId) {
      return;
    }

    branches.push({
      branchId: branchId,
      rawName: rawBranchName,
      stockIndex: index,
      priceIndex: findHeaderIndex_(
        normalizedHeaders,
        `price [${match[1]}]`
      ),
      lowStockIndex: findHeaderIndex_(
        normalizedHeaders,
        `low stock [${match[1]}]`
      ),
      optimalStockIndex: findHeaderIndex_(
        normalizedHeaders,
        `optimal stock [${match[1]}]`
      ),
      availableIndex: findHeaderIndex_(
        normalizedHeaders,
        `available for sale [${match[1]}]`
      )
    });
  });

  return branches.filter(branch => branch.stockIndex >= 0);
}


function importReceiptsByItem_(
  headers,
  rows,
  batchId,
  meta
) {
  const existingItemKeys = new Set(
    sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS)
      .map(row => String(row.item_key || ''))
  );

  const existingReceiptKeys = new Set(
    sheetToObjects_(ORTEC.SHEETS.RECEIPTS)
      .map(row => String(row.receipt_key || ''))
  );

  const itemRows = [];
  const receiptMap = {};

  const stats = {
    inserted: 0,
    duplicates: 0,
    errors: 0,
    receiptsInserted: 0
  };

  rows.forEach(row => {
    try {
      if (isEmptyRow_(row)) {
        return;
      }

      const item = rowToObject_(headers, row);

      const receiptNumber = cleanText_(item['receipt number']);
      const receiptDate =
        normalizeLoyverseDate_(item.date) ||
        meta.reportDate;

      const branchId = normalizeLoyverseBranch_(item.store);
      const sku = cleanText_(item.sku);
      const itemName = cleanText_(item.item);
      const category = cleanText_(item.category);

      const quantity = number_(item.quantity, 0);
      const grossSales = number_(item['gross sales'], 0);
      const discount = Math.abs(number_(item.discounts, 0));
      const netSales = number_(item['net sales'], 0);
      const costOfGoods = number_(item['cost of goods'], 0);
      const grossProfit = number_(item['gross profit'], 0);
      const status = cleanText_(item.status);
      const cashier = cleanText_(item['cashier name']);

      if (!receiptNumber || !branchId) {
        stats.errors++;
        return;
      }

      const receiptKey = sha256_(
        [
          receiptNumber,
          receiptDate,
          branchId
        ].join('|')
      );

      const itemKey = sha256_(
        [
          receiptKey,
          sku,
          itemName,
          quantity,
          netSales,
          item.variant,
          item['modifiers applied']
        ].join('|')
      );

      if (existingItemKeys.has(itemKey)) {
        stats.duplicates++;
        return;
      }

      const unitPrice =
        quantity !== 0
          ? netSales / quantity
          : netSales;

      itemRows.push({
        item_key: itemKey,
        receipt_key: receiptKey,
        receipt_number: receiptNumber,
        receipt_date: receiptDate,
        branch_id: branchId,
        sku: sku,
        item_name: itemName,
        category: category,
        quantity: quantity,
        unit_price: unitPrice,
        gross_sales: grossSales,
        discount: discount,
        net_sales: netSales,
        cost: costOfGoods,
        profit: grossProfit,
        batch_id: batchId,
        created_at: nowIso_()
      });

      existingItemKeys.add(itemKey);
      stats.inserted++;

      if (!receiptMap[receiptKey]) {
        receiptMap[receiptKey] = {
          receipt_key: receiptKey,
          receipt_number: receiptNumber,
          receipt_date: receiptDate,
          branch_id: branchId,
          employee: cashier,
          payment_type: '',
          gross_sales: 0,
          discounts: 0,
          refunds: 0,
          net_sales: 0,
          batch_id: batchId,
          created_at: nowIso_()
        };
      }

      receiptMap[receiptKey].gross_sales += grossSales;
      receiptMap[receiptKey].discounts += discount;
      receiptMap[receiptKey].net_sales += netSales;

      if (
        String(item['receipt type'] || '').toLowerCase().includes('refund')
      ) {
        receiptMap[receiptKey].refunds += Math.abs(netSales);
      }

      if (status && status.toLowerCase() !== 'closed') {
        receiptMap[receiptKey].payment_type = status;
      }
    } catch (error) {
      stats.errors++;
      console.error('RECEIPTS_BY_ITEM row failed: %s', error && error.message ? error.message : error);
    }
  });

  const receiptRows = Object.values(receiptMap)
    .filter(receipt => !existingReceiptKeys.has(receipt.receipt_key));

  stats.receiptsInserted = receiptRows.length;

  appendObjectsInChunks_(
    ORTEC.SHEETS.RECEIPT_ITEMS,
    itemRows,
    1000
  );

  appendObjectsInChunks_(
    ORTEC.SHEETS.RECEIPTS,
    receiptRows,
    1000
  );

  return stats;
}


function appendObjectsInChunks_(sheetName, objects, chunkSize) {
  if (!objects || !objects.length) {
    return;
  }

  const size = chunkSize || 500;

  for (let index = 0; index < objects.length; index += size) {
    appendObjects_(
      sheetName,
      objects.slice(index, index + size)
    );
  }
}


function normalizeLoyverseBranch_(value) {
  // Normalize Arabic alif variants (أ إ آ ا) before matching: the branch is
  // configured as "مربع إتين" with hamza, so a bare-alif test never matched and
  // every row from that store was discarded as an error.
  const branch = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u0623\u0625\u0622]/g, '\u0627');

  if (
    branch.includes('sadah') ||
    branch.includes('saadah') ||
    branch.includes('tymour') ||
    branch.includes('سعادة')
  ) {
    return 'SAADA';
  }

  if (
    branch.includes('auqad') ||
    branch.includes('awqad') ||
    branch.includes('عوقد')
  ) {
    return 'AWQAD';
  }

  if (
    branch.includes('ittin') ||
    branch.includes('اتين')
  ) {
    return 'ITTIN';
  }

  return '';
}


function normalizeLoyverseDate_(value) {
  if (!value) {
    return '';
  }

  const cleaned = String(value)
    .replace(/[\u202F\u00A0]/g, ' ')
    .trim();

  const datePart = cleaned.split(' ')[0];
  const parts = datePart.split('/');

  if (parts.length === 3) {
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    let year = Number(parts[2]);

    if (year < 100) {
      year += 2000;
    }

    return [
      String(year).padStart(4, '0'),
      String(month).padStart(2, '0'),
      String(day).padStart(2, '0')
    ].join('-');
  }

  const parsed = new Date(cleaned);

  if (isNaN(parsed.getTime())) {
    return '';
  }

  return Utilities.formatDate(
    parsed,
    ORTEC.TZ,
    'yyyy-MM-dd'
  );
}


function rowToObject_(headers, row) {
  return headers.reduce((object, header, index) => {
    object[header] = row[index];
    return object;
  }, {});
}


function normalizeHeader_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\u202F\u00A0]/g, ' ')
    .replace(/\s+/g, ' ');
}


function findHeaderIndex_(headers, target) {
  return headers.indexOf(normalizeHeader_(target));
}


function number_(value, fallback) {
  const normalized = String(value == null ? '' : value)
    .replace(/,/g, '')
    .replace(/[^\d.\-]/g, '');

  const result = Number(normalized);

  return isNaN(result)
    ? Number(fallback || 0)
    : result;
}


function firstPositiveNumber_(values) {
  for (let index = 0; index < values.length; index++) {
    const value = number_(values[index], 0);

    if (value > 0) {
      return value;
    }
  }

  return 0;
}


function cleanText_(value) {
  return String(value == null ? '' : value).trim();
}


function isEmptyRow_(row) {
  return !row.some(value => String(value || '').trim() !== '');
}


function sha256_(text) {
  return Utilities
    .computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(text || ''),
      Utilities.Charset.UTF_8
    )
    .map(byte => (byte + 256) % 256)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}