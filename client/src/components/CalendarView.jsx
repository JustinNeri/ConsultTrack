import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarPlus, ChevronLeft, ChevronRight, Users } from 'lucide-react';
import { api } from '../lib/api.js';
import { toDateInput } from '../lib/schedule.js';

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

/** Monday of the week containing `date`. */
function startOfWeek(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay is 0 for Sunday; a campus week starts on Monday.
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

const STATUS_TINT = {
  scheduled: 'border-brand-200 bg-brand-50 text-brand-800',
  pending: 'border-gold-200 bg-gold-50 text-gold-800',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-800',
};

/**
 * The week, as a week.
 *
 * Every other list in this app answers "what is next". An adviser deciding
 * whether to take a Thursday meeting is asking a different question -- what does
 * Thursday already look like -- and a list cannot answer it. Sessions are laid
 * out by day so the gaps are as visible as the bookings.
 */
export default function CalendarView({ token, onOpenConsultation, onBook }) {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [consultations, setConsultations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(anchor, index)),
    [anchor],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api(
        `/calendar?from=${toDateInput(days[0])}&to=${toDateInput(days[6])}`,
        { token },
      );
      setConsultations(result.consultations ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [days, token]);

  useEffect(() => {
    load();
  }, [load]);

  // One bucket per day, keyed the same way the day headers are.
  const byDay = useMemo(() => {
    const buckets = new Map(days.map((day) => [toDateInput(day), []]));
    for (const item of consultations) {
      const key = toDateInput(new Date(item.meeting_date));
      if (buckets.has(key)) buckets.get(key).push(item);
    }
    return buckets;
  }, [consultations, days]);

  const today = toDateInput(new Date());

  return (
    <div className="animate-rise">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-ink-900">Calendar</h1>
          <p className="mt-1 text-body text-ink-500">
            {monthFormatter.format(days[0])}
            {days[0].getMonth() !== days[6].getMonth()
              ? ` – ${monthFormatter.format(days[6])}`
              : ''}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor((prev) => addDays(prev, -7))}
            aria-label="Previous week"
            className="rounded-lg border border-ink-200 bg-white p-2 text-ink-600 transition hover:border-ink-300 hover:bg-ink-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setAnchor(startOfWeek(new Date()))}
            className="rounded-lg border border-ink-200 bg-white px-3.5 py-2 text-body font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setAnchor((prev) => addDays(prev, 7))}
            aria-label="Next week"
            className="rounded-lg border border-ink-200 bg-white p-2 text-ink-600 transition hover:border-ink-300 hover:bg-ink-50"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onBook}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-body font-semibold text-white transition hover:bg-brand-600"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            Schedule
          </button>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-body font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {days.map((day) => {
          const key = toDateInput(day);
          const items = byDay.get(key) ?? [];
          const isToday = key === today;
          return (
            <section
              key={key}
              className={`rounded-xl border p-3 ${
                isToday ? 'border-brand-300 bg-brand-50/40' : 'border-ink-200 bg-white'
              }`}
            >
              <div className="mb-2.5 flex items-baseline justify-between">
                <p
                  className={`text-small font-semibold uppercase tracking-wide ${
                    isToday ? 'text-brand-700' : 'text-ink-500'
                  }`}
                >
                  {weekdayFormatter.format(day)}
                </p>
                <p
                  className={`tnum text-h3 font-semibold ${isToday ? 'text-brand-700' : 'text-ink-900'}`}
                >
                  {day.getDate()}
                </p>
              </div>

              {loading ? (
                <div className="skeleton h-16 rounded-lg" />
              ) : items.length === 0 ? (
                <p className="rounded-lg border border-dashed border-ink-200 px-2 py-4 text-center text-small text-ink-400">
                  Free
                </p>
              ) : (
                <ul className="space-y-2">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onOpenConsultation?.(item.id)}
                        className={`w-full rounded-lg border px-2.5 py-2 text-left transition hover:brightness-95 ${
                          STATUS_TINT[item.status] ?? 'border-ink-200 bg-ink-50 text-ink-700'
                        }`}
                      >
                        <p className="tnum text-small font-semibold">
                          {timeFormatter.format(new Date(item.meeting_date))}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[13px] font-medium leading-snug">
                          {item.topic}
                        </p>
                        {item.group_name ? (
                          <p className="mt-0.5 truncate text-[11px] opacity-80">
                            {item.group_name}
                          </p>
                        ) : null}
                        {item.panel_size > 0 ? (
                          <p className="mt-1 flex items-center gap-1 text-[11px] opacity-80">
                            <Users className="h-3 w-3" aria-hidden="true" />
                            Panel of {item.panel_size + 1}
                          </p>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <p className="mt-4 flex flex-wrap items-center gap-4 text-small text-ink-500">
        <Legend className="border-brand-200 bg-brand-50">Scheduled</Legend>
        <Legend className="border-gold-200 bg-gold-50">Awaiting approval</Legend>
        <Legend className="border-emerald-200 bg-emerald-50">Wrapped up</Legend>
      </p>
    </div>
  );
}

function Legend({ className, children }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-3 w-3 rounded border ${className}`} aria-hidden="true" />
      {children}
    </span>
  );
}
