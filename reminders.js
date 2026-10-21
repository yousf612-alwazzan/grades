// تذكير الحصص: جدول أسبوعي (صف + يوم + وقت) وتنبيه قبل الحصة بدقائق يختارها المعلم.
// - أندرويد: إشعارات محلية حقيقية (تُجدول على الجهاز نفسه، تعمل والتطبيق مغلق وبعد إعادة التشغيل).
// - آيفون/المتصفح: ملف تقويم (.ics) بمواعيد أسبوعية متكررة وتنبيه قبل كل حصة — يضيفه المعلم لتقويم جواله.
// لا شيء يُرسل لأي مكان: كل الجدولة على الجهاز.
import { T, tr } from './i18n.js';
import { ar } from './ui.js';

export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; // 0 = الأحد
export const SCHOOL_DAYS = [0, 1, 2, 3, 4];
export const REMIND_CHOICES = [5, 10, 15, 30];
export const LESSON_MINUTES = 45;
const ID_BASE = 41000; // أرقام إشعارات التذكير (لا تتعارض مع إشعار المشاركة)

/** «١٠ دقائق» / «١٥ دقيقة» */
export function minutesText(n) {
  return n >= 3 && n <= 10 ? T`${ar(n)} دقائق` : T`${ar(n)} دقيقة`;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** ينظّف الجدول (من التخزين أو نسخة احتياطية). */
export function sanitizeSchedule(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, 200)) {
    if (!s || typeof s !== 'object') continue;
    const day = Number(s.day);
    const time = String(s.time || '');
    if (!Number.isInteger(day) || day < 0 || day > 6 || !TIME_RE.test(time) || typeof s.classId !== 'string') continue;
    const period = Number(s.period);
    out.push({
      id: typeof s.id === 'string' && s.id.length < 40 ? s.id : 'r' + Math.random().toString(36).slice(2, 9),
      classId: s.classId.slice(0, 40), day, time,
      period: Number.isInteger(period) && period >= 1 && period <= 12 ? period : null,
    });
  }
  return sortSchedule(out);
}
export function sortSchedule(list) {
  return list.slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

/** وقت التنبيه: الحصة ناقص الدقائق (قد يرجع لليوم السابق). */
export function reminderSlot(day, time, minutesBefore) {
  const [h, m] = time.split(':').map(Number);
  let t = h * 60 + m - Math.max(0, minutesBefore | 0);
  let d = day;
  while (t < 0) { t += 24 * 60; d = (d + 6) % 7; }
  return { day: d, hour: Math.floor(t / 60), minute: t % 60 };
}

/** الموعد القادم للحصة بعد «الآن». */
export function nextOccurrence(day, time, now = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  let add = (day - d.getDay() + 7) % 7;
  if (add === 0 && d <= now) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

/** إشعارات أندرويد (صيغة إضافة LocalNotifications). */
// حصة/حصتان: «الحصة ٣» أو «الحصتان ٣–٤»
export function periodText(s) {
  if (!s.period) return '';
  return s.span === 2 ? T`الحصتان ${ar(s.period)}–${ar(s.period + 1)}` : T`الحصة ${ar(s.period)}`;
}
// عنوان المدخل: صف المعلم، أو عنوان جاهز (من جدول المدرسة: «الثامن / 4»، «اجتماع»)
function entryLabel(s, byId) {
  const c = s.classId ? byId.get(s.classId) : null;
  return c ? c.label : (typeof s.label === 'string' && s.label ? s.label : '');
}

export function planNotifications(schedule, classes, minutesBefore) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  return schedule.filter((s) => entryLabel(s, byId)).map((s, i) => {
    const label = entryLabel(s, byId);
    const r = reminderSlot(s.day, s.time, minutesBefore);
    const per = s.period ? ' · ' + periodText(s) : '';
    const open = s.classId && byId.has(s.classId);
    return {
      id: ID_BASE + i,
      title: s.kind === 'meeting' ? T`«${label}» بعد ${minutesText(minutesBefore)}` : T`حصة «${label}» بعد ${minutesText(minutesBefore)}`,
      body: open ? T`${tr(DAYS[s.day])} ${ar(s.time)}${per} — اضغط لفتح الصف` : T`${tr(DAYS[s.day])} ${ar(s.time)}${per}`,
      channelId: 'class_reminders',
      schedule: { on: { weekday: r.day + 1, hour: r.hour, minute: r.minute }, allowWhileIdle: true },
      extra: { kind: 'class-reminder', classId: open ? s.classId : '' },
      smallIcon: 'ic_stat_share',
    };
  });
}

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const pad = (n) => String(n).padStart(2, '0');
const icsDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// سطور iCalendar لا تتجاوز ٧٥ بايت (تُطوى بمسافة)
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** ملف تقويم: موعد أسبوعي متكرر لكل حصة مع تنبيه قبلها. الوقت محلي (بتوقيت الجهاز). */
export function buildICS(schedule, classes, minutesBefore, now = new Date()) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  const stamp = new Date(now.getTime());
  const utc = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}T${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}00Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//grades-followup//class-reminders//AR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc(tr('جدول الحصص'))];
  for (const s of schedule) {
    const label = entryLabel(s, byId);
    if (!label) continue;
    const start = nextOccurrence(s.day, s.time, now);
    let end = new Date(start.getTime() + LESSON_MINUTES * 60000);
    if (TIME_RE.test(s.end || '')) { const [h, m] = s.end.split(':').map(Number); const e = new Date(start); e.setHours(h, m, 0, 0); if (e > start) end = e; }
    const name = s.kind === 'meeting' ? label : T`حصة ${label}`;
    const title = s.period ? `${name} (${periodText(s)})` : name;
    lines.push('BEGIN:VEVENT', `UID:${s.id}@grades-followup`, `DTSTAMP:${utc}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[s.day]}`, 'SUMMARY:' + icsEsc(title),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(title), `TRIGGER:-PT${Math.max(0, minutesBefore | 0)}M`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** يعيد جدولة كل تذكيرات أندرويد (يلغي القديمة أولًا). يرجع { ok, count, reason }. */
export async function syncNativeReminders(plugin, { schedule, classes, minutesBefore, enabled }) {
  if (!plugin) return { ok: false, reason: 'unsupported', count: 0 };
  try {
    const pending = await plugin.getPending();
    const ours = (pending && pending.notifications || []).filter((n) => Number(n.id) >= ID_BASE && Number(n.id) < ID_BASE + 1000);
    if (ours.length) await plugin.cancel({ notifications: ours.map((n) => ({ id: Number(n.id) })) });
    const list = enabled ? planNotifications(schedule, classes, minutesBefore) : [];
    if (!list.length) return { ok: true, count: 0 };
    let perm = await plugin.checkPermissions();
    if (perm.display !== 'granted') perm = await plugin.requestPermissions();
    if (perm.display !== 'granted') return { ok: false, reason: 'denied', count: 0 };
    try {
      await plugin.createChannel({ id: 'class_reminders', name: tr('تذكير الحصص'), description: tr('تنبيه قبل بداية كل حصة'), importance: 4, visibility: 1, vibration: true });
    } catch { /* الإصدارات الأقدم من أندرويد بلا قنوات */ }
    await plugin.schedule({ notifications: list });
    return { ok: true, count: list.length };
  } catch (e) {
    return { ok: false, reason: 'error', count: 0, message: String(e && e.message || e) };
  }
}
