# Walif Coffee — والِف كوفي · النظام المالي والتشغيلي

نظام Google Apps Script كامل لمحل كوفي: استيراد مبيعات Loyverse (CSV)، تسجيل المشتريات والمصروفات والرواتب والإيجار مع المرفقات، قائمة ربح وخسارة، حركة نقدية، لوحة مدير، تقارير PDF، وتقرير يومي بالبريد.

> هذا المجلد مشروع Apps Script **مستقل** عن مشروع OrTec في جذر المستودع، ومحمي في `.claspignore` الأصلي حتى لا يُدفع بالخطأ.

## الملفات

| ملف | الدور |
|---|---|
| `Config.gs` | الإعدادات والثوابت وأسماء الأوراق والقوائم |
| `Utils.gs` | التاريخ (Asia/Muscat)، الأرقام، التنظيف، منع Formula Injection، وصول Sheets |
| `Setup.gs` | `setupSystem()`، `resetDemoPasswords()`، `removeDemoData()`، المجلدات، الإعدادات الافتراضية |
| `Auth.gs` | Hash + Salt في Script Properties، جلسات Token بمدة انتهاء، `requireSession_` |
| `Audit.gs` | Audit_Log و Error_Log |
| `SalesImport.gs` | تحليل CSV (BOM/اقتباسات)، مطابقة الأعمدة بالاسم، المعاينة، الاستيراد المجمّع، منع التكرار |
| `Purchases.gs` `Expenses.gs` `Payroll.gs` `Rent.gs` | التحقق على الخادم + الحفظ داخل LockService |
| `Attachments.gs` | حفظ المرفقات في `Walif Coffee Accounting/Invoices/YYYY/MM` |
| `Records.gs` | القوائم، الإلغاء بسبب (ACTIVE/CANCELLED)، التعديل بسبب |
| `Analytics.gs` | المحرك المالي (ربح محاسبي + حركة نقدية) والتجميعات والفلاتر |
| `Reports.gs` | بيانات التقارير + Google Docs → PDF في `Reports/YYYY/MM` |
| `EmailReports.gs` | التقرير اليومي بالبريد والمشغل Trigger |
| `Settings.gs` | إعدادات المدير |
| `Deploy.gs` | `deployWebApp()` و`showLinks()`: إنشاء/تحديث نشر Web App عبر Apps Script API |
| `Tests.gs` | `runSmokeTest()` داخل المحرر |
| `installer/` | المثبّت الذاتي (لا يُدفع إلى المشروع) |
| `Index.html` `Login.html` `Accountant.html` `Dashboard.html` `Styles.html` `Scripts.html` | الواجهة العربية RTL المتجاوبة |
| `appsscript.json` | المنطقة الزمنية Asia/Muscat، الصلاحيات، إعداد Web App |

## النشر (مرة واحدة)

### الطريقة A — المثبّت الذاتي من داخل المحرر (الأسهل، بلا أدوات على الجهاز)

1. فعّل **Google Apps Script API** من https://script.google.com/home/usersettings (مرة واحدة).
2. في محرر Apps Script المرتبط بالملف: ⚙️ Project Settings → فعّل "Show appsscript.json manifest file in editor".
3. افتح `appsscript.json` في المحرر واستبدل محتواه بمحتوى `installer/appsscript.json`.
4. افتح `Code.gs` واستبدل محتواه بمحتوى `installer/Installer.gs` ثم احفظ.
5. اختر الدالة `installWalifCoffee` واضغط Run ووافق على الصلاحيات. تُنزَّل كل ملفات المشروع من GitHub وتُكتب في المشروع.
6. أعد تحميل صفحة المحرر: ستجد 20 ملف `.gs` و6 ملفات HTML.
7. شغّل `setupSystem` ووافق على الصلاحيات، ثم شغّل `deployWebApp` وستجد رابط Web App في Execution log (أو شغّل `showLinks`).

### الطريقة B — بواسطة clasp

```bash
npm i -g @google/clasp
clasp login                      # يفتح المتصفح لحساب Google الذي يملك ملف "Walif Coffe"
# احصل على Script ID من محرر Apps Script: Project Settings → Script ID
cd walif-coffee
sed -i 's/PASTE_WALIF_COFFEE_SCRIPT_ID_HERE/<SCRIPT_ID>/' .clasp.json
clasp push -f                    # يرفع كل ملفات .gs و .html و appsscript.json
```

> يجب أن يكون مشروع Apps Script **مرتبطًا** بملف Google Sheets (Extensions → Apps Script من داخل الملف). تحقق من ذلك قبل الدفع.
> إذا لم يسمح الحساب بواجهة Apps Script API: فعّلها من https://script.google.com/home/usersettings ثم أعد `clasp push`.

### الطريقة B — يدويًا

في محرر Apps Script المرتبط بالملف: أنشئ ملفًا لكل اسم أعلاه (Script لملفات `.gs`، HTML لملفات `.html`) والصق المحتوى، ثم من Project Settings فعّل "Show appsscript.json" والصق محتوى `appsscript.json`.

### بعد رفع الكود

1. في المحرر اختر الدالة `setupSystem` واضغط **Run** ووافق على الصلاحيات (Sheets, Drive, Docs, Gmail, Triggers).
   - تُنشأ الأوراق الإحدى عشرة، المجلدات في Drive، الحسابان التجريبيان، الإعدادات الافتراضية، وتُضبط المنطقة الزمنية.
   - تُنشأ 4 سجلات تجريبية (Notes = DEMO) فقط إذا كانت الأوراق فارغة. لحذفها بعد الاختبار: شغّل `removeDemoData()`.
2. (اختياري) شغّل `runSmokeTest()` وراجع سجل التنفيذ.
3. **Deploy → New deployment → Web app**: Execute as **Me**، Who has access: **Anyone** (تسجيل الدخول داخلي بالنظام نفسه؛ لا يحتاج المستخدم حساب Google).
   - إن كان الحساب ضمن Workspace واختير "Anyone within organization" فسيلزم دخول Google أولًا ثم دخول النظام.
4. افتح رابط `/exec` وسجّل الدخول.
5. التقرير اليومي مضبوط افتراضيًا على khalid98115159@gmail.com الساعة 8 صباحًا (تقرير اليوم السابق) ويُنشأ الـ Trigger أثناء `setupSystem`. من حساب المدير → الإعدادات يمكن تغيير البريد أو الساعة، واضغط "إرسال تقرير تجريبي الآن" للتحقق.
6. **غيّر كلمات المرور التجريبية** من صفحة الإعدادات قبل الاستخدام الفعلي.
7. عند أي تعديل لاحق في الكود: `clasp push` ثم Deploy → Manage deployments → Edit → New version، حتى يبقى الرابط نفسه.

## الروابط

- Google Sheet: https://docs.google.com/spreadsheets/d/1HfsBDCDY5Wyy0A18fnG_VGYO0xYC9tjMMOkQN9e2nxQ/edit
- مشروع Apps Script: https://script.google.com/home/projects/1r-qeHMzlTbvtp70wD_lWA0jzzYtzK-jKSwQBJeIpBhJcbIjPv7nNHqb/edit

## الحسابات التجريبية

| الدور | المستخدم | كلمة المرور |
|---|---|---|
| المحاسب | `accountant` | `1234` |
| المدير | `manager` | `2026` |

`resetDemoPasswords()` تعيد كلمتي المرور التجريبيتين فقط دون المساس بالبيانات.

## القواعد المالية

- **الربح المحاسبي**: صافي المبيعات − تكلفة البضاعة المباعة (من Loyverse) = مجمل الربح؛ − (المصروفات + الرواتب + الإيجار) = صافي الربح التشغيلي. فواتير المخزون **لا** تُخصم مرة ثانية.
- **الحركة النقدية**: صافي المبيعات − المشتريات المدفوعة − المصروفات المدفوعة − الرواتب المدفوعة − الإيجار المدفوع.
- المرتجعات (Refund) تُخزَّن بالسالب؛ السجلات بحالة Cancelled/Void تُرفض.
- مفتاح تكرار سجل المبيعات: `Store|Receipt number|Date|SKU|Item|Quantity|Net sales`.
- مفتاح تكرار فاتورة الشراء: `Supplier|Invoice Number|Invoice Date|Total`.
- إسناد الفترات: المصروفات بتاريخ المصروف، المشتريات بتاريخ الفاتورة، الرواتب والإيجار بتاريخ الدفع إذا كانت مدفوعة وإلا بنهاية الشهر/تاريخ الاستحقاق.

## الاختبار محليًا (بدون Google)

```bash
cd walif-coffee
node tools/run-local-tests.js   # 42 اختبارًا للخادم على محاكي Apps Script في الذاكرة
node tools/ui-test.js           # اختبار المتصفح الكامل (محاسب/مدير، هاتف/سطح مكتب) مع لقطات في tests/screenshots
node tools/dev-server.js        # معاينة الواجهة على http://localhost:8787
```

ملف `tests/sample-loyverse.csv` يحتوي 20 سطرًا بالأعمدة الـ 22 نفسها (مع سطر مكرر، سطر ملغى، ومرتجع) لاختبار المعاينة ومنع التكرار.
