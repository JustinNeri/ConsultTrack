import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CalendarClock, CalendarDays, Clock, Loader2, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { slotTimeFormatter, toDateInput, upcomingDatesFor } from '../lib/schedule.js';
import SlotPicker from './SlotPicker.jsx';

const currentFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Offering a different time.
 *
 * On a pending request this is the adviser's counter-offer to a student who
 * asked for a slot they cannot make; on a booked session it is either side
 * asking to move it. Both land in the same place: the *other* party has to
 * accept before anything actually moves.
 *
 * The times come from the adviser's own published hours, so a counter-offer is
 * guaranteed to be one they are free for. An adviser who has published no hours
 * falls back to typing a date and time, exactly as the booking form does.
 */
export default function ProposeTimeModal({
  token,
  consultation,
  isAdviser,
  onClose,
  onProposed,
}) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [weekdays, setWeekdays] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [timezone, setTimezone] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const dialogRef = useRef(null);
  const adviserId = consultation.adviser_id;

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /* The adviser's diary. Also the probe for whether they publish hours at all. */
  useEffect(() => {
    if (!adviserId) {
      setWeekdays([]);
      setSlotsLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const on = date || toDateInput(new Date());

    setSlotsLoading(true);
    api(`/advisers/${adviserId}/slots?date=${on}`, { token, signal: controller.signal })
      .then((result) => {
        setWeekdays(result.weekdays ?? []);
        setSlots(result.slots ?? []);
        setTimezone(result.timezone ?? null);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          // Falling back to free-form beats blocking the move entirely.
          setWeekdays([]);
        }
      })
      .finally(() => setSlotsLoading(false));

    return () => controller.abort();
  }, [adviserId, date, token]);

  useEffect(() => {
    setSelectedSlot(null);
  }, [date]);

  const slotMode = Array.isArray(weekdays) && weekdays.length > 0;
  const dateChips = useMemo(
    () => (slotMode ? upcomingDatesFor(weekdays, 8) : []),
    [slotMode, weekdays],
  );

  // Open on the adviser's first free day rather than an empty panel.
  useEffect(() => {
    if (slotMode && !date && dateChips.length) setDate(toDateInput(dateChips[0]));
  }, [date, dateChips, slotMode]);

  const formatSlot = useMemo(() => slotTimeFormatter(timezone), [timezone]);
  const openSlots = slots.filter((slot) => !slot.taken).length;

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    let iso;
    if (slotMode) {
      if (!selectedSlot) {
        setError('Pick one of the open slots.');
        return;
      }
      iso = selectedSlot;
    } else {
      const when = new Date(`${date}T${time}`);
      if (Number.isNaN(when.getTime())) {
        setError('Pick a valid date and time.');
        return;
      }
      if (when.getTime() <= Date.now()) {
        setError('Propose a time in the future.');
        return;
      }
      iso = when.toISOString();
    }

    setSubmitting(true);
    setError('');
    try {
      const result = await api(`/consultations/${consultation.id}/propose`, {
        method: 'POST',
        token,
        body: { meeting_date: iso, note: note.trim() || null },
      });
      onProposed(result.consultation);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const chosen = slotMode ? Boolean(selectedSlot) : Boolean(date && time);
  const wasRequest = consultation.status === 'pending';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (!dialogRef.current?.contains(event.target)) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="propose-title"
        className="scrollbar-slim max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white shadow-lift sm:rounded-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink-100 bg-white/95 px-6 py-5 backdrop-blur">
          <div className="flex gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gold-500 text-white shadow-lg shadow-gold-700/25">
              <CalendarClock className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="propose-title" className="text-lg font-bold tracking-tight text-ink-900">
                {wasRequest ? 'Offer another time' : 'Ask to move this session'}
              </h2>
              <p className="mt-0.5 text-sm text-ink-500">
                {wasRequest
                  ? 'The group still has to accept it — they picked their time around their classes.'
                  : 'Nothing moves until the other side accepts.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5" noValidate>
          {/* What is being replaced. */}
          <div className="mb-4 rounded-lg bg-ink-50 px-3.5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
              {wasRequest ? 'They asked for' : 'Currently booked for'}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-ink-800">
              <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
              {currentFormatter.format(new Date(consultation.meeting_date))}
            </p>
          </div>

          {slotMode ? (
            <SlotPicker
              title="Offer instead"
              dateChips={dateChips}
              selectedDate={date}
              onSelectDate={setDate}
              slots={slots}
              slotsLoading={slotsLoading}
              selectedSlot={selectedSlot}
              onSelectSlot={setSelectedSlot}
              formatSlot={formatSlot}
              openSlots={openSlots}
              timezone={timezone}
            />
          ) : (
            <>
              {isAdviser ? (
                <p className="mb-3 flex items-start gap-2 rounded-lg bg-gold-50 px-3.5 py-3 text-xs font-medium text-gold-700">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  You have not published consultation hours, so pick a time by hand. Publishing
                  them would let students book straight into slots that already work for you.
                </p>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="propose-date"
                    className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
                  >
                    <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                    Date
                  </label>
                  <input
                    id="propose-date"
                    type="date"
                    required
                    value={date}
                    min={toDateInput(new Date())}
                    onChange={(event) => setDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label
                    htmlFor="propose-time"
                    className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
                  >
                    <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                    Time
                  </label>
                  <input
                    id="propose-time"
                    type="time"
                    required
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    className={inputClass}
                  />
                </div>
              </div>
            </>
          )}

          <div className="mt-4">
            <label
              htmlFor="propose-note"
              className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
            >
              Why the change
              <span className="font-medium normal-case text-ink-400">(optional)</span>
            </label>
            <textarea
              id="propose-note"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                isAdviser
                  ? 'I have a class at 9. Would noon work?'
                  : 'We have a class then — could we do the afternoon?'
              }
              className={`${inputClass} resize-none`}
            />
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

          <p className="mt-4 rounded-lg bg-ink-50 px-4 py-3 text-xs leading-relaxed text-ink-600">
            The slot is held for them until they answer, or until the proposed time passes.
            {wasRequest
              ? ' If they cannot make it, the request closes and they book again from your open slots.'
              : ' If they say no, the current time stands.'}
          </p>

          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-200 px-4 py-3 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!chosen || submitting}
              className="flex items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Sending...
                </>
              ) : (
                'Send the offer'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';
