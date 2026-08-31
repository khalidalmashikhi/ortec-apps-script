function analyzeInventory(date) {
  const snapshots = filterByDate_(ORTEC.SHEETS.INVENTORY, 'snapshot_date', date || today_());
  const issues = [];
  const bySku = {};
  snapshots.forEach(s => {
    const stock=Number(s.stock)||0, cost=Number(s.cost)||0;
    if(stock<0)issues.push(makeIssue_(s,'CRITICAL','NEGATIVE_STOCK',stock,`Negative stock: ${stock}`));
    if(cost<=0)issues.push(makeIssue_(s,'HIGH','MISSING_COST',cost,'Product cost is missing or zero.'));
    const key=String(s.sku||s.item_name).toLowerCase();
    bySku[key]=bySku[key]||[];
    bySku[key].push(s);
  });
  Object.values(bySku).forEach(group=>{
    if(group.length>1){
      const branches=new Set(group.map(x=>x.branch_id));
      if(branches.size===1)issues.push(makeIssue_(group[0],'MEDIUM','POSSIBLE_DUPLICATE',group.length,'Possible duplicate product records.'));
    }
    const aw=group.find(x=>x.branch_id==='AWQAD'), sa=group.find(x=>x.branch_id==='SAADA');
    if(aw&&sa&&Number(aw.stock)>5&&Number(sa.stock)<0){
      issues.push(makeIssue_(sa,'HIGH','TRANSFER_SUGGESTION',sa.stock,`Suggested transfer from AWQAD to SAADA.`));
    }
    if(sa&&aw&&Number(sa.stock)>5&&Number(aw.stock)<0){
      issues.push(makeIssue_(aw,'HIGH','TRANSFER_SUGGESTION',aw.stock,`Suggested transfer from SAADA to AWQAD.`));
    }
  });
  appendObjects_(ORTEC.SHEETS.INVENTORY_ISSUES,issues);
  return {ok:true,count:issues.length};
}

function makeIssue_(s,severity,type,currentValue,details){
  return {
    issue_id:uuid_(),issue_date:today_(),severity,issue_type:type,
    branch_id:s.branch_id,sku:s.sku,item_name:s.item_name,
    current_value:currentValue,details,status:'OPEN',task_id:'',created_at:nowIso_()
  };
}

function listInventoryIssues(status){
  return sheetToObjects_(ORTEC.SHEETS.INVENTORY_ISSUES)
    .filter(i=>!status||status==='ALL'||i.status===status)
    .slice(-500).reverse();
}

function createTaskFromIssue(issueId,assignedTo,dueDate,sessionToken){
  getCurrentUser(sessionToken);
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
