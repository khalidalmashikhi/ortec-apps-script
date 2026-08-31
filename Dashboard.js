/** Public entry point: authenticate, then scope the branch to the session. */
function getDashboardData(date, branchId, sessionToken) {
  const user = requireCapability_('dashboard', sessionToken);
  return getDashboardData_(resolveDateArg_(date), scopeBranch_(user, branchId));
}

function getDashboardData_(date, branchId) {
  const selectedDate = date || today_();
  const selectedBranch = branchId || 'ALL';
  const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS).filter(receipt =>
    normalizeDate_(receipt.receipt_date) === selectedDate &&
    (selectedBranch === 'ALL' || receipt.branch_id === selectedBranch)
  );
  const expenses = listExpenses_(selectedDate, selectedBranch)
    .filter(expense => String(expense.status || '').toUpperCase() === 'APPROVED');
  const issues = listInventoryIssues_('OPEN').filter(issue =>
    selectedBranch === 'ALL' || issue.branch_id === selectedBranch
  );
  const sales=sumField_(receipts,'net_sales');
  const expenseTotal=sumField_(expenses,'amount');

  // Payment method is NOT present in the Loyverse "Receipts by Item" export.
  // The previous code bucketed every receipt by an always-empty payment_type,
  // so CASH/CARD/TRANSFER were structurally always 0 and netCashMovement was
  // always -expenses. Rather than publish fabricated zeros that read as
  // measured values, report the gap explicitly and let the UI say so.
  const paymentBreakdown = {
    available: false,
    reason: 'NOT_IN_SOURCE',
    source: 'Loyverse Receipts by Item',
    message: 'طريقة الدفع غير متوفرة في تقرير Loyverse الحالي.'
  };

  return {date:selectedDate,branchId:selectedBranch,sales:sales,orders:receipts.length,
    ingestion:getIngestionStatus_(),
    averageOrder:receipts.length?sales/receipts.length:0,
    expenses:expenseTotal,
    paymentBreakdown:paymentBreakdown,
    openIssues:issues.length,criticalIssues:issues.filter(i=>String(i.severity).toUpperCase()==='CRITICAL').length};
}

/** Public entry point: authenticate, then scope the branch to the session. */
function getOperationsAnalysis(date, branchId, sessionToken) {
  const user = requireCapability_('dashboard', sessionToken);
  return getOperationsAnalysis_(resolveDateArg_(date), scopeBranch_(user, branchId));
}

function getOperationsAnalysis_(date, branchId) {
  const selectedDate=date||today_(), selectedBranch=branchId||'ALL';
  const items=sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS).filter(r=>
    normalizeDate_(r.receipt_date)===selectedDate && (selectedBranch==='ALL'||r.branch_id===selectedBranch));
  const products=sheetToObjects_(ORTEC.SHEETS.PRODUCTS).filter(r=>selectedBranch==='ALL'||r.branch_id===selectedBranch);
  const expenses=listExpenses_(selectedDate,selectedBranch).filter(r=>String(r.status).toUpperCase()==='APPROVED');
  const byBranch={}, byItem={};
  items.forEach(r=>{
    const b=r.branch_id||'UNKNOWN'; byBranch[b]=byBranch[b]||{branchId:b,sales:0,profit:0,quantity:0};
    byBranch[b].sales+=Number(r.net_sales)||0; byBranch[b].profit+=Number(r.profit)||0; byBranch[b].quantity+=Number(r.quantity)||0;
    const k=String(r.sku||r.item_name||'').trim(); if(!k)return;
    byItem[k]=byItem[k]||{sku:r.sku||'',itemName:r.item_name||'',quantity:0,sales:0,profit:0};
    byItem[k].quantity+=Number(r.quantity)||0; byItem[k].sales+=Number(r.net_sales)||0; byItem[k].profit+=Number(r.profit)||0;
  });
  const totalProfit=sumField_(items,'profit');
  const inventoryValue=products.reduce((t,r)=>t+(Number(r.stock)||0)*(Number(r.cost)||0),0);
  const lowStock=products.filter(r=>Number(r.track_stock)!==0 && Number(r.stock)<=Number(r.low_stock_threshold||0));
  const negativeStock=products.filter(r=>Number(r.stock)<0);
  return {
    date:selectedDate,grossProfit:totalProfit,expenseTotal:sumField_(expenses,'amount'),
    estimatedNetProfit:totalProfit-sumField_(expenses,'amount'),inventoryValue:inventoryValue,
    productCount:products.length,lowStockCount:lowStock.length,negativeStockCount:negativeStock.length,
    branchPerformance:Object.values(byBranch).sort((a,b)=>b.sales-a.sales),
    topItems:Object.values(byItem).sort((a,b)=>b.sales-a.sales).slice(0,10),
    lowStock:lowStock.sort((a,b)=>Number(a.stock)-Number(b.stock)).slice(0,20)
  };
}

/**
 * Freshness of the Loyverse feed, per report type.
 *
 * A dashboard built on stale sales data looks exactly like a quiet day. This
 * is what made an eight-week ingestion outage invisible: the numbers were
 * plausible, just old. Every dashboard payload now carries how old the feed is
 * and whether that is acceptable, so "no data" can never be mistaken for
 * "no sales".
 */
function getIngestionStatus_() {
  const overdueHours = Number(getSetting_('INGESTION_OVERDUE_HOURS', 36)) || 36;
  const criticalHours = Number(getSetting_('INGESTION_CRITICAL_HOURS', 72)) || 72;

  let batches = [];
  try { batches = sheetToObjects_(ORTEC.SHEETS.IMPORT_BATCHES); } catch (e) { batches = []; }

  function newestFor(type) {
    const matching = batches
      .filter(function (b) { return String(b.report_type) === type && String(b.status || '').indexOf('COMPLETED') === 0; })
      .map(function (b) { return String(b.uploaded_at || ''); })
      .filter(Boolean)
      .sort();
    if (!matching.length) return { lastImport: null, ageHours: null, state: 'NEVER' };
    const last = matching[matching.length - 1];
    const ageHours = Math.max(0, Math.round((Date.now() - new Date(last).getTime()) / 3600000));
    let state = 'OK';
    if (ageHours >= criticalHours) state = 'CRITICAL';
    else if (ageHours >= overdueHours) state = 'OVERDUE';
    return { lastImport: last, ageHours: ageHours, ageDays: Math.floor(ageHours / 24), state: state };
  }

  const receipts = newestFor(ORTEC.IMPORT_TYPES.RECEIPTS_BY_ITEM);
  const catalogue = newestFor(ORTEC.IMPORT_TYPES.ITEM_EXPORT);
  const worst = [receipts.state, catalogue.state]
    .map(function (s) { return ['OK', 'OVERDUE', 'CRITICAL', 'NEVER'].indexOf(s); });
  const overall = ['OK', 'OVERDUE', 'CRITICAL', 'NEVER'][Math.max.apply(null, worst)];

  return {
    receipts: receipts,
    catalogue: catalogue,
    overall: overall,
    stale: overall !== 'OK',
    thresholds: { overdueHours: overdueHours, criticalHours: criticalHours }
  };
}

function sumField_(rows,fieldName){if(!Array.isArray(rows))return 0;return rows.reduce((t,r)=>t+(Number(r[fieldName])||0),0);}
