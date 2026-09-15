/**
 * Walif Coffee — والِف كوفي
 * Central configuration. Every other file reads from WC.
 */
var WC = {
  APP_NAME: 'Walif Coffee',
  APP_NAME_AR: 'والِف كوفي',
  VERSION: '1.0.0',
  TZ: 'Asia/Muscat',
  CURRENCY: 'OMR',
  DECIMALS: 3,
  SESSION_HOURS: 8,
  MAX_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  ALLOWED_ATTACHMENT_TYPES: ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'],
  ALLOWED_ATTACHMENT_EXT: ['pdf', 'jpg', 'jpeg', 'png'],
  MAX_CSV_CHARS: 8 * 1024 * 1024,
  ROOT_FOLDER: 'Walif Coffee Accounting',
  ROLES: { MANAGER: 'manager', ACCOUNTANT: 'accountant' },
  STATUS: { ACTIVE: 'ACTIVE', CANCELLED: 'CANCELLED' },

  SHEETS: {
    DASHBOARD: 'Dashboard_Data',
    SALES_RAW: 'Sales_Raw',
    SALES_IMPORTS: 'Sales_Imports',
    PURCHASES: 'Purchases',
    EXPENSES: 'Expenses',
    PAYROLL: 'Payroll',
    RENT: 'Rent',
    USERS: 'Users',
    SETTINGS: 'Settings',
    AUDIT: 'Audit_Log',
    ERRORS: 'Error_Log'
  },
  HIDDEN_SHEETS: ['Users', 'Settings', 'Audit_Log', 'Error_Log', 'Dashboard_Data'],

  /** Loyverse CSV columns (matched by name, case-insensitive, order-independent). */
  LOYVERSE_COLUMNS: [
    'Date', 'Receipt number', 'Receipt type', 'Category', 'SKU', 'Item', 'Variant',
    'Modifiers applied', 'Quantity', 'Gross sales', 'Discounts', 'Net sales',
    'Cost of goods', 'Gross profit', 'Taxes', 'POS', 'Store', 'Cashier name',
    'Customer name', 'Customer contacts', 'Comment', 'Status'
  ],
  LOYVERSE_REQUIRED: ['Date', 'Receipt number', 'Receipt type', 'Item', 'Quantity', 'Gross sales', 'Net sales'],
  LOYVERSE_NUMERIC: ['Quantity', 'Gross sales', 'Discounts', 'Net sales', 'Cost of goods', 'Gross profit', 'Taxes'],
  LOYVERSE_INTERNAL: ['Internal ID', 'Import ID', 'Imported At', 'Imported By', 'Unique Key', 'Source File Name', 'Record Status', 'Sale Date', 'Sale Hour'],
  ACCEPTED_RECEIPT_TYPES: ['sale', 'refund'],
  REJECTED_STATUSES: ['cancelled', 'canceled', 'void', 'voided', 'deleted', 'open'],

  COMMON_COLUMNS: ['Internal ID', 'Created At', 'Created By', 'Updated At', 'Updated By', 'Record Status', 'Cancelled By', 'Cancelled At', 'Cancel Reason', 'Notes'],

  HEADERS: {
    Sales_Imports: ['Import ID', 'File Name', 'Uploaded At', 'Uploaded By', 'Date From', 'Date To', 'Total Rows',
      'Imported Rows', 'Duplicate Rows', 'Rejected Rows', 'Net Sales', 'Cost of Goods', 'Gross Profit', 'Status', 'Error Message'],
    Purchases: ['Invoice Number', 'Invoice Date', 'Supplier', 'Category', 'Description', 'Subtotal', 'Tax', 'Discount', 'Total',
      'Paid Amount', 'Remaining Amount', 'Payment Method', 'Payment Status', 'Is Inventory', 'Attachment URL', 'Attachment ID', 'Dedupe Key'],
    Expenses: ['Expense Date', 'Expense Type', 'Description', 'Amount', 'Payment Method', 'Payee', 'Payment Status', 'Attachment URL', 'Attachment ID'],
    Payroll: ['Employee', 'Month', 'Basic Salary', 'Allowance', 'Overtime', 'Deduction', 'Advance', 'Net Salary', 'Payment Date', 'Payment Method', 'Payment Status'],
    Rent: ['Period', 'Landlord', 'Amount', 'Due Date', 'Payment Date', 'Payment Method', 'Status', 'Attachment URL', 'Attachment ID'],
    Users: ['Username', 'Role', 'Display Name', 'Status', 'Created At', 'Last Login', 'Must Change Password'],
    Settings: ['Key', 'Value', 'Description', 'Updated At', 'Updated By'],
    Audit_Log: ['Timestamp', 'User', 'Role', 'Action', 'Entity', 'Record ID', 'Details', 'Result'],
    Error_Log: ['Timestamp', 'Function', 'User', 'Error Message', 'Stack', 'Related Record ID', 'Resolved'],
    Dashboard_Data: ['Key', 'Value', 'Updated At']
  },

  PURCHASE_CATEGORIES: ['بن', 'حليب', 'أكواب وعبوات', 'مواد غذائية', 'مواد تنظيف', 'معدات', 'صيانة', 'مخزون آخر', 'مشتريات غير مخزنية'],
  INVENTORY_CATEGORIES: ['بن', 'حليب', 'أكواب وعبوات', 'مواد غذائية', 'مواد تنظيف', 'مخزون آخر'],
  EXPENSE_TYPES: ['كهرباء', 'ماء', 'إنترنت', 'توصيل', 'صيانة', 'تنظيف', 'تسويق', 'رسوم حكومية', 'مستلزمات', 'أخرى'],
  PAYMENT_METHODS: ['نقد', 'بطاقة', 'تحويل بنكي', 'آجل'],
  PURCHASE_PAYMENT_STATUS: ['مدفوعة', 'مدفوعة جزئيًا', 'غير مدفوعة'],
  SIMPLE_PAYMENT_STATUS: ['مدفوع', 'غير مدفوع'],
  RENT_STATUS: ['مدفوع', 'مستحق', 'متأخر'],

  DEFAULT_SETTINGS: {
    REPORT_EMAIL: { value: 'khalid98115159@gmail.com', desc: 'بريد مستلم التقرير اليومي' },
    REPORT_HOUR: { value: '8', desc: 'ساعة إرسال التقرير اليومي (0-23) بتوقيت مسقط' },
    REPORT_ENABLED: { value: 'true', desc: 'تفعيل الإرسال اليومي (true/false)' },
    REPORT_MODE: { value: 'previous_day', desc: 'previous_day = تقرير اليوم السابق كاملًا، today = تقرير اليوم حتى وقت الإرسال' },
    DEMO_PASSWORDS_ACTIVE: { value: 'true', desc: 'هل ما زالت كلمات المرور التجريبية مستخدمة' },
    SETUP_DONE: { value: 'false', desc: 'هل تمت التهيئة' },
    SETUP_VERSION: { value: '', desc: 'إصدار التهيئة' }
  },

  DEMO_USERS: [
    { username: 'accountant', password: '1234', role: 'accountant', displayName: 'المحاسب' },
    { username: 'manager', password: '2026', role: 'manager', displayName: 'المدير' }
  ]
};

/** Sheets that carry the common audit columns. */
WC.ENTRY_SHEETS = [WC.SHEETS.PURCHASES, WC.SHEETS.EXPENSES, WC.SHEETS.PAYROLL, WC.SHEETS.RENT];
