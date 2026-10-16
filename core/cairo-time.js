"use strict";

const DEFAULT_TIME_ZONE = "Africa/Cairo";

function partsAt(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

function dateKeyAt(date, timeZone = DEFAULT_TIME_ZONE) {
  const p = partsAt(new Date(date), timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function sameLocal(a, b) {
  return ["year", "month", "day", "hour", "minute", "second"].every(k => a[k] === b[k]);
}

function offsetAt(date, timeZone = DEFAULT_TIME_ZONE) {
  const p = partsAt(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/**
 * Convert a strict YYYY-MM-DDTHH:mm local wall time to an instant in an IANA
 * time zone. Rejects nonexistent and repeated wall times instead of guessing.
 */
function parseLocalDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) throw new Error("صيغة الوقت غير صحيحة؛ استخدم YYYY-MM-DDTHH:mm");
  const wanted = { year:+m[1], month:+m[2], day:+m[3], hour:+m[4], minute:+m[5], second:0 };
  const utcGuess = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute, 0);
  const dateCheck = new Date(utcGuess);
  if (dateCheck.getUTCFullYear() !== wanted.year || dateCheck.getUTCMonth()+1 !== wanted.month ||
      dateCheck.getUTCDate() !== wanted.day || wanted.hour > 23 || wanted.minute > 59) {
    throw new Error("التاريخ أو الوقت غير صالح");
  }

  const candidates = new Set();
  for (let delta = -48; delta <= 48; delta += 3) {
    const sample = new Date(utcGuess + delta * 3600_000);
    const candidate = new Date(utcGuess - offsetAt(sample, timeZone));
    if (sameLocal(partsAt(candidate, timeZone), wanted)) candidates.add(candidate.getTime());
  }
  if (candidates.size === 0) throw new Error(`هذا الوقت المحلي غير موجود في ${timeZone} بسبب تغيير التوقيت؛ اختر وقتًا آخر`);
  if (candidates.size > 1) throw new Error(`هذا الوقت المحلي مكرر في ${timeZone} بسبب تغيير التوقيت؛ اختر وقتًا غير ملتبس`);
  return new Date([...candidates][0]);
}

function nextDailyOccurrence(previousInstant, timeZone = DEFAULT_TIME_ZONE) {
  const previous = new Date(previousInstant);
  if (Number.isNaN(previous.getTime())) throw new Error("موعد سابق غير صالح");
  const local = partsAt(previous, timeZone);
  const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const wall = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth()+1).padStart(2,"0")}-${String(nextDate.getUTCDate()).padStart(2,"0")}T${String(local.hour).padStart(2,"0")}:${String(local.minute).padStart(2,"0")}`;
  try { return parseLocalDateTime(wall, timeZone); }
  catch (error) {
    if (!/غير موجود/.test(error.message)) throw error;
    // If the wall time falls inside a spring-forward gap, advance to the first
    // valid local minute on that date so the daily job cannot become stuck due.
    const match = wall.match(/^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2})$/);
    const base = Date.UTC(Number(match[1].slice(0,4)), Number(match[1].slice(5,7))-1, Number(match[1].slice(8,10)), Number(match[2]), Number(match[3]));
    for (let i=1; i<=180; i++) {
      const d = new Date(base + i*60_000);
      const candidateWall = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}T${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
      try { return parseLocalDateTime(candidateWall, timeZone); }
      catch (nextError) { if (!/غير موجود|مكرر/.test(nextError.message)) throw nextError; }
    }
    throw error;
  }
}

module.exports = { DEFAULT_TIME_ZONE, partsAt, dateKeyAt, parseLocalDateTime, nextDailyOccurrence };
