/**
 * Walif Coffee — وليف كوفي
 * Web entry point + common API wrapper.
 *
 * Files: Config, Utils, Setup, Auth, Audit, SalesImport, Purchases, Expenses, Payroll, Rent, Records,
 *        Attachments, Analytics, Reports, EmailReports, Settings, Tests
 * HTML : Index, Login, Accountant, Dashboard, Styles, Scripts
 */

function doGet(e) {
  // First visit by the owner initialises everything (sheets, folders, users, trigger) automatically.
  if (props_().getProperty('SETUP_DONE') !== 'true') {
    try { setupSystem(); } catch (err) { logError_('doGet.setupSystem', null, err, ''); }
  } else {
    if (props_().getProperty('USERS_VERSION') !== WC.USERS_VERSION) { try { withLock_(migrateLegacyDemoUsers_); } catch (err) { logError_('doGet.migrateUsers', null, err, ''); } }
    if (props_().getProperty('BRAND_SEEDED') !== '1') { try { withLock_(function () { ensureDefaultSettings_(); seedWalifBrand_(); }); } catch (err) { logError_('doGet.seedBrand', null, err, ''); } }
  }
  var b = brand_();
  var t = HtmlService.createTemplateFromFile('Index');
  t.appName = b.name;
  t.appNameAr = b.nameAr;
  t.brandJson = JSON.stringify(b);
  return t.evaluate()
    .setTitle(b.nameAr + ' | ' + b.name)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

var INCLUDABLE_ = ['Styles', 'Scripts', 'Login', 'Accountant', 'Dashboard'];
function include(name) {
  if (INCLUDABLE_.indexOf(String(name)) < 0) throw new Error('Unknown template');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Wraps every API function: validates the session + role, runs fn(actor),
 * converts any exception into {ok:false, error} (no stack trace to the client) and logs it.
 */
function apiCall_(fnName, token, roles, fn) {
  var actor = null;
  try {
    actor = requireSession_(token, roles);
    var out = fn(actor);
    return clientSafe_(out);
  } catch (err) {
    if (err && (err.code === 'AUTH' || err.code === 'FORBIDDEN')) return { ok: false, error: err.message, code: err.code };
    logError_(fnName, actor, err, '');
    var msg = err && err.message ? String(err.message) : 'حدث خطأ غير متوقع.';
    return { ok: false, error: msg };
  }
}

/** Static lists for the forms + role flags. */
function api_bootstrap(token) {
  return apiCall_('api_bootstrap', token, null, function (actor) {
    var out = {
      ok: true,
      user: actor,
      today: todayStr_(),
      lists: {
        purchaseCategories: WC.PURCHASE_CATEGORIES, inventoryCategories: WC.INVENTORY_CATEGORIES,
        expenseTypes: WC.EXPENSE_TYPES, paymentMethods: WC.PAYMENT_METHODS,
        purchasePaymentStatus: WC.PURCHASE_PAYMENT_STATUS, simplePaymentStatus: WC.SIMPLE_PAYMENT_STATUS, rentStatus: WC.RENT_STATUS
      },
      limits: { attachmentBytes: WC.MAX_ATTACHMENT_BYTES, attachmentExt: WC.ALLOWED_ATTACHMENT_EXT },
      demoPasswordsActive: getSetting_('DEMO_PASSWORDS_ACTIVE') === 'true',
      brand: brand_()
    };
    if (actor.role === WC.ROLES.MANAGER) out.settings = publicSettings_();
    return out;
  });
}
