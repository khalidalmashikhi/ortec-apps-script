/**
 * Public entry point. Not currently trigger-attached, but it carries the same
 * `date` argument shape that broke the scheduled handlers, so it is normalized
 * defensively here too.
 */
function analyzeInventory(date, sessionToken) {
  requireCapability_('issues', sessionToken);
  return analyzeInventory_(resolveDateArg_(date));
}

function analyzeInventory_(date) {
  const analysisDate = resolveDateArg_(date);
  const snapshots = filterByDate_(ORTEC.SHEETS.INVENTORY, 'snapshot_date', analysisDate);
  const issues = [];
  const bySku = {};
  snapshots.forEach(s => {
    const stock=Number(s.stock)||0, cost=Number(s.cost)||0;
    if(stock<0)issues.push(makeIssue_(s,'CRITICAL','NEGATIVE_STOCK',stock,`Negative stock: ${stock}`,analysisDate));
    if(cost<=0)issues.push(makeIssue_(s,'HIGH','MISSING_COST',cost,'Product cost is missing or zero.',analysisDate));
    const key=String(s.sku||s.item_name).toLowerCase();
    bySku[key]=bySku[key]||[];
    bySku[key].push(s);
  });
  Object.values(bySku).forEach(group=>{
    if(group.length>1){
      const branches=new Set(group.map(x=>x.branch_id));
      if(branches.size===1)issues.push(makeIssue_(group[0],'MEDIUM','POSSIBLE_DUPLICATE',group.length,'Possible duplicate product records.',analysisDate));
    }
    const aw=group.find(x=>x.branch_id==='AWQAD'), sa=group.find(x=>x.branch_id==='SAADA');
    if(aw&&sa&&Number(aw.stock)>5&&Number(sa.stock)<0){
      issues.push(makeIssue_(sa,'HIGH','TRANSFER_SUGGESTION',sa.stock,`Suggested transfer from AWQAD to SAADA.`,analysisDate));
    }
    if(sa&&aw&&Number(sa.stock)>5&&Number(aw.stock)<0){
      issues.push(makeIssue_(aw,'HIGH','TRANSFER_SUGGESTION',aw.stock,`Suggested transfer from SAADA to AWQAD.`,analysisDate));
    }
  });
  appendObjects_(ORTEC.SHEETS.INVENTORY_ISSUES,issues);
  return {ok:true,count:issues.length};
}

function makeIssue_(s,severity,type,currentValue,details,issueDate){
  return {
    issue_id:uuid_(),issue_date:issueDate||today_(),severity,issue_type:type,
    branch_id:s.branch_id,sku:s.sku,item_name:s.item_name,
    current_value:currentValue,details,status:'OPEN',task_id:'',created_at:nowIso_()
  };
}

/** Public entry point: authenticate before exposing the issue register. */
function listInventoryIssues(status, sessionToken) {
  requireCapability_('issues', sessionToken);
  return listInventoryIssues_(status);
}

function listInventoryIssues_(status){
  return sheetToObjects_(ORTEC.SHEETS.INVENTORY_ISSUES)
    .filter(i=>!status||status==='ALL'||i.status===status)
    .slice(-500).reverse();
}

function createTaskFromIssue(issueId,assignedTo,dueDate,sessionToken){
  requireCapability_('tasks.manage', sessionToken);
  const issue=findBy_(ORTEC.SHEETS.INVENTORY_ISSUES,'issue_id',issueId);
  if(!issue)throw new Error('Issue not found.');
  const task=createTask({
    title:`${issue.issue_type}: ${issue.item_name}`,
    description:issue.details,branchId:issue.branch_id,priority:issue.severity,
    assignedTo,dueDate,sourceType:'INVENTORY_ISSUE',sourceId:issueId
  }, sessionToken);
  updateById_(ORTEC.SHEETS.INVENTORY_ISSUES,'issue_id',issueId,{task_id:task.task_id,status:'IN_PROGRESS'});
  return task;
}
