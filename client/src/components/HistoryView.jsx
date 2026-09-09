import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  History,
  ListChecks,
  Loader2,
  MessageSquare,
  Sparkles,
  Star,
} from 'lucide-react';
import { api } from '../lib/api.js';

const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
const fullFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Sessions that have already happened.
 *
 * Before the wrap-up existed, a consultation simply fell out of the
 * `meeting_date >= now()` filter and was never seen again -- nothing recorded
 * that it took place. A session the adviser has not wrapped up still appears
 * here, flagged, because it happened whether or not anyone wrote it down, and
 * surfacing it is how it gets finished.
 */
/**
 * A completed session's rating, from the group.
 *
 * Only appears once a session has been wrapped up, because until then there is
 * nothing to rate. The adviser never sees who said what -- the API returns them
 * an average and unattributed comments -- so a student is not answering to the
 * person they are rating.
 */
function SessionFeedback({ token, consultationId, isAdviser }) {
  const [mine, setMine] = useState(null);
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api(`/consultations/${consultationId}/feedback`, { token, signal: controller.signal })
      .then((result) => {
        setMine(result.mine ?? null);
        setSummary(result.summary ?? null);
        if (result.mine) {
          setRating(result.mine.rating);
          setComment(result.mine.comment ?? '');
        }
      })
      // A session is still readable without its rating.
      .catch(() => {});
    return () => controller.abort();
  }, [consultationId, token]);

  async function save() {
    if (!rating || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await api(`/consultations/${consultationId}/feedback`, {
        method: 'POST',
        token,
        body: { rating, comment: comment.trim() || null },
      });
      setMine(result.feedback);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (isAdviser) {
    if (!summary?.responses) return null;
    return (
      <div className="mt-3 rounded-lg border border-ink-200 bg-ink-50 px-3.5 py-2.5">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
          <Star className="h-3.5 w-3.5 text-gold-500" aria-hidden="true" />
          {summary.average} out of 5
          <span className="font-normal text-ink-500">
            from {summary.responses} {summary.responses === 1 ? 'reply' : 'replies'}
          </span>
        </p>
        {(summary.comments ?? []).map((text, index) => (
          <p key={index} className="mt-1.5 text-[12px] italic text-ink-600">
            &ldquo;{text}&rdquo;
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-3">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3 py-1.5 text-xs font-semibold text-ink-700 transition hover:border-gold-300 hover:bg-gold-50"
        >
          <Star className="h-3.5 w-3.5 text-gold-500" aria-hidden="true" />
          {mine ? `You rated this ${mine.rating}/5` : 'Rate this session'}
        </button>
      ) : (
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3.5">
          <p className="text-[12px] font-medium text-ink-700">How was this consultation?</p>
          <div className="mt-2 flex gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setRating(value)}
                aria-label={`${value} out of 5`}
                aria-pressed={rating === value}
                className={`rounded-md p-1 transition ${
                  value <= rating ? 'text-gold-500' : 'text-ink-300 hover:text-ink-400'
                }`}
              >
                <Star className="h-5 w-5" fill={value <= rating ? 'currentColor' : 'none'} aria-hidden="true" />
              </button>
            ))}
          </div>
          <textarea
            rows={2}
            maxLength={1000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Anything worth saying about it? (optional)"
            className="mt-2 w-full resize-none rounded-lg border border-ink-200 bg-white px-3 py-2 text-[13px] text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15"
          />
          {error ? <p className="mt-1.5 text-xs font-medium text-rose-700">{error}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!rating || saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HistoryView({
  token,
  isAdviser,
  unreadByConsultation,
  onOpenThread,
  onWrapUp,
  reloadKey,
}) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api('/consultations/history?limit=30', { token });
      setSessions(result.consultations ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const unwrapped = sessions.filter((session) => session.status !== 'completed').length;

  return (
    <div className="animate-rise">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">Session history</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-500">
          {isAdviser
            ? 'Every consultation you have already held, with the minutes and the action items that came out of it.'
            : 'Every consultation your group has already had, with what your adviser recorded.'}
          {unwrapped > 0 && isAdviser
            ? ` ${unwrapped} still ${unwrapped === 1 ? 'needs' : 'need'} wrapping up.`
            : ''}
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={load} className="rounded font-bold underline underline-offset-2">
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton h-32 rounded-xl" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyHistory isAdviser={isAdviser} />
      ) : (
        <ul className="space-y-4">
          {sessions.map((session, index) => (
            <li key={session.id} className="animate-rise" style={{ '--delay': `${index * 40}ms` }}>
              <SessionRow
                session={session}
                token={token}
                isAdviser={isAdviser}
                unread={unreadByConsultation?.[session.id] ?? 0}
                onOpenThread={() => onOpenThread(session.id)}
                onWrapUp={() => onWrapUp(session.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionRow({ session, token, isAdviser, unread, onOpenThread, onWrapUp }) {
  const when = new Date(session.meeting_date);
  const completed = session.status === 'completed';

  return (
    <article
      className={`overflow-hidden rounded-xl border bg-white transition-colors ${
        completed ? 'border-ink-200 hover:border-ink-300' : 'border-gold-200'
      }`}
    >
      <div className="flex flex-wrap items-start gap-4 p-5">
        {/* The date block, matching the adviser's schedule rail. */}
        <div
          className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-lg leading-none ${
            completed ? 'bg-ink-100' : 'bg-gold-50'
          }`}
        >
          <span
            className={`text-[10px] font-semibold uppercase ${
              completed ? 'text-ink-500' : 'text-gold-700'
            }`}
          >
            {monthFormatter.format(when)}
          </span>
          <span
            className={`text-lg font-bold ${completed ? 'text-ink-800' : 'text-gold-700'}`}
          >
            {when.getDate()}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              {session.group_name ? (
                <p className="truncate text-[12px] font-medium text-ink-500">
                  {session.group_name}
                </p>
              ) : null}
              <h3 className="mt-1 text-lg font-bold tracking-tight text-ink-900">
                {session.topic}
              </h3>
              <p className="mt-0.5 text-xs font-medium text-ink-500">
                {fullFormatter.format(when)}
                {session.adviser_name && !isAdviser ? ` - ${session.adviser_name}` : ''}
              </p>
            </div>

            <span
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
                completed ? 'bg-emerald-50 text-emerald-700' : 'bg-gold-50 text-gold-700'
              }`}
            >
              {completed ? (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {completed ? 'Completed' : 'Not wrapped up'}
            </span>
          </div>

          {session.minutes ? (
            <div className="mt-3 rounded-lg bg-ink-50 px-3.5 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                What was agreed
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">
                {session.minutes}
              </p>
            </div>
          ) : completed ? (
            <p className="mt-3 text-xs italic text-ink-400">No minutes were recorded.</p>
          ) : null}

          {/* ------------------------------------------------------ footer -- */}
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-100 pt-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-500">
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
              {session.task_count} action {session.task_count === 1 ? 'item' : 'items'}
            </span>

            <button
              type="button"
              onClick={onOpenThread}
              className="relative flex items-center gap-1.5 rounded-lg text-xs font-semibold text-brand-700 transition hover:underline"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {session.message_count > 0
                ? `${session.message_count} ${session.message_count === 1 ? 'message' : 'messages'}`
                : 'Messages'}
              {unread > 0 ? (
                <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-semibold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </button>

            {isAdviser && !completed ? (
              <button
                type="button"
                onClick={onWrapUp}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99]"
              >
                <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
                Wrap up
              </button>
            ) : null}
          </div>

          {/* Only a session that happened can be rated. */}
          {completed ? (
            <SessionFeedback
              token={token}
              consultationId={session.id}
              isAdviser={isAdviser}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

function EmptyHistory({ isAdviser }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-white px-6 py-14 text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-brand-50">
        <History className="h-8 w-8 text-brand-600" aria-hidden="true" />
      </span>
      <p className="mt-4 text-lg font-bold tracking-tight text-ink-900">No past sessions yet</p>
      <p className="mx-auto mt-1.5 flex max-w-md items-center justify-center gap-1.5 text-sm leading-relaxed text-ink-500">
        <Sparkles className="h-4 w-4 shrink-0 text-gold-500" aria-hidden="true" />
        {isAdviser
          ? 'Once a session you advised has passed, it lands here to be wrapped up.'
          : 'Your consultations appear here once they have happened.'}
      </p>
    </div>
  );
}
