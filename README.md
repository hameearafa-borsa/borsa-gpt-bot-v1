# Borsa GBT Bot V1 Mona Lisa — 1.0.2

**الحالة: إصلاح تعارض 409، وتعرّف المجموعة، ومرجع المساعد الكيميائي.** المفاتيح الحية ما زالت تُختبر في بيئة التشغيل نفسها.

## ما أُصلح في 1.0.2
- خطأ 409: Telegraf كان يرمي التعارض ثم تُغلق العملية فيعيد Railway تشغيلها فوق النسخة القديمة. السحب الآن مخصص، يعيد المحاولة دون الخروج، ويحذف أي webhook قديم قبل polling. قفل PostgreSQL (`pg_try_advisory_lock`) يمنع نسختين على نفس القاعدة. إن بقيت نسخة Termux أو خدمة Railway ثانية على نفس التوكن، تظهر رسالة `TELEGRAM_409` حتى تُوقفها.
- وضع webhook اختياري: اضبط `WEBHOOK_URL=https://نطاق-railway` و`WEBHOOK_SECRET` فيتوقف polling. اتركهما فارغين للـ polling بنسخة واحدة. مسار الاستقبال `/telegram/webhook` والفحص الصحي `/health`.
- تعرّف المجموعة: الإضافة من المالك أو منشئ/مشرف تُفعّل المجموعة. فشل معرفة رتبة المُضيف لم يعد يُخرج البوت. الأمر `/activate` من المشرف، أو كون البوت مشرفًا، أو `GROUP_CHAT_IDS` و`DEALS_CHAT_ID` يعيد التفعيل. العضو العادي ما زال لا يضيف البوت إلى مجموعة غريبة.
- المساعد الكيميائي: مرجع محلي للمواد وإطارات سائل الجلي والمسحوق والمنعم، وإجابة منظمة. إذا كان رد النموذج قصيرًا أو غائبًا يُعرض المرجع. أسئلة المجموعة عن المواد تُجاب بعد التفعيل، وأسطر الأسعار لا تُعامل كسؤال كيميائي. تحذير الكلور مع الحمض أو الأمونيا يبقى بلا خطوات خلط.

## ما أُصلح في 1.0.1
- الذكاء الاصطناعي: GPT-6 Luna وGrok 4.7 لا يستقبلان `temperature` مع التفكير. الطلب صار عبر Responses API، مع مهلة إجمالية ومحاولة احتياطية على Chat Completions، ومن دون إرسال معامل العينات المرفوض.
- قاعدة البيانات: إزالة `sslmode` من رابط Railway حتى لا يلغي إعداد الشهادة، مع إعادة المحاولة عند انقطاع الاتصال، وتنفيذ الترحيل عبارةً بعبارة.
- رصد الأسعار: سطر مثل «أريال 2 كيلو 490 جنيه» كان يُرفض لأن ثقته 0.55 أقل من حد 0.80. المطابقة مع السجل تُحفظ الآن، وغير المعروف يُحفظ للمراجعة، مع اسم المنتج والوزن وربطه بالكتالوج.
- قوائم الأسعار: سعر لا يظهر في النص الأصلي لا يُقبل من النموذج.
- الطقس والسوق: قياس حي من Open-Meteo مع بديل MET Norway إذا امتلأ حد Open-Meteo، ونشرة دولار/ذهب/برنت من مصادر عامة، بلا أرقام مخترعة عند الفشل.
- الجدولة بتوقيت القاهرة، وتحذير الخلط الكيميائي لم يعد يشتعل لمجرد كلمة «خلط».
- سحب أمازون يطلب الصفحة بالعربية ويعيد المحاولة مع `render=true` إذا لم تُستخرج بطاقات.

## مبادئ ثابتة
- مصدر عمل رئيسي واحد؛ كل تعديل لاحق يُطبّق على هذا المجلد نفسه.
- لا حذف لأي وظيفة قديمة قبل تسجيلها في `LEGACY-MIGRATION-MAP.md` وتحديد بديلها أو سبب استبعادها.
- GPT يقترح/يصنّف فقط؛ كود البوت يتحقق قبل الحفظ أو النشر.
- سعر العبوة هو المؤشر التجاري، والوزن الأساسي/الوزن الإضافي/الوزن الكلي/عدد القطع صفات منفصلة.
- الرصد صامت؛ لا رسالة «تم الرصد» لكل سعر.
- منع التكرار حسب الرسالة، مع عدم معالجة رسائل البوت أو قناة السجلات.
- تقارير الأخطاء تحمل Report ID، وتُحجب الأسرار قبل السجل أو الإرسال.
- روابط البحث تُولّد بقوالب ثابتة وتُقبل فقط عبر HTTPS والدومينات المحددة.
- `.env` محلي/بيئة تشغيل فقط، وممنوع رفعه إلى GitHub أو إرساله في المحادثة.

## البيئة
المطلوب Node.js 24.x، وPostgreSQL الحالية؛ التشغيل يرفض البدء دون `DATABASE_URL`، ومتغيرات البيئة الموضحة في `.env.example`. لا تضع قيم الأسرار في هذا الملف؛ إنه قالب بأسماء المتغيرات فقط.

## فحوص المختبر التي نُفذت
- `node tests/run-all.js`
- `node tests/links-diagnostics.test.js`
- فحوص نحوية لكل ملفات JavaScript

نجحت الاختبارات المحلية الموجودة في الحزمة. **لم يتم اختبار مفاتيح API الحقيقية أو Telegram الحقيقي أو اتصال قاعدة الإنتاج**؛ لذلك لا ندّعي أن التشغيل الإنتاجي قد تم التحقق منه. محاولة إنشاء `package-lock.json` في بيئة المختبر انتهت بمهلة اتصال، لذا يجب توليد lockfile في Termux قبل اعتبار الحزمة قابلة للبناء النهائي.

## قبل الإنتاج — بوابات إلزامية
1. إكمال/اعتماد ترحيل ميزات الحماية والإدارة والجدولة والعروض من المصدر القديم؛ التفاصيل في `LEGACY-MIGRATION-MAP.md`.
2. توليد `package-lock.json` عبر `npm install` في Termux والتحقق من `npm ci` بعد ذلك.
3. أخذ نسخة احتياطية من PostgreSQL، ثم فحص المخطط الحالي ومقارنته بملفات migrations؛ لا تشغّل migrations على قاعدة الإنتاج قبل المراجعة.
4. اختبار OpenAI Responses API فعليًا من Termux بمفتاح مخزّن محليًا، دون طباعته أو إرساله.
5. اختبار Telegram في مجموعة اختبار، ثم اختبار الاستعادة والتراجع.
6. بعد اجتياز ما سبق فقط: تحديث GitHub وربط خدمة Railway الحالية دون إنشاء خدمة أو قاعدة ثانية.

## RC1 legacy-service additions
See `LEGACY-MIGRATION-MAP.md` and `RC1-ADDITIVE-PATCH-NOTES.md` for the full migration status. This patch is additive: the original legacy source snapshots are retained in `legacy/reference/` and are not loaded by the runtime.

Optional environment values:
- `SCRAPER_API_KEY`: required for live deal scraping via ScraperAPI.
- `DEALS_CHAT_ID`: publication destination for the scheduled deal newsletters. If unset, the deal scheduler remains disabled.
- `GROUP_CHAT_IDS`: comma-separated chat ids to authorize on startup when the bot is already a member.
- `WEBHOOK_URL` / `WEBHOOK_SECRET`: webhook is mandatory. Empty `WEBHOOK_URL` still works when Railway sets `RAILWAY_PUBLIC_DOMAIN`. There is no polling fallback. Secret characters are `A-Za-z0-9_-` only.
- `PROTECTION_ENFORCE=false`: recommended default; protection records suspicious messages without deleting them. Only set to `true` after reviewing the diagnostics and confirming the bot has delete permissions.

The fresh RC1 `package-lock.json` could not be generated in the lab because npm registry access timed out. Do not use `legacy/reference/package-lock.json` as the RC1 lockfile; it belongs to the legacy dependency graph. See `RC1-ADDITIVE-PATCH-NOTES.md`.

## Legacy moderation/activity commands added in RC1 patch
- `/warn USER_ID reason` records a warning for an authorized group manager.
- `/warnings USER_ID` lists active warnings.
- `/clearwarn USER_ID` clears active warnings.
- `/inactive [days]` reports previously observed members whose last observed message is older than the threshold. It is not a full member census because Telegram bots cannot enumerate all ordinary group members through the Bot API.
- Activity tracking and warning counts are persisted in PostgreSQL. Reaching three warnings produces a review notice; the bot does not automatically mute on that count in this patch.

## Private controller panel additive update
- Open `/panel` in a private chat as the master or verified group creator.
- Inline actions re-check controller authorization on every callback; do not rely on hidden buttons alone.
- Global and group command menus are cleared; the command list is scoped to the master and verified group-owner private chats.
- The panel includes a live ScraperAPI source test. It reports configured/not configured and request outcome without revealing the API key.
- RC1 still requires a freshly generated root `package-lock.json` and `npm ci` verification. The archived legacy lockfile is reference-only and must not be used as the RC1 lock.

## Read-only live release preflight

After installing the declared dependencies in the runtime environment, run `npm run preflight:live`. This check is deliberately read-only: it does not run migrations, send Telegram messages, publish deals, or print API keys/tokens. It checks PostgreSQL connectivity and required columns, Telegram `getMe`, access to `DEALS_CHAT_ID` without sending a test post, and one live Amazon/ScraperAPI query when `SCRAPER_API_KEY` exists.

Exit status: `0` all performed checks passed; `1` at least one check failed; `2` one or more live checks were blocked because required environment variables were absent. A blocked check is not a pass. A successful HTTP response with zero extracted products is not proof that the retailer parser is healthy.
