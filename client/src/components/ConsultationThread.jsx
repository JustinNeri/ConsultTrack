import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Clock,
  Loader2,
  MapPin,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';

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
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-700 to-brand-900 text-white">
            <MessageSquare className="h-5 w-5" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            {loading && !consultation ? (
              <div className="skeleton h-9 w-48 rounded-lg" />
            ) : (
              <>
                <p className="truncate font-extrabold tracking-tight text-ink-900">
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
            className="shrink-0 rounded-xl p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
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

        {/* -------------------------------------------------------- messages */}
        <div className="scrollbar-slim flex-1 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((key) => (
                <div key={key} className="skeleton h-14 rounded-2xl" />
              ))}
            </div>
          ) : messages.length === 0 ? (
            <EmptyThread />
          ) : (
            days.map((day) => (
              <section key={day.key}>
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-ink-200" aria-hidden="true" />
                  <span className="text-[11px] font-bold uppercase tracking-wide text-ink-400">
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
              className="mb-2.5 flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700"
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
              className="scrollbar-slim max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-3 text-sm text-ink-900 transition placeholder:text-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
            />
            <button
              type="submit"
              disabled={!draft.trim() || sending}
              aria-label="Send message"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-700 to-brand-600 text-white shadow-lg shadow-brand-900/20 transition hover:from-brand-800 hover:to-brand-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
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
          <p className="mb-1 px-1 text-[11px] font-bold text-ink-500">
            {message.sender_name || 'Someone'}
            {message.sender_role === 'adviser' ? (
              <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700">
                Adviser
              </span>
            ) : null}
          </p>
        ) : null}

        <div
          className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ${
            mine
              ? 'rounded-br-md bg-gradient-to-br from-brand-700 to-brand-800 text-white'
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
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white ring-1 ring-ink-200">
        <MessageSquare className="h-8 w-8 text-ink-300" aria-hidden="true" />
      </span>
      <p className="mt-4 font-extrabold tracking-tight text-ink-900">No messages yet</p>
      <p className="mt-1 max-w-xs text-sm leading-relaxed text-ink-500">
        Ask a question about this session, send a change of plan, or agree what to bring.
      </p>
    </div>
  );
}
