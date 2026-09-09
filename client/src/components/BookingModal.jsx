import { useEffect, useRef, useState } from 'react';
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

const MAX_ATTACHMENTS = 5;

export default function BookingModal({ token, role, defaultGroupName, onClose, onCreated }) {
  // An adviser books for themselves, so they pick no adviser and the server
  // fills in their own id.
  const isAdviser = role === 'adviser';

  const [form, setForm] = useState({
    date: '',
    time: '',
    topic: '',
    location: '',
    groupName: defaultGroupName ?? '',
    adviserId: '',
  });
  const [advisers, setAdvisers] = useState([]);
  const [advisersLoading, setAdvisersLoading] = useState(!isAdviser);
  // The department the directory was filtered by, as the server reports it.
  const [adviserDepartment, setAdviserDepartment] = useState(null);
  const [files, setFiles] = useState([]);
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

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  /* ------------------------------------------------------ file drop zone -- */
  function addFiles(incoming) {
    const accepted = Array.from(incoming).slice(0, MAX_ATTACHMENTS - files.length);
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
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

    const meetingDate = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(meetingDate.getTime())) {
      setError('Pick a valid date and time.');
      return;
    }
    if (meetingDate.getTime() < Date.now()) {
      setError('Choose a date and time in the future.');
      return;
    }

    setSubmitting(true);
    try {
      await api('/consultations', {
        method: 'POST',
        token,
        body: {
          topic: form.topic.trim(),
          location: form.location.trim() || null,
          meeting_date: meetingDate.toISOString(),
          ...(form.groupName.trim() ? { group_name: form.groupName.trim() } : {}),
          ...(isAdviser ? {} : { adviser_id: form.adviserId }),
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const canSubmit =
    form.date &&
    form.time &&
    form.topic.trim() &&
    form.groupName.trim() &&
    (isAdviser || form.adviserId) &&
    !submitting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (!dialogRef.current?.contains(event.target)) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-title"
        className="scrollbar-slim max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white shadow-lift sm:rounded-3xl"
      >
        {/* ---------------------------------------------------------- header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="flex gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-700 to-brand-900 text-white">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 id="booking-title" className="text-lg font-extrabold tracking-tight text-slate-900">
                {isAdviser ? 'Schedule a consultation' : 'Book a consultation'}
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">
                {isAdviser
                  ? 'Set a session for one of your thesis groups and share the agenda.'
                  : 'Reserve a slot with your adviser and set the agenda ahead of time.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-xl p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
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
                onChange={(event) => updateField('adviserId', event.target.value)}
                className={`${inputClass} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
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
                <p className="mt-1.5 text-xs text-slate-400">
                  {adviserDepartment
                    ? `No adviser from ${adviserDepartment} has registered yet.`
                    : 'Ask your adviser to register with their @hau.edu.ph address first.'}
                </p>
              ) : !advisersLoading && adviserDepartment ? (
                <p className="mt-1.5 text-xs text-slate-400">
                  Showing advisers from {adviserDepartment}.
                </p>
              ) : null}
            </Field>
          ) : null}

          <Field id="booking-group" label="Thesis group" icon={Users} className="mb-4">
            <input
              id="booking-group"
              type="text"
              required
              value={form.groupName}
              onChange={(event) => updateField('groupName', event.target.value)}
              placeholder="Group 7 - ConsultTrack"
              className={inputClass}
            />
          </Field>

          {/* ------------------------------------------------- date and time */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="booking-date" label="Date" icon={CalendarDays}>
              <input
                ref={firstFieldRef}
                id="booking-date"
                type="date"
                required
                value={form.date}
                min={new Date().toISOString().slice(0, 10)}
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
            <p className="mt-1 text-right text-xs text-slate-400">{form.topic.length}/500</p>
          </Field>

          {/* --------------------------------------------------- location --- */}
          <Field id="booking-location" label="Location" icon={MapPin} className="mt-2" optional>
            <input
              id="booking-location"
              type="text"
              value={form.location}
              onChange={(event) => updateField('location', event.target.value)}
              placeholder="Faculty Room 204, or a meeting link"
              className={inputClass}
            />
          </Field>

          {/* ----------------------------------------------- attachments UI - */}
          <div className="mt-5">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600">
              Attachments <span className="font-medium normal-case text-slate-400">(optional)</span>
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
              className={`flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
                dragging
                  ? 'border-brand-600 bg-brand-50'
                  : 'border-slate-200 bg-slate-50 hover:border-brand-300 hover:bg-brand-50/40'
              }`}
            >
              <UploadCloud
                className={`h-8 w-8 ${dragging ? 'text-brand-700' : 'text-slate-400'}`}
                aria-hidden="true"
              />
              <p className="mt-2 text-sm font-semibold text-slate-700">
                Drop files here, or <span className="text-brand-700">browse</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                PDF, DOCX or images - up to {MAX_ATTACHMENTS} files
              </p>
            </button>

            <input
              ref={fileInputRef}
              type="file"
              multiple
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
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"
                  >
                    <span className="truncate text-slate-700">{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                      aria-label={`Remove ${file.name}`}
                      className="ml-3 shrink-0 rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="mt-2 text-xs text-slate-400">
              Interface only for now - files are listed here but not uploaded with the booking.
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
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
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-700 to-brand-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-brand-900/20 transition hover:from-brand-800 hover:to-brand-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Booking...
                </>
              ) : (
                'Confirm booking'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10';

function Field({ id, label, icon: Icon, className = '', optional = false, children }) {
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600"
      >
        <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
        {label}
        {optional ? (
          <span className="font-medium normal-case text-slate-400">(optional)</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}
