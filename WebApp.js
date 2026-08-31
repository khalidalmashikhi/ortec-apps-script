function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle(ORTEC.APP_NAME).addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
// Only the app's own partials may be included. Without the allow-list this is
// an arbitrary-file read reachable from the client.
const ORTEC_INCLUDABLE_ = Object.freeze(['Index','ClientJS','Styles']);
function include(filename) {
  const name = String(filename || '');
  if (ORTEC_INCLUDABLE_.indexOf(name) === -1) throw new Error('Unknown template.');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function getBootstrapData(sessionToken) {
  try {
    const user = resolveSessionUser_(sessionToken, true);
    const branch = String(user.branch_id || 'ALL');
    const response = {
      app: { name: ORTEC.APP_NAME, version: ORTEC.VERSION, language: String(user.language || 'ar') },
      user: publicUser_(user), branches: ORTEC.BRANCHES || [],
      permissions: getPermissionsForRole_(user.role),
      capabilities: capabilitiesForRole_(user.role),
      dashboard: getDashboardData_(today_(), branch),
      analysis: getOperationsAnalysis_(today_(), branch),
      expenses: listExpenses_(today_(), branch) || [],
      issues: listInventoryIssues_('OPEN') || [], tasks: listTasks_('OPEN') || []
    };
    if (capabilitiesForRole_(user.role).indexOf('users') !== -1) response.users = listUsers(sessionToken);
    return makeClientSafe_(response);
  } catch (error) {
    console.error('getBootstrapData failed', error && error.stack ? error.stack : error);
    throw new Error(error && error.message ? error.message : String(error));
  }
}

/**
 * Which tabs the client draws. Advisory only — derived from the same matrix the
 * server enforces so the two cannot drift, but never a substitute for it.
 */
function getPermissionsForRole_(role) {
  return capabilitiesForRole_(role).filter(function (capability) {
    return capability.indexOf('.') === -1;
  });
}

function makeClientSafe_(value) {
  return JSON.parse(JSON.stringify(value, function(key, item) {
    if (item instanceof Date) return Utilities.formatDate(item, ORTEC.TZ, "yyyy-MM-dd'T'HH:mm:ss");
    if (typeof item === 'undefined') return null;
    if (typeof item === 'number' && !isFinite(item)) return 0;
    return item;
  }));
}
