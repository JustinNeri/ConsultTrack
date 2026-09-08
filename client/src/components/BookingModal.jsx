import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Clock,
  FileText,
  Loader2,
  MapPin,
  UploadCloud,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';

const MAX_ATTACHMENTS = 5;

export default function BookingModal({ token, defaultGroupName, onClose, onCreated }) {
  const [form, setForm] = useState({
    date: '',
    time: '',
    topic: '',
    location: '',
    groupName: defaultGroupName ?? '',
  });
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
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const canSubmit = form.date && form.time && form.topic.trim() && !submitting;

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
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
      >
        {/* ---------------------------------------------------------- header */}
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <h2 id="booking-title" className="text-lg font-semibold text-slate-900">
              Book a consultation
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              Reserve a slot with your adviser and set the agenda ahead of time.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5" noValidate>
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
            <p className="mb-2 text-sm font-medium text-slate-700">
              Attachments <span className="font-normal text-slate-400">(optional)</span>
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
                  ? 'border-rose-800 bg-rose-50'
                  : 'border-slate-300 bg-slate-50 hover:border-rose-300 hover:bg-rose-50/40'
              }`}
            >
              <UploadCloud
                className={`h-8 w-8 ${dragging ? 'text-rose-800' : 'text-slate-400'}`}
                aria-hidden="true"
              />
              <p className="mt-2 text-sm font-medium text-slate-700">
                Drop files here, or <span className="text-rose-800">browse</span>
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
                    className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
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
              className="mt-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800"
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
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="flex items-center justify-center gap-2 rounded-xl bg-rose-800 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-800/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
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
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-800/20';

function Field({ id, label, icon: Icon, className = '', optional = false, children }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" />
        {label}
        {optional ? <span className="font-normal text-slate-400">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}
