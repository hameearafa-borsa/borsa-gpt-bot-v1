# Borsa GBT Bot V1 Mona Lisa — Release Candidate 1

**الحالة: مرشح إصلاح ومراجعة (RC1+). غير معتمد للإنتاج حتى اجتياز اختبارات Termux والتكامل الحي.** لا ترفع هذه الحزمة إلى Railway قبل إكمال بوابات الإصدار أدناه.

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
- `node tests/weather-live-parser.test.js` (mocked HTTP responses; no live provider call)
- فحوص نحوية لكل ملفات JavaScript

نجحت الاختبارات المحلية الموجودة في الحزمة. **لم يتم اختبار مفاتيح API الحقيقية أو Telegram الحقيقي أو اتصال قاعدة الإنتاج**؛ لذلك لا ندّعي أن التشغيل الإنتاجي قد تم التحقق منه. تم تحديث `package-lock.json` محليًا باستخدام npm، لكن يجب التحقق من `npm ci` على Node.js 24.x قبل اعتبار الحزمة قابلة للبناء النهائي.

## قبل الإنتاج — بوابات إلزامية
1. إكمال/اعتماد ترحيل ميزات الحماية والإدارة والجدولة والعروض من المصدر القديم؛ التفاصيل في `LEGACY-MIGRATION-MAP.md`.
2. توليد `package-lock.json` عبر `npm install` في Termux والتحقق من `npm ci` بعد ذلك.
3. أخذ نسخة احتياطية من PostgreSQL، ثم فحص المخطط الحالي ومقارنته بملفات migrations؛ لا تشغّل migrations على قاعدة الإنتاج قبل المراجعة.
4. اختبار OpenAI Responses API فعليًا من Termux بمفتاح مخزّن محليًا، دون طباعته أو إرساله.
5. اختبار Telegram في مجموعة اختبار: `/claim` يجب أن ينفذه منشئ المجموعة الأصلي، ثم اختبار لوحة الخاص والاستعادة والتراجع.
6. اختبار الطقس الحي عبر Open-Meteo؛ الاختبار المحلي لا يستخدم الشبكة.
7. اختبار أوامر الحماية والإنذارات والرسائل المجدولة على مجموعة اختبار، مع التحقق من توقيت Africa/Cairo.
8. بعد اجتياز ما سبق فقط: تحديث GitHub وربط خدمة Railway الحالية دون إنشاء خدمة أو قاعدة ثانية.

## RC1 legacy-service additions
See `LEGACY-MIGRATION-MAP.md` and `RC1-ADDITIVE-PATCH-NOTES.md` for the full migration status. This patch is additive: the original legacy source snapshots are retained in `legacy/reference/` and are not loaded by the runtime.

Optional environment values:
- `SCRAPER_API_KEY`: required for live deal scraping via ScraperAPI.
- `DEALS_CHAT_ID`: publication destination for the scheduled deal newsletters. If unset, the deal scheduler remains disabled.
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

## إصلاحات RC1+ في هذا الأرشيف
- أُضيف `/claim` داخل المجموعة غير المسجلة، ويقبل الربط فقط إذا طابق المستخدم منشئ المجموعة الذي تعيده Telegram.
- أُضيفت قراءة طقس فعلية من Open-Meteo (بحث جغرافي ثم الطقس الحالي) مع فشل آمن دون اختلاق درجة الحرارة.
- أُضيف `OPENAI_API_KEY_3` إلى ترتيب مفاتيح OpenAI.
- أمر `/schedule` يفسر الوقت المحلي في توقيت القاهرة في الوقت الحالي؛ يجب مراجعة تحويل التوقيت عند تغيّر التوقيت الصيفي قبل الاعتماد السنوي.
- أُضيف اختبار وحدات لقراءة الطقس باستجابات HTTP محاكية.

## Read-only live release preflight

After installing the declared dependencies in the runtime environment, run `npm run preflight:live`. This check is deliberately read-only: it does not run migrations, send Telegram messages, publish deals, or print API keys/tokens. It checks PostgreSQL connectivity and required columns, Telegram `getMe`, access to `DEALS_CHAT_ID` without sending a test post, and one live Amazon/ScraperAPI query when `SCRAPER_API_KEY` exists.

Exit status: `0` all performed checks passed; `1` at least one check failed; `2` one or more live checks were blocked because required environment variables were absent. A blocked check is not a pass. A successful HTTP response with zero extracted products is not proof that the retailer parser is healthy.

## Telegram transport (Webhook only)

This candidate uses Telegram **Webhook** transport only; it does not start `getUpdates` polling. Configure `WEBHOOK_URL` as the complete public HTTPS endpoint, including a dedicated path such as `https://YOUR-RAILWAY-DOMAIN/telegram/webhook`, and set `WEBHOOK_SECRET` to a private 1–256 character token containing only letters, digits, `_`, and `-`. Railway supplies `PORT`; the process binds to `0.0.0.0` and exposes `GET /health`. The app registers the webhook with Telegram without dropping pending updates.

Do not run a second instance using the same token during cutover. This code change has only been locally tested; it does not verify the Railway domain, Telegram webhook registration, or live delivery. Shutdown preserves queued updates and does not call `deleteWebhook`.
