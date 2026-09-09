/**
 * Consultation-hour helpers shared by the adviser's availability screen and the
 * student's slot picker.
 *
 * Weekday numbering follows the API, which follows Postgres `extract(dow)`:
 * 0 is Sunday. Do not renumber this without changing the column too.
 */

export const WEEKDAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 0, label: 'Sunday', short: 'Sun' },
];

export const SLOT_CHOICES = [15, 20, 30, 45, 60, 90, 120];

export function weekdayLabel(value) {
  return WEEKDAYS.find((day) => day.value === value)?.label ?? '';
}

export function weekdayShort(value) {
  return WEEKDAYS.find((day) => day.value === value)?.short ?? '';
}

/** "13:00" -> "1:00 PM". Blocks are stored as wall-clock strings, not dates. */
export function formatClock(hhmm) {
  const [hours, minutes] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(hours)) return hhmm;
  const period = hours < 12 ? 'AM' : 'PM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${period}`;
}

/** How many slots a block yields, which is what an adviser actually cares about. */
export function slotCount({ start_time: start, end_time: end, slot_minutes: slotMinutes }) {
  const toMinutes = (value) => {
    const [h, m] = String(value).split(':').map(Number);
    return h * 60 + m;
  };
  return Math.floor((toMinutes(end) - toMinutes(start)) / slotMinutes);
}

/**
 * Times are shown in the campus timezone the API reports rather than the
 * browser's, so a slot always reads as the hour the adviser will be in the room.
 */
export function slotTimeFormatter(timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** `YYYY-MM-DD` for a Date, in local time - `toISOString` would shift the day. */
export function toDateInput(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/** The weekday number of a `YYYY-MM-DD` string, read as a plain calendar date. */
export function weekdayOf(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!year) return null;
  return new Date(year, month - 1, day).getDay();
}

/**
 * The next `count` dates on which the adviser holds hours at all, so the picker
 * can offer real days instead of letting a student hunt through a calendar for
 * one that is not empty.
 */
export function upcomingDatesFor(weekdays, count = 8, from = new Date()) {
  if (!weekdays?.length) return [];

  const allowed = new Set(weekdays);
  const dates = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());

  // 8 weeks is a whole term's worth of lookahead; past that, nobody is booking.
  for (let step = 0; step < 56 && dates.length < count; step += 1) {
    if (allowed.has(cursor.getDay())) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}
