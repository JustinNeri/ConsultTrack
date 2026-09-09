import { CalendarDays, CalendarX2, CheckCircle2, Clock, MapPin, Timer } from 'lucide-react';
import { toDateInput } from '../lib/schedule.js';

const chipDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const longDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

/**
 * An adviser's published hours, as something to click.
 *
 * A row of the dates they actually hold hours on, then that day's slots. Taken
 * slots stay on screen rather than disappearing: a student who cannot get
 * Wednesday at 2 can see the reason is another group, not a bug.
 *
 * Purely presentational -- whoever renders it owns the fetching. That is what
 * lets a student book out of it and an adviser counter-offer out of their own
 * diary with the same component.
 */
export default function SlotPicker({
  dateChips,
  selectedDate,
  onSelectDate,
  slots,
  slotsLoading,
  selectedSlot,
  onSelectSlot,
  formatSlot,
  openSlots,
  timezone,
  title = 'Pick a slot',
  tone = 'brand',
}) {
  const shell =
    tone === 'brand' ? 'border-brand-100 bg-brand-50/40' : 'border-ink-200 bg-ink-50';

  return (
    <div className={`rounded-xl border p-4 ${shell}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-brand-800">
          <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
          {title}
        </p>
        {!slotsLoading && slots.length > 0 ? (
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              openSlots > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-ink-200 text-ink-600'
            }`}
          >
            {openSlots} open
          </span>
        ) : null}
      </div>

      {/* ------------------------------------------------------ date chips */}
      <div className="scrollbar-slim -mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
        {dateChips.map((date) => {
          const value = toDateInput(date);
          const active = value === selectedDate;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onSelectDate(value)}
              aria-pressed={active}
              className={`shrink-0 rounded-lg px-3.5 py-2 text-xs font-semibold transition ${
                active
                  ? 'bg-brand-700 text-white '
                  : 'bg-white text-ink-600 ring-1 ring-ink-200 hover:ring-brand-300'
              }`}
            >
              {chipDateFormatter.format(date)}
            </button>
          );
        })}
      </div>

      {/* ----------------------------------------------------------- slots */}
      <div className="mt-3">
        {slotsLoading ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <div key={key} className="skeleton h-10 rounded-lg" />
            ))}
          </div>
        ) : slots.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-300 bg-white px-4 py-8 text-center">
            <CalendarX2 className="mx-auto h-7 w-7 text-ink-300" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-ink-800">
              Nothing left on{' '}
              {selectedDate
                ? longDateFormatter.format(new Date(`${selectedDate}T00:00`))
                : 'that day'}
            </p>
            <p className="mt-0.5 text-xs text-ink-500">Try one of the other dates above.</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {slots.map((slot) => {
                const active = selectedSlot === slot.slot_start;
                return (
                  <button
                    key={slot.slot_start}
                    type="button"
                    disabled={slot.taken}
                    onClick={() => onSelectSlot(slot.slot_start)}
                    aria-pressed={active}
                    title={slot.taken ? 'Already booked' : slot.location || undefined}
                    className={`rounded-lg px-2 py-2.5 text-xs font-semibold transition ${
                      slot.taken
                        ? 'cursor-not-allowed bg-ink-100 text-ink-400 line-through'
                        : active
                          ? 'bg-brand-700 text-white '
                          : 'bg-white text-ink-700 ring-1 ring-ink-200 hover:bg-brand-50 hover:ring-brand-400'
                    }`}
                  >
                    {formatSlot.format(new Date(slot.slot_start))}
                  </button>
                );
              })}
            </div>

            {selectedSlot ? (
              <SelectedSlotSummary
                slot={slots.find((item) => item.slot_start === selectedSlot)}
                formatSlot={formatSlot}
              />
            ) : (
              <p className="mt-3 text-xs font-medium text-ink-500">
                Struck-out times are already taken.
                {timezone ? ` Times are ${timezone.split('/').pop().replace('_', ' ')} time.` : ''}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SelectedSlotSummary({ slot, formatSlot }) {
  if (!slot) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg bg-white px-3.5 py-3 text-xs font-semibold text-ink-700 ring-1 ring-emerald-200">
      <span className="flex items-center gap-1.5 text-emerald-700">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        {longDateFormatter.format(new Date(slot.slot_start))}
      </span>
      <span className="flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
        {formatSlot.format(new Date(slot.slot_start))} -{' '}
        {formatSlot.format(new Date(slot.slot_end))}
      </span>
      <span className="flex items-center gap-1.5">
        <Timer className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
        {slot.slot_minutes} min
      </span>
      {slot.location ? (
        <span className="flex items-center gap-1.5 truncate">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-400" aria-hidden="true" />
          {slot.location}
        </span>
      ) : null}
    </div>
  );
}
