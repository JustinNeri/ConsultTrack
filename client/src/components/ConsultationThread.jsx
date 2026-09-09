import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Clock,
  Download,
  Loader2,
  MapPin,
  MessageSquare,
  Paperclip,
  Send,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';

/** "2.4 MB", "812 KB". */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How often an open thread re-reads itself. */
const POLL_MS = 6000;

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const meetingFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * The conversation attached to one consultation.
 *
 * This is the reply channel a decline never had: `decline_reason` is a single
 * sentence with nowhere to answer it, so "I have a class then, try Thursday"
 * used to end the conversation instead of continuing it.
 *
 * Delivery is polling rather than Supabase Realtime on purpose. The client has
 * no Supabase wiring at all -- it only talks to this Express API, which reaches
 * Postgres as the owner, so RLS is defence in depth rather than the enforcement
 * point. Pushing live updates into the browser would make RLS load-bearing and
 * is a separate piece of work; a six-second poll needs neither.
 */
export default function ConsultationThread({
  token,
  consultationId,
  profile,
  onClose,
  onReadChanged,
}) {
  const [consultation, setConsultation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  // Files sent with the booking. Fetched once: unlike messages they do not
  // change while a thread is open, so the poll leaves them alone.
  const [attachments, setAttachments] = useState([]);
  const [openingFile, setOpeningFile] = useState(null);

  const endRef = useRef(null);
  const composerRef = useRef(null);
  // Suppresses the "jump to newest" scroll when a poll changes nothing.
  const lastMessageId = useRef(null);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      try {
        const result = await api(`/consultations/${consultationId}/messages`, { token });
        setConsultation(result.consultation);
        setMessages(result.messages ?? []);
        setError('');
        // Opening or polling a thread clears its unread count server-side, so
        // the dashboard badge has to be told.
        onReadChanged?.();
      } catch (err) {
        if (!silent) setError(err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [consultationId, onReadChanged, token],
  );

  useEffect(() => {
    load();
  }, [load]);

  /* The attachment listing, read once when the thread opens. */
  useEffect(() => {
    const controller = new AbortController();
    api(`/consultations/${consultationId}/attachments`, { token, signal: controller.signal })
      .then((result) => setAttachments(result.attachments ?? []))
      // A thread is still usable without its file list, so this stays quiet.
      .catch(() => {});
    return () => controller.abort();
  }, [consultationId, token]);

  /**
   * Opens one attachment.
   *
   * The bucket is private, so the API mints a signed URL good for two minutes
   * and the browser follows it. Nothing is downloaded through this origin.
   */
  async function openAttachment(attachment) {
    if (openingFile) return;
    setOpeningFile(attachment.id);
    try {
      const result = await api(`/attachments/${attachment.id}/url`, { token });
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    } finally {
      setOpeningFile(null);
    }
  }

  /* A thread left open keeps up with the other side. */
  useEffect(() => {
    const timer = setInterval(() => load({ silent: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  /* Escape closes, and the composer takes focus on open. */
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    composerRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  /* Only scroll when something actually arrived. */
  useEffect(() => {
    const newest = messages[messages.length - 1]?.id ?? null;
    if (newest !== lastMessageId.current) {
      lastMessageId.current = newest;
      endRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  async function send(event) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError('');
    try {
      const result = await api(`/consultations/${consultationId}/messages`, {
        method: 'POST',
        token,
        body: { body },
      });
      // Merge by id: a poll may already have brought this message back.
      setMessages((prev) =>
        prev.some((item) => item.id === result.message.id) ? prev : [...prev, result.message],
      );
      setDraft('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    // Enter sends, Shift+Enter breaks the line -- the chat convention.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  // Messages grouped under a date heading, so a thread spanning weeks reads.
  const days = useMemo(() => {
    const groups = [];
    for (const message of messages) {
      const key = new Date(message.created_at).toDateString();
      const last = groups[groups.length - 1];
      if (last?.key === key) last.messages.push(message);
      else groups.push({ key, date: new Date(message.created_at), messages: [message] });
    }
    return groups;
  }, [messages]);

  const meeting = consultation ? new Date(consultation.meeting_date) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink-900/50 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Consultation messages"
        className="flex h-full w-full max-w-lg flex-col bg-ink-50 shadow-lift"
      >
        {/* ---------------------------------------------------------- header */}
        <header className="flex items-start gap-3 border-b border-ink-200 bg-white px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-700 text-white">
            <MessageSquare className="h-5 w-5" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            {loading && !consultation ? (
              <div className="skeleton h-9 w-48 rounded-lg" />
            ) : (
              <>
                <p className="truncate font-bold tracking-tight text-ink-900">
                  {consultation?.topic ?? 'Consultation'}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-medium text-ink-500">
                  {consultation?.group_name ? <span>{consultation.group_name}</span> : null}
                  {meeting ? (
                    <span className="flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" aria-hidden="true" />
                      {meetingFormatter.format(meeting)}
                    </span>
                  ) : null}
                  {consultation?.location ? (
                    <span className="flex items-center gap-1 truncate">
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {consultation.location}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close messages"
            className="shrink-0 rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        {/* The adviser's decline note is the first thing said in the thread, so
            it belongs in the thread rather than only on the card behind it. */}
        {consultation?.status === 'declined' && consultation.decline_reason ? (
          <div className="border-b border-rose-100 bg-rose-50 px-5 py-3 text-sm text-rose-800">
            <span className="font-bold">Declined: </span>
            {consultation.decline_reason}
          </div>
        ) : null}

        {/* ----------------------------------------------------- attachments */}
        {attachments.length > 0 ? (
          <div className="border-b border-ink-200 bg-white px-5 py-3">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
              <Paperclip className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
              {attachments.length} {attachments.length === 1 ? 'file' : 'files'} sent with this
              booking
            </p>
            <ul className="mt-2 space-y-1.5">
              {attachments.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => openAttachment(file)}
                    disabled={openingFile === file.id}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-ink-200 px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50/50 disabled:opacity-60"
                  >
                    {openingFile === file.id ? (
                      <Loader2
                        className="h-4 w-4 shrink-0 animate-spin text-brand-700"
                        aria-hidden="true"
                      />
                    ) : (
                      <Download className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-900">{file.file_name}</span>
                      <span className="block truncate text-xs text-ink-500">
                        {formatBytes(file.byte_size)}
                        {file.uploaded_by_name ? ` \u00b7 ${file.uploaded_by_name}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* -------------------------------------------------------- messages */}
        <div className="scrollbar-slim flex-1 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((key) => (
                <div key={key} className="skeleton h-14 rounded-xl" />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <EmptyThread />
          ) : (
            days.map((day) => (
              <section key={day.key}>
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-ink-200" aria-hidden="true" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                    {dayFormatter.format(day.date)}
                  </span>
                  <span className="h-px flex-1 bg-ink-200" aria-hidden="true" />
                </div>

                <ul className="space-y-2.5">
                  {day.messages.map((message) => (
                    <Bubble
                      key={message.id}
                      message={message}
                      mine={message.sender_id === profile.id}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
          <div ref={endRef} />
        </div>

        {/* -------------------------------------------------------- composer */}
        <form onSubmit={send} className="border-t border-ink-200 bg-white px-5 py-4">
          {error ? (
            <p
              role="alert"
              className="mb-2.5 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          <div className="flex items-end gap-2">
            <label htmlFor="thread-composer" className="sr-only">
              Write a message
            </label>
            <textarea
              ref={composerRef}
              id="thread-composer"
              rows={1}
              value={draft}
              maxLength={2000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write a message..."
              className="scrollbar-slim max-h-32 min-h-11 flex-1 resize-none rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              aria-label="Send message"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-white transition hover:bg-brand-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-400">
            Enter sends, Shift+Enter starts a new line.
          </p>
        </form>
      </aside>
    </div>
  );
}

function Bubble({ message, mine }) {
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
        {!mine ? (
          <p className="mb-1 px-1 text-[11px] font-semibold text-ink-500">
            {message.sender_name || 'Someone'}
            {message.sender_role === 'adviser' ? (
              <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-700">
                Adviser
              </span>
            ) : null}
          </p>
        ) : null}

        <div
          className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
            mine
              ? 'rounded-br-md bg-brand-700 text-white'
              : 'rounded-bl-md bg-white text-ink-800 ring-1 ring-ink-200'
          }`}
        >
          {/* Newlines are meaningful in a chat message. */}
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </div>

        <p className="mt-1 flex items-center gap-1 px-1 text-[10px] font-medium text-ink-400">
          <Clock className="h-2.5 w-2.5" aria-hidden="true" />
          {timeFormatter.format(new Date(message.created_at))}
        </p>
      </div>
    </li>
  );
}

function EmptyThread() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-xl bg-white ring-1 ring-ink-200">
        <MessageSquare className="h-8 w-8 text-ink-300" aria-hidden="true" />
      </span>
      <p className="mt-4 font-bold tracking-tight text-ink-900">No messages yet</p>
      <p className="mt-1 max-w-xs text-sm leading-relaxed text-ink-500">
        Ask a question about this session, send a change of plan, or agree what to bring.
      </p>
    </div>
  );
}
