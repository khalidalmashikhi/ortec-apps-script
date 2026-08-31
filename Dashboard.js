function getDashboardData(date, branchId) {
  const selectedDate = date || today_();
  const selectedBranch = branchId || 'ALL';
  const receipts = sheetToObjects_(ORTEC.SHEETS.RECEIPTS).filter(receipt =>
    normalizeDate_(receipt.receipt_date) === selectedDate &&
    (selectedBranch === 'ALL' || receipt.branch_id === selectedBranch)
  );
  const expenses = listExpenses(selectedDate, selectedBranch)
    .filter(expense => String(expense.status || '').toUpperCase() === 'APPROVED');
  const issues = listInventoryIssues('OPEN').filter(issue =>
    selectedBranch === 'ALL' || issue.branch_id === selectedBranch
  );
  const paymentTotals = { CASH:0, CARD:0, TRANSFER:0, OTHER:0 };
  receipts.forEach(receipt => {
    const paymentType=String(receipt.payment_type||'').toLowerCase();
    let bucket='OTHER';
    if(/cash|نقد/.test(paymentType))bucket='CASH';
    else if(/card|بطاقة/.test(paymentType))bucket='CARD';
    else if(/transfer|تحويل/.test(paymentType))bucket='TRANSFER';
    paymentTotals[bucket]+=Number(receipt.net_sales)||0;
  });
  const sales=sumField_(receipts,'net_sales');
  const expenseTotal=sumField_(expenses,'amount');
  return {date:selectedDate,branchId:selectedBranch,sales:sales,orders:receipts.length,
    averageOrder:receipts.length?sales/receipts.length:0,cash:paymentTotals.CASH,
    card:paymentTotals.CARD,transfer:paymentTotals.TRANSFER,other:paymentTotals.OTHER,
    expenses:expenseTotal,netCashMovement:paymentTotals.CASH-expenseTotal,
    openIssues:issues.length,criticalIssues:issues.filter(i=>String(i.severity).toUpperCase()==='CRITICAL').length};
}

function getOperationsAnalysis(date, branchId) {
  const selectedDate=date||today_(), selectedBranch=branchId||'ALL';
  const items=sheetToObjects_(ORTEC.SHEETS.RECEIPT_ITEMS).filter(r=>
    normalizeDate_(r.receipt_date)===selectedDate && (selectedBranch==='ALL'||r.branch_id===selectedBranch));
  const products=sheetToObjects_(ORTEC.SHEETS.PRODUCTS).filter(r=>selectedBranch==='ALL'||r.branch_id===selectedBranch);
  const expenses=listExpenses(selectedDate,selectedBranch).filter(r=>String(r.status).toUpperCase()==='APPROVED');
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

function sumField_(rows,fieldName){if(!Array.isArray(rows))return 0;return rows.reduce((t,r)=>t+(Number(r[fieldName])||0),0);}
