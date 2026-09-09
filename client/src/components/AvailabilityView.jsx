import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CalendarRange,
  Clock,
  Loader2,
  MapPin,
  Plus,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import {
  SLOT_CHOICES,
  WEEKDAYS,
  formatClock,
  slotCount,
  weekdayLabel,
} from '../lib/schedule.js';

/**
 * The adviser's consultation hours.
 *
 * Publishing a block here is what fills the student's slot picker: "Wednesdays
 * 1-4 PM, 30-minute slots" becomes six bookable times every Wednesday. Until an
 * adviser publishes something, students keep the old free-form booking, so this
 * screen is an upgrade rather than a gate.
 */
export default function AvailabilityView({ token, onSignOut, onHoursChanged }) {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api('/availability', { token });
      setBlocks(result.availability ?? []);
      setError('');
    } catch (err) {
      if (err.status === 401) {
        onSignOut();
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [onSignOut, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function removeBlock(block) {
    if (busyId) return;
    setBusyId(block.id);
    setError('');
    setNotice('');

    try {
      await api(`/availability/${block.id}`, { method: 'DELETE', token });
      setBlocks((prev) => prev.filter((item) => item.id !== block.id));
      setNotice(
        `Removed ${weekdayLabel(block.weekday)} ${formatClock(block.start_time)}. Sessions already booked in it stay on your schedule.`,
      );
    } catch (err) {
      if (err.status === 401) {
        onSignOut();
        return;
      }
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const totalSlots = useMemo(
    () => blocks.reduce((sum, block) => sum + slotCount(block), 0),
    [blocks],
  );

  // The overview nudges an adviser who has published nothing. Publishing here
  // has to retire it straight away, not on the next dashboard reload.
  useEffect(() => {
    if (!loading) onHoursChanged?.(blocks.length);
  }, [blocks.length, loading, onHoursChanged]);

  return (
    <div className="animate-rise">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">
            Consultation hours
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-500">
            Publish the hours you are free each week. Students then book a slot out of them
            instead of guessing a time and waiting to be declined.
          </p>
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 active:scale-[0.99]"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add hours
          </button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-800"
        >
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice('')}
            aria-label="Dismiss"
            className="rounded p-0.5 text-emerald-700/70 transition hover:text-emerald-900"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {adding ? (
        <AddHoursForm
          token={token}
          onCancel={() => setAdding(false)}
          onAdded={(block) => {
            setAdding(false);
            setError('');
            setBlocks((prev) =>
              [...prev, block].sort(
                (a, b) =>
                  a.weekday - b.weekday || a.start_time.localeCompare(b.start_time),
              ),
            );
            setNotice(
              `${weekdayLabel(block.weekday)} ${formatClock(block.start_time)}-${formatClock(block.end_time)} published - ${slotCount(block)} bookable slots a week.`,
            );
          }}
          onUnauthorized={onSignOut}
        />
      ) : null}

      {loading ? (
        <div className="skeleton h-64 rounded-xl" />
      ) : blocks.length === 0 ? (
        <EmptyHours onAdd={() => setAdding(true)} showButton={!adding} />
      ) : (
        <>
          <WeekGrid blocks={blocks} />

          <div className="mt-6 flex items-center justify-between gap-3">
            <h2 className="text-base font-bold tracking-tight text-ink-900">
              Published blocks
            </h2>
            <p className="text-xs font-semibold text-ink-500">
              {blocks.length} {blocks.length === 1 ? 'block' : 'blocks'} - {totalSlots} slots a
              week
            </p>
          </div>

          <ul className="mt-3 space-y-3">
            {blocks.map((block, index) => (
              <li
                key={block.id}
                className="animate-rise"
                style={{ '--delay': `${index * 40}ms` }}
              >
                <BlockRow
                  block={block}
                  busy={busyId === block.id}
                  onRemove={() => removeBlock(block)}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- week grid -- */

/**
 * The week at a glance. Each day is a column and each block a crimson card
 * inside it, so a lopsided week - four blocks on Monday, nothing after - is
 * obvious without reading a single time.
 */
function WeekGrid({ blocks }) {
  const byDay = useMemo(() => {
    const map = new Map(WEEKDAYS.map((day) => [day.value, []]));
    for (const block of blocks) map.get(block.weekday)?.push(block);
    return map;
  }, [blocks]);

  return (
    <section className="overflow-hidden rounded-xl bg-white border border-ink-200">
      <div className="flex items-center gap-2 border-b border-ink-100 px-5 py-4">
        <CalendarRange className="h-4 w-4 text-brand-700" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">Your week</h2>
      </div>

      <div className="scrollbar-slim overflow-x-auto">
        <div className="grid min-w-[46rem] grid-cols-7 divide-x divide-ink-100">
          {WEEKDAYS.map((day) => {
            const dayBlocks = byDay.get(day.value) ?? [];
            return (
              <div key={day.value} className="min-h-40 p-3">
                <p
                  className={`mb-2.5 text-center text-[11px] font-semibold uppercase tracking-wider ${
                    dayBlocks.length ? 'text-brand-700' : 'text-ink-300'
                  }`}
                >
                  {day.short}
                </p>

                {dayBlocks.length === 0 ? (
                  <p className="mt-6 text-center text-[11px] font-medium text-ink-300">-</p>
                ) : (
                  <ul className="space-y-2">
                    {dayBlocks.map((block) => (
                      <li
                        key={block.id}
                        className="rounded-lg bg-brand-700 px-2.5 py-2 text-center text-white shadow-sm"
                      >
                        <p className="text-[11px] font-semibold leading-tight">
                          {formatClock(block.start_time)}
                        </p>
                        <p className="text-[10px] font-medium leading-tight text-brand-100/85">
                          to {formatClock(block.end_time)}
                        </p>
                        <p className="mt-1 text-[10px] font-semibold text-gold-200">
                          {slotCount(block)} slots
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function BlockRow({ block, busy, onRemove }) {
  return (
    <article className="flex flex-wrap items-center gap-4 rounded-xl bg-white p-4 border border-ink-200 transition-colors hover:border-ink-300">
      <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 leading-none">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-600">
          Every
        </span>
        <span className="mt-0.5 text-sm font-semibold text-brand-800">
          {weekdayLabel(block.weekday).slice(0, 3)}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-bold tracking-tight text-ink-900">
          {formatClock(block.start_time)} - {formatClock(block.end_time)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium text-ink-500">
          <span className="flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5" aria-hidden="true" />
            {block.slot_minutes}-minute slots
          </span>
          <span className="flex items-center gap-1.5 font-bold text-emerald-700">
            {slotCount(block)} bookable
          </span>
          {block.location ? (
            <span className="flex items-center gap-1.5 truncate">
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {block.location}
            </span>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${weekdayLabel(block.weekday)} ${formatClock(block.start_time)} hours`}
        className="ml-auto rounded-lg p-2.5 text-ink-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </article>
  );
}

/* ------------------------------------------------------------- add form -- */

function AddHoursForm({ token, onCancel, onAdded, onUnauthorized }) {
  const [form, setForm] = useState({
    weekday: 1,
    start_time: '13:00',
    end_time: '16:00',
    slot_minutes: 30,
    location: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Live preview of what the block will produce, so the numbers are checked
  // before the server has to reject them.
  const preview = slotCount({
    start_time: form.start_time,
    end_time: form.end_time,
    slot_minutes: form.slot_minutes,
  });
  const valid = form.end_time > form.start_time && preview >= 1;

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting || !valid) return;

    setSubmitting(true);
    setError('');
    try {
      const result = await api('/availability', {
        method: 'POST',
        token,
        body: {
          weekday: Number(form.weekday),
          start_time: form.start_time,
          end_time: form.end_time,
          slot_minutes: Number(form.slot_minutes),
          location: form.location.trim() || null,
        },
      });
      onAdded(result.availability);
    } catch (err) {
      if (err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="animate-rise mb-6 rounded-xl bg-white p-5 shadow-raised ring-1 ring-brand-100"
    >
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-700 text-white">
          <Clock className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 className="text-base font-bold tracking-tight text-ink-900">
          New consultation hours
        </h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="hours-day" label="Day">
          <select
            id="hours-day"
            value={form.weekday}
            onChange={(event) => update('weekday', Number(event.target.value))}
            className={inputClass}
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </Field>

        <Field id="hours-start" label="From">
          <input
            id="hours-start"
            type="time"
            required
            value={form.start_time}
            onChange={(event) => update('start_time', event.target.value)}
            className={inputClass}
          />
        </Field>

        <Field id="hours-end" label="To">
          <input
            id="hours-end"
            type="time"
            required
            value={form.end_time}
            onChange={(event) => update('end_time', event.target.value)}
            className={inputClass}
          />
        </Field>

        <Field id="hours-slot" label="Slot length">
          <select
            id="hours-slot"
            value={form.slot_minutes}
            onChange={(event) => update('slot_minutes', Number(event.target.value))}
            className={inputClass}
          >
            {SLOT_CHOICES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} minutes
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4">
        <Field id="hours-location" label="Where" optional>
          <input
            id="hours-location"
            type="text"
            value={form.location}
            onChange={(event) => update('location', event.target.value)}
            placeholder="Faculty Room 204, or a meeting link"
            className={inputClass}
          />
          <p className="mt-1.5 text-xs text-ink-400">
            Filled in automatically on any session booked from these hours.
          </p>
        </Field>
      </div>

      <div className="mt-4 rounded-lg bg-ink-50 px-4 py-3 text-sm">
        {valid ? (
          <p className="font-semibold text-ink-700">
            Every {weekdayLabel(Number(form.weekday))} this publishes{' '}
            <span className="font-bold text-brand-700">{preview} slots</span> of{' '}
            {form.slot_minutes} minutes, from {formatClock(form.start_time)} to{' '}
            {formatClock(form.end_time)}.
          </p>
        ) : (
          <p className="font-semibold text-rose-700">
            {form.end_time <= form.start_time
              ? 'The end time has to be after the start time.'
              : `That block is too short for a ${form.slot_minutes}-minute slot.`}
          </p>
        )}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || submitting}
          className="flex items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Publishing...
            </>
          ) : (
            'Publish hours'
          )}
        </button>
      </div>
    </form>
  );
}

function EmptyHours({ onAdd, showButton }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-white px-6 py-14 text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-brand-50">
        <CalendarClock className="h-8 w-8 text-brand-600" aria-hidden="true" />
      </span>
      <p className="mt-4 text-lg font-bold tracking-tight text-ink-900">
        No consultation hours yet
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-500">
        Until you publish some, students pick any time they like and you answer one request at a
        time. Publish a block and they can only ask for slots you are actually free for.
      </p>
      {showButton ? (
        <button
          type="button"
          onClick={onAdd}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-800"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Publish your first block
        </button>
      ) : null}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] font-medium text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';

function Field({ id, label, optional = false, children }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
      >
        {label}
        {optional ? <span className="font-medium normal-case text-ink-400">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}
