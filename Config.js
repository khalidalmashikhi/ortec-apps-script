const ORTEC = Object.freeze({
  APP_NAME: 'OrTec OS',
  VERSION: '3.0.0',
  TZ: 'Asia/Muscat',
  CURRENCY: 'OMR',
  DEFAULT_LANG: 'ar',
  BRANCHES: [
    { id: 'AWQAD', ar: 'فرع عوقد', en: 'Awqad Branch' },
    { id: 'SAADA', ar: 'فرع السعادة', en: 'Al Saada Branch' },
    { id: 'ITTIN', ar: 'مربع إتين', en: 'Ittin Square' }
  ],
  IMPORT_TYPES: {
    ITEM_EXPORT: 'ITEM_EXPORT',
    RECEIPTS_BY_ITEM: 'RECEIPTS_BY_ITEM'
  },
  ROLES: ['OWNER','ADMIN','ACCOUNTANT','BRANCH_MANAGER','CASHIER','TECHNICIAN','VIEWER'],
  IMPORT_GUARD: {
    MIN_CATALOGUE_ROWS: 1,
    MAX_SHRINK_RATIO: 0.5,
    MAX_ERROR_RATIO: 0.5
  },
  SHEETS: {
    SETTINGS: 'Settings',
    USERS: 'Users',
    BRANCHES: 'Branches',
    IMPORT_BATCHES: 'ImportBatches',
    RECEIPTS: 'LoyverseReceipts',
    RECEIPT_ITEMS: 'LoyverseReceiptItems',
    PRODUCTS: 'LoyverseProducts',
    INVENTORY: 'InventorySnapshots',
    INVENTORY_ISSUES: 'InventoryIssues',
    EXPENSES: 'Expenses',
    DELIVERY_AGENTS: 'DeliveryAgents',
    TASKS: 'Tasks',
    AUDIT: 'AuditLog',
    EMAIL_LOG: 'EmailReportsLog'
  },
  HEADERS: {
    Settings: ['key','value','description','updated_at','updated_by'],
    Users: ['user_id','username','email','name_ar','name_en','role','branch_id','language','active','password_hash','password_salt','must_change_password','last_login','failed_attempts','locked_until','created_at'],
    Branches: ['branch_id','name_ar','name_en','active','created_at'],
    ImportBatches: ['batch_id','file_name','file_hash','report_type','branch_id','period_date','total_rows','inserted_rows','duplicate_rows','error_rows','status','uploaded_by','uploaded_at'],
    LoyverseReceipts: ['receipt_key','receipt_number','receipt_date','branch_id','employee','payment_type','gross_sales','discounts','refunds','net_sales','batch_id','created_at'],
    LoyverseReceiptItems: ['item_key','receipt_key','receipt_number','receipt_date','branch_id','sku','item_name','category','quantity','unit_price','gross_sales','discount','net_sales','cost','profit','batch_id','created_at'],
    LoyverseProducts: ['product_key','sku','barcode','item_name','category','cost','price','track_stock','branch_id','stock','low_stock_threshold','batch_id','updated_at'],
    InventorySnapshots: ['snapshot_id','snapshot_date','branch_id','sku','item_name','stock','cost','value','batch_id','created_at'],
    InventoryIssues: ['issue_id','issue_date','severity','issue_type','branch_id','sku','item_name','current_value','details','status','task_id','created_at'],
    Expenses: ['expense_id','expense_date','expense_scope','branch_id','amount','category','payment_method','payment_status','beneficiary','description','invoice_required','invoice_file_id','invoice_number','delivery_agent_id','shipment_number','status','created_by','approved_by','created_at','approved_at'],
    DeliveryAgents: ['agent_id','agent_name','company_name','phone','active','created_at'],
    Tasks: ['task_id','title','description','branch_id','priority','status','assigned_to','due_date','source_type','source_id','created_by','created_at','completed_at'],
    AuditLog: ['audit_id','entity_type','entity_id','action','before_json','after_json','user_email','timestamp'],
    EmailReportsLog: ['log_id','report_date','report_type','recipients','pdf_file_id','status','error_message','sent_at']
  }
});

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not configured. Run setupOrTec().');
  return SpreadsheetApp.openById(id);
}

function getSetting_(key, fallback) {
  const props = PropertiesService.getScriptProperties();
  const direct = props.getProperty(key);
  if (direct !== null) return direct;
  try {
    const rows = sheetToObjects_(ORTEC.SHEETS.SETTINGS);
    const found = rows.find(r => String(r.key) === String(key));
    return found ? found.value : fallback;
  } catch (e) {
    return fallback;
  }
}

function nowIso_() {
  return Utilities.formatDate(new Date(), ORTEC.TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

function today_() {
  return Utilities.formatDate(new Date(), ORTEC.TZ, 'yyyy-MM-dd');
}

function uuid_() {
  return Utilities.getUuid();
}

/**
 * Coerce a handler argument into a yyyy-MM-dd string.
 *
 * Apps Script invokes a time-based trigger handler with an event object as its
 * first argument. That object is truthy, so `date = date || today_()` kept the
 * object and every downstream date comparison silently matched nothing. Any
 * object, malformed string or empty value resolves to today; a well-formed
 * yyyy-MM-dd string passes through untouched so manual calls are unaffected.
 */
function resolveDateArg_(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? today_() : Utilities.formatDate(value, ORTEC.TZ, 'yyyy-MM-dd');
  }
  if (value && typeof value === 'object') return today_();
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return today_();
  const parts = text.split('-');
  const month = Number(parts[1]), day = Number(parts[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return today_();
  return text;
}

/**
 * True when `value` is a genuine Apps Script trigger event object.
 *
 * The triggerUid is verified against this project's installed triggers, so a
 * caller cannot forge one through google.script.run by passing a lookalike
 * object: they would need a real trigger's unique id, which is not readable
 * from the client.
 */
function isTriggerEvent_(value) {
  if (!value || typeof value !== 'object' || value instanceof Date) return false;
  const uid = String(value.triggerUid || '');
  if (!uid) return false;
  try {
    return ScriptApp.getProjectTriggers().some(function (trigger) {
      return String(trigger.getUniqueId()) === uid;
    });
  } catch (e) {
    return false;
  }
}
