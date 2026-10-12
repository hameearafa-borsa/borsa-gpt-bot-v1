// ============================================
//  وحدة منع التكرار والحدود (antispam.js)
//  - مانع التكرار: 5 رسائل/دقيقة + كتم ساعة
//  - حد الصور: 3 صور (ألبومات تُحسب كمجموعة)
//  - حد الفيديو: 1 يومياً
// ============================================

const fs = require('fs');
const path = require('path');

// ---------- ذاكرة مؤقتة للعدّادات ----------
const msgCount = {};   // { [userId]: [timestamps] }
const imgCount = {};   // { [userId]: { date, count } }
const vidCount = {};   // { [userId]: { date, count } }
const albumBuffer = {}; // { [mediaGroupId]: { userId, chatId, photos: [ids], timer } }

const MSG_LIMIT = 5;
const MSG_WINDOW = 60;
const MUTE_SECONDS = 3600;

// ---------- ملف الإعدادات ----------
const SETTINGS_FILE = path.join(__dirname, 'antispam_settings.json');
let anti = {
    rateLimit: true,
    imageLimit: 3,      // الحد الجديد: 3 صور
    videoLimit: 1
};
function saveAnti() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(anti, null, 2));
}
function loadAnti() {
    try {
        const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        anti = { ...anti, ...d };
    } catch (e) {}
}
loadAnti();

// ---------- أدوات مساعدة ----------
function today() {
    return new Date().toISOString().slice(0, 10);
}

// ---------- 1) مانع التكرار ----------
function checkRate(userId) {
    const now = Date.now();
    if (!msgCount[userId]) msgCount[userId] = [];
    const arr = msgCount[userId];
    while (arr.length && now - arr[0] > MSG_WINDOW * 1000) arr.shift();
    arr.push(now);
    return arr.length > MSG_LIMIT;
}

// ---------- 2) حد الصور (زيادة يومية) ----------
function bumpImages(userId, n) {
    if (!imgCount[userId] || imgCount[userId].date !== today()) {
        imgCount[userId] = { date: today(), count: 0 };
    }
    imgCount[userId].count += n;
    return imgCount[userId].count;
}

// ---------- 3) حد الفيديو ----------
function bumpVideo(userId) {
    if (!vidCount[userId] || vidCount[userId].date !== today()) {
        vidCount[userId] = { date: today(), count: 0 };
    }
    vidCount[userId].count++;
    return vidCount[userId].count;
}

// ---------- كتم العضو ----------
async function muteUser(bot, chatId, userId, seconds) {
    try {
        await bot.telegram.restrictChatMember(chatId, userId, {
            can_send_messages: false,
            until_date: Math.floor(Date.now() / 1000) + seconds
        });
        return true;
    } catch (e) { return false; }
}

// ---------- معالجة ألبوم صور ----------
async function processAlbum(bot, entry) {
    const { userId, chatId, photos } = entry;
    const total = photos.length;
    if (total > anti.imageLimit) {
        // نحذف الصور الزائدة (بعد الحد)
        const toDelete = photos.slice(anti.imageLimit);
        for (const mid of toDelete) {
            try { await bot.telegram.deleteMessage(chatId, mid); } catch (e) {}
        }
        // نحسب فقط المسموح
        bumpImages(userId, anti.imageLimit);
        await bot.telegram.sendMessage(chatId,
            `📷 يرجى التفضل بنشر بيانات المنتج الكاملة والاستفسارات المطلوب الرد عليها حفاظاً على باقات الزملاء`);
    } else {
        bumpImages(userId, total);
    }
}

// ---------- نقطة الدخول الرئيسية ----------
async function handleMessage(bot, ctx) {
    if (!ctx.message || !ctx.message.from) return;
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    const msg = ctx.message;

    // ---------- 1) مانع التكرار ----------
    if (anti.rateLimit) {
        if (checkRate(userId)) {
            try { await bot.telegram.deleteMessage(chatId, msg.message_id); } catch (e) {}
            const ok = await muteUser(bot, chatId, userId, MUTE_SECONDS);
            await bot.telegram.sendMessage(chatId,
                `⛔ تم كتمك لمدة ساعة بسبب إرسال أكثر من ${MSG_LIMIT} رسالة في دقيقة.` +
                (ok ? '' : '\n(تعذّر الكتم — تأكد من صلاحيات البوت كأدمن)'));
            return true;
        }
    }

    // ---------- 2) حد الصور (يدعم الألبومات) ----------
    if (msg.photo && msg.photo.length) {
        if (msg.media_group_id) {
            // ألبوم: نجمّع الصور ونعالجها بعد ثوانٍ
            const gid = msg.media_group_id;
            if (!albumBuffer[gid]) {
                albumBuffer[gid] = { userId, chatId, photos: [], timer: null };
            }
            albumBuffer[gid].photos.push(msg.message_id);
            // نعالج بعد 1.5 ثانية من آخر صورة
            clearTimeout(albumBuffer[gid].timer);
            albumBuffer[gid].timer = setTimeout(() => {
                const entry = albumBuffer[gid];
                delete albumBuffer[gid];
                processAlbum(bot, entry);
            }, 1500);
            return true; // عالجنا الألبوم (لا نعد الصورة فردياً)
        } else {
            // صورة فردية
            const total = bumpImages(userId, 1);
            if (total > anti.imageLimit) {
                try { await bot.telegram.deleteMessage(chatId, msg.message_id); } catch (e) {}
                await bot.telegram.sendMessage(chatId,
                    `📷 يرجى التفضل بنشر بيانات المنتج الكاملة والاستفسارات المطلوب الرد عليها حفاظاً على باقات الزملاء`);
                return true;
            }
        }
    }

    // ---------- 3) حد الفيديو ----------
    if (msg.video) {
        if (bumpVideo(userId) > anti.videoLimit) {
            try { await bot.telegram.deleteMessage(chatId, msg.message_id); } catch (e) {}
            await bot.telegram.sendMessage(chatId,
                `🎬 يرجى التفضل بالاقتصاد في نشر الفيديوهات حفاظاً على باقات الزملاء`);
            return true;
        }
    }

    return false;
}

// ---------- لوحة إعدادات الأنتي-سبام ----------
function antiKeyboard() {
    const { Markup } = require('telegraf');
    return Markup.inlineKeyboard([
        [Markup.button.callback('⏱️ مانع التكرار: ' + (anti.rateLimit ? '✅' : '❌'), 'anti_rate')],
        [Markup.button.callback(`📷 حد الصور (${anti.imageLimit}): ` + (anti.imageLimit ? '✅' : '❌'), 'anti_img')],
        [Markup.button.callback('🎬 حد الفيديو (' + anti.videoLimit + '): ' + (anti.videoLimit ? '✅' : '❌'), 'anti_vid')],
        [Markup.button.callback('🔙 رجوع', 'back_menu')]
    ]);
}

module.exports = { handleMessage, antiKeyboard, anti, saveAnti };
