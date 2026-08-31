function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(ORTEC.APP_NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

function getBootstrapData(sessionToken) {
  try {
    const user = getCurrentUser(sessionToken);
    const response = {
      app: { name: ORTEC.APP_NAME, version: ORTEC.VERSION, language: String(user.language || 'ar') },
      user: publicUser_(user), branches: ORTEC.BRANCHES || [],
      permissions: getPermissionsForRole_(user.role),
      dashboard: getDashboardData(today_(), user.branch_id || 'ALL'),
      analysis: getOperationsAnalysis(today_(), user.branch_id || 'ALL'),
      expenses: listExpenses(today_(), user.branch_id || 'ALL') || [],
      issues: listInventoryIssues('OPEN') || [], tasks: listTasks('OPEN') || []
    };
    if (['OWNER','ADMIN'].indexOf(user.role) !== -1) response.users = listUsers(sessionToken);
    return makeClientSafe_(response);
  } catch (error) {
    console.error('getBootstrapData failed', error && error.stack ? error.stack : error);
    throw new Error(error && error.message ? error.message : String(error));
  }
}

function getPermissionsForRole_(role) {
  const map = {
    OWNER: ['dashboard','import','expense','issues','tasks','reports','users'],
    ADMIN: ['dashboard','import','expense','issues','tasks','reports','users'],
    ACCOUNTANT: ['dashboard','import','expense','tasks','reports'],
    BRANCH_MANAGER: ['dashboard','import','expense','issues','tasks','reports'],
    CASHIER: ['dashboard','expense','tasks'],
    TECHNICIAN: ['tasks'],
    VIEWER: ['dashboard']
  };
  return map[role] || ['dashboard'];
}

function makeClientSafe_(value) {
  return JSON.parse(JSON.stringify(value, function(key, item) {
    if (item instanceof Date) return Utilities.formatDate(item, ORTEC.TZ, "yyyy-MM-dd'T'HH:mm:ss");
    if (typeof item === 'undefined') return null;
    if (typeof item === 'number' && !isFinite(item)) return 0;
    return item;
  }));
}
