import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Clock,
  FileText,
  Loader2,
  MapPin,
  UploadCloud,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { slotTimeFormatter, toDateInput, upcomingDatesFor } from '../lib/schedule.js';
import SlotPicker from './SlotPicker.jsx';

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * What the bucket accepts, mirrored from the API so a file is refused here --
 * with a reason, before anything is uploaded -- rather than after a round trip.
 */
const ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

const ATTACHMENT_ACCEPT =
  '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.txt';

/** "2.4 MB", "812 KB". */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BookingModal({ token, role, group, defaultGroupName, onClose, onCreated }) {
  // An adviser books for themselves, so they pick no adviser and the server
  // fills in their own id. They also skip the slot picker: consultation hours
  // exist to tell students when to ask, and an adviser is not asking anyone.
  const isAdviser = role === 'adviser';

  const [form, setForm] = useState({
    date: '',
    time: '',
    topic: '',
    location: '',
    // An adviser still types or picks a group; a student's is their membership
    // and cannot be typed over.
    groupName: group?.name ?? defaultGroupName ?? '',
    groupId: group?.id ?? '',
    adviserId: '',
  });
  const [advisers, setAdvisers] = useState([]);
  const [advisersLoading, setAdvisersLoading] = useState(!isAdviser);
  // The department the directory was filtered by, as the server reports it.
  const [adviserDepartment, setAdviserDepartment] = useState(null);

  /* --------------------------------------------------- consultation hours */
  // `weekdays` is null until the first slot fetch answers. Empty means the
  // adviser publishes no hours, which is what drops the form back to a plain
  // date-and-time entry.
  const [weekdays, setWeekdays] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [timezone, setTimezone] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  // Bumped to force a re-read of the day after the server rejects a slot.
  const [slotsVersion, setSlotsVersion] = useState(0);

  const [files, setFiles] = useState([]);
  // For an adviser: the groups in their department, plus any they already
  // advise. Not just the latter -- a group's first session is by definition
  // with an adviser who has never advised it.
  const [advisedGroups, setAdvisedGroups] = useState([]);
  // Which file is going up, so the button can say so instead of hanging.
  const [uploading, setUploading] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const dialogRef = useRef(null);
  const firstFieldRef = useRef(null);
  const fileInputRef = useRef(null);

  /* --------------------------------------- escape to close + scroll lock -- */
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstFieldRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /* ------------------------------------------------- adviser directory --- */
  useEffect(() => {
    if (isAdviser) return undefined;

    const controller = new AbortController();
    api('/advisers', { token, signal: controller.signal })
      .then((result) => {
        setAdvisers(result.advisers ?? []);
        setAdviserDepartment(result.scoped ? result.department : null);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => setAdvisersLoading(false));

    return () => controller.abort();
  }, [isAdviser, token]);

  /*
   * The slot fetch, which doubles as the "does this adviser publish hours?"
   * probe -- the response carries `weekdays` whether or not the date asked for
   * has any slots. It re-runs on every adviser or date change, so a slot taken
   * by another group between opening the form and submitting it shows up as
   * taken the next time the student touches the date.
   */
  useEffect(() => {
    if (isAdviser || !form.adviserId) {
      setWeekdays(null);
      setSlots([]);
      return undefined;
    }

    const controller = new AbortController();
    const date = form.date || toDateInput(new Date());

    setSlotsLoading(true);
    api(`/advisers/${form.adviserId}/slots?date=${date}`, { token, signal: controller.signal })
      .then((result) => {
        setWeekdays(result.weekdays ?? []);
        setSlots(result.slots ?? []);
        setTimezone(result.timezone ?? null);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setError(err.message);
          setWeekdays([]);
        }
      })
      .finally(() => setSlotsLoading(false));

    return () => controller.abort();
  }, [form.adviserId, form.date, isAdviser, slotsVersion, token]);

  /* A slot only belongs to the date it was fetched for. */
  useEffect(() => {
    setSelectedSlot(null);
  }, [form.adviserId, form.date]);

  // Slot mode is on only when this adviser actually published something.
  const slotMode = !isAdviser && Array.isArray(weekdays) && weekdays.length > 0;

  const dateChips = useMemo(
    () => (slotMode ? upcomingDatesFor(weekdays, 8) : []),
    [slotMode, weekdays],
  );

  // Pick the first day the adviser holds hours, so the picker opens with slots
  // on screen rather than an empty panel and a date field to work out.
  useEffect(() => {
    if (slotMode && !form.date && dateChips.length) {
      setForm((prev) => ({ ...prev, date: toDateInput(dateChips[0]) }));
    }
  }, [dateChips, form.date, slotMode]);

  const formatSlot = useMemo(() => slotTimeFormatter(timezone), [timezone]);
  const openSlots = slots.filter((slot) => !slot.taken).length;

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  /* The groups an adviser may book with. A student's group is fixed. */
  useEffect(() => {
    if (!isAdviser) return undefined;
    const controller = new AbortController();
    api('/thesis-groups/bookable', { token, signal: controller.signal })
      .then((result) => setAdvisedGroups(result.groups ?? []))
      // Booking still works by typing a name, so this stays quiet.
      .catch(() => {});
    return () => controller.abort();
  }, [isAdviser, token]);

  /* ------------------------------------------------------ file drop zone -- */
  function addFiles(incoming) {
    const room = MAX_ATTACHMENTS - files.length;
    if (room <= 0) {
      setError(`You can attach ${MAX_ATTACHMENTS} files.`);
      return;
    }

    const accepted = [];
    const rejected = [];
    for (const file of Array.from(incoming).slice(0, room)) {
      if (!ATTACHMENT_TYPES.has(file.type)) {
        rejected.push(`${file.name} is not a supported file type`);
      } else if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${file.name} is over 10 MB`);
      } else {
        accepted.push(file);
      }
    }

    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
    setError(rejected.length ? rejected.join('. ') + '.' : '');
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  /* ------------------------------------------------------------- submit --- */
  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    setError('');

    // In slot mode the instant comes from the server, already aligned to the
    // adviser's block; free-form builds it from the two fields.
    let meetingIso;
    if (slotMode) {
      if (!selectedSlot) {
        setError('Pick one of the open slots.');
        return;
      }
      meetingIso = selectedSlot;
    } else {
      const meetingDate = new Date(`${form.date}T${form.time}`);
      if (Number.isNaN(meetingDate.getTime())) {
        setError('Pick a valid date and time.');
        return;
      }
      if (meetingDate.getTime() < Date.now()) {
        setError('Choose a date and time in the future.');
        return;
      }
      meetingIso = meetingDate.toISOString();
    }

    setSubmitting(true);
    try {
      const result = await api('/consultations', {
        method: 'POST',
        token,
        body: {
          topic: form.topic.trim(),
          location: form.location.trim() || null,
          meeting_date: meetingIso,
          // A registered group travels by id, so membership decides who sees
          // the session. The name is a fallback for groups that predate this.
          ...(form.groupId
            ? { group_id: form.groupId }
            : form.groupName.trim()
              ? { group_name: form.groupName.trim() }
              : {}),
          ...(isAdviser ? {} : { adviser_id: form.adviserId }),
        },
      });
      const consultation = result.consultation ?? null;

      /*
       * Files go up after the booking, because until it exists there is nothing
       * to hang them off -- the storage path is keyed by consultation id.
       *
       * A failure here does not fail the booking: the session is already real
       * and re-submitting the form would double-book it. The group is told what
       * did not arrive and can send it in the consultation thread instead.
       */
      if (consultation?.id && files.length > 0) {
        const failed = [];
        for (const file of files) {
          setUploading(file.name);
          try {
            await api(
              `/consultations/${consultation.id}/attachments` +
                `?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`,
              { method: 'POST', token, raw: file },
            );
          } catch (uploadError) {
            failed.push(`${file.name} (${uploadError.message})`);
          }
        }
        setUploading(null);

        if (failed.length) {
          onCreated(consultation, {
            warning: `Booked, but these files did not upload: ${failed.join(', ')}.`,
          });
          return;
        }
      }

      // A student's booking comes back 'pending' -- the dashboard says so rather
      // than pretending the session is on the books.
      onCreated(consultation);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
      // 409 means the diary moved under us: somebody took the slot, or the time
      // fell outside the published hours. Re-read the day so the grid is honest.
      if (err.status === 409 && slotMode) {
        setSelectedSlot(null);
        setSlotsVersion((version) => version + 1);
      }
    }
  }

  const timingChosen = slotMode ? Boolean(selectedSlot) : Boolean(form.date && form.time);
  const canSubmit =
    timingChosen &&
    form.topic.trim() &&
    (form.groupId || form.groupName.trim()) &&
    (isAdviser || form.adviserId) &&
    !submitting;

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
        aria-labelledby="booking-title"
        className="scrollbar-slim max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white shadow-lift sm:rounded-2xl"
      >
        {/* ---------------------------------------------------------- header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink-100 bg-white/95 px-6 py-5 backdrop-blur">
          <div className="flex gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white ">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2
                id="booking-title"
                className="text-lg font-bold tracking-tight text-ink-900"
              >
                {isAdviser ? 'Schedule a consultation' : 'Request a consultation'}
              </h2>
              <p className="mt-0.5 text-sm text-ink-500">
                {isAdviser
                  ? 'Set a session for one of your thesis groups and share the agenda.'
                  : slotMode
                    ? "Pick an open slot from your adviser's consultation hours."
                    : 'Your adviser has to approve the slot before it becomes official.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5" noValidate>
          {/* ------------------------------------------------------ who/what */}
          {!isAdviser ? (
            <Field id="booking-adviser" label="Adviser" icon={UserRound} className="mb-4">
              <select
                id="booking-adviser"
                required
                disabled={advisersLoading || advisers.length === 0}
                value={form.adviserId}
                onChange={(event) =>
                  // A new adviser keeps a different diary, so the date resets
                  // and the picker re-opens on their first free day.
                  setForm((prev) => ({ ...prev, adviserId: event.target.value, date: '' }))
                }
                className={`${inputClass} disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-400`}
              >
                <option value="">
                  {advisersLoading
                    ? 'Loading advisers...'
                    : advisers.length === 0
                      ? 'No advisers registered yet'
                      : 'Select your adviser'}
                </option>
                {/* The list is already only your department, so the rank is the
                    useful thing to show next to the name. */}
                {advisers.map((adviser) => (
                  <option key={adviser.id} value={adviser.id}>
                    {adviser.full_name}
                    {adviser.faculty_position ? ` - ${adviser.faculty_position}` : ''}
                  </option>
                ))}
              </select>
              {!advisersLoading && advisers.length === 0 ? (
                <p className="mt-1.5 text-xs text-ink-400">
                  {adviserDepartment
                    ? `No adviser from ${adviserDepartment} has registered yet.`
                    : 'Ask your adviser to register with their @hau.edu.ph address first.'}
                </p>
              ) : !advisersLoading && adviserDepartment ? (
                <p className="mt-1.5 text-xs text-ink-400">
                  Showing advisers from {adviserDepartment}.
                </p>
              ) : null}
            </Field>
          ) : null}

          <Field id="booking-group" label="Thesis group" icon={Users} className="mb-4">
            {!isAdviser ? (
              /*
               * Read-only for a student. The group is their membership, and
               * typing another one would book a session their own group could
               * not see -- which is the failure groups exist to prevent.
               */
              <div className="rounded-lg border border-ink-200 bg-ink-50 px-3.5 py-2.5">
                <p className="text-[14px] font-medium text-ink-900">{form.groupName}</p>
                <p className="mt-0.5 text-[12px] text-ink-500">
                  Everyone in your group will see this consultation.
                </p>
              </div>
            ) : advisedGroups.length > 0 ? (
              <select
                id="booking-group"
                required
                value={form.groupId}
                onChange={(event) => {
                  const picked = advisedGroups.find((item) => item.id === event.target.value);
                  updateField('groupId', event.target.value);
                  updateField('groupName', picked?.name ?? '');
                }}
                className={inputClass}
              >
                <option value="">Select a group</option>
                {advisedGroups.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.section ? ` (${item.section})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="booking-group"
                type="text"
                required
                value={form.groupName}
                onChange={(event) => updateField('groupName', event.target.value)}
                placeholder="Group 7 - ConsultTrack"
                className={inputClass}
              />
            )}
          </Field>

          {/* --------------------------------------------- when: slots or free */}
          {slotMode ? (
            <SlotPicker
              dateChips={dateChips}
              selectedDate={form.date}
              onSelectDate={(value) => updateField('date', value)}
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
              {!isAdviser && form.adviserId && Array.isArray(weekdays) && weekdays.length === 0 ? (
                <p className="mb-4 flex items-start gap-2 rounded-lg bg-gold-50 px-3.5 py-3 text-xs font-medium text-gold-700">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  This adviser has not published consultation hours yet, so pick any time and they
                  will confirm or suggest another.
                </p>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="booking-date" label="Date" icon={CalendarDays}>
                  <input
                    ref={firstFieldRef}
                    id="booking-date"
                    type="date"
                    required
                    value={form.date}
                    min={toDateInput(new Date())}
                    onChange={(event) => updateField('date', event.target.value)}
                    className={inputClass}
                  />
                </Field>

                <Field id="booking-time" label="Time" icon={Clock}>
                  <input
                    id="booking-time"
                    type="time"
                    required
                    value={form.time}
                    onChange={(event) => updateField('time', event.target.value)}
                    className={inputClass}
                  />
                </Field>
              </div>
            </>
          )}

          {/* ----------------------------------------------------- agenda --- */}
          <Field
            id="booking-topic"
            label="Meeting agenda / topic"
            icon={FileText}
            className="mt-4"
          >
            <textarea
              id="booking-topic"
              required
              rows={3}
              maxLength={500}
              value={form.topic}
              onChange={(event) => updateField('topic', event.target.value)}
              placeholder="Chapter 4 results, revisions to the system flow, testing plan..."
              className={`${inputClass} resize-none`}
            />
            <p className="mt-1 text-right text-xs text-ink-400">{form.topic.length}/500</p>
          </Field>

          {/* --------------------------------------------------- location --- */}
          <Field id="booking-location" label="Location" icon={MapPin} className="mt-2" optional>
            <input
              id="booking-location"
              type="text"
              value={form.location}
              onChange={(event) => updateField('location', event.target.value)}
              placeholder={
                slotMode ? "Leave blank to use your adviser's room" : 'Faculty Room 204, or a meeting link'
              }
              className={inputClass}
            />
          </Field>

          {/* ----------------------------------------------- attachments UI - */}
          <div className="mt-5">
            <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
              Attachments <span className="font-medium normal-case text-ink-400">(optional)</span>
            </p>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-7 text-center transition ${
                dragging
                  ? 'border-brand-600 bg-brand-50'
                  : 'border-ink-200 bg-ink-50 hover:border-brand-300 hover:bg-brand-50/40'
              }`}
            >
              <UploadCloud
                className={`h-7 w-7 ${dragging ? 'text-brand-700' : 'text-ink-400'}`}
                aria-hidden="true"
              />
              <p className="mt-2 text-sm font-semibold text-ink-700">
                Drop files here, or <span className="text-brand-700">browse</span>
              </p>
              <p className="mt-0.5 text-xs text-ink-400">
                PDF, Word, PowerPoint, images or text - up to {MAX_ATTACHMENTS} files, 10 MB
                each
              </p>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />

            {files.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}-${index}`}
                    className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink-700">{file.name}</span>
                    <span className="tnum ml-3 shrink-0 text-xs text-ink-500">
                      {formatBytes(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                      aria-label={`Remove ${file.name}`}
                      className="ml-3 shrink-0 rounded p-1 text-ink-400 transition hover:bg-ink-200 hover:text-ink-700"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="mt-2 text-xs text-ink-400">
              Sent with the booking and visible to your adviser in the consultation thread.
            </p>
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

          {/* ---------------------------------------------------- actions --- */}
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-200 px-4 py-3 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center justify-center gap-2 rounded-lg bg-brand-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {/* A student is asking, not booking -- the adviser decides. */}
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {uploading
                    ? `Uploading ${uploading}...`
                    : isAdviser
                      ? 'Booking...'
                      : 'Sending...'}
                </>
              ) : isAdviser ? (
                'Confirm booking'
              ) : (
                'Send request'
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

function Field({ id, label, icon: Icon, className = '', optional = false, children }) {
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
      >
        <Icon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
        {label}
        {optional ? <span className="font-medium normal-case text-ink-400">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}
