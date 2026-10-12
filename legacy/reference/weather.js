const cron = require('node-cron');

const CITIES = [
    { name: 'الإسكندرية', lat: 31.2, lon: 29.9 },
    { name: 'القاهرة', lat: 30.0, lon: 31.2 },
    { name: 'المنيا', lat: 28.1, lon: 30.7 },
    { name: 'الأقصر', lat: 25.7, lon: 32.6 }
];

async function getWeather(city) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current_weather=true`;
    const res = await fetch(url);
    const data = await res.json();
    const w = data.current_weather;
    return `${city.name}: 🌡 ${w.temperature}°C 💨 ${w.windspeed} km/h`;
}

async function sendWeather(bot, chatId) {
    try {
        let text = '🌤 تقرير الطقس اليوم:\n\n';
        for (const city of CITIES) {
            text += await getWeather(city) + '\n';
        }
        await bot.telegram.sendMessage(chatId, text);
    } catch (e) {
        console.log('خطأ في الطقس:', e.message);
    }
}

function startWeather(bot, chatId) {
    // مرتان يوميًا: 13:00 و 20:00
    cron.schedule('0 13 * * *', () => sendWeather(bot, chatId));
    cron.schedule('0 20 * * *', () => sendWeather(bot, chatId));
    console.log('⏰ تم جدولة الطقس (13:00 و 20:00)');
}

module.exports = { startWeather };
