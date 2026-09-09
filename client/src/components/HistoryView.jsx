import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  History,
  ListChecks,
  MessageSquare,
  Sparkles,
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
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">Session history</h1>
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
          className="mb-5 flex items-start gap-2.5 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
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
            <div key={key} className="skeleton h-32 rounded-2xl" />
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

function SessionRow({ session, isAdviser, unread, onOpenThread, onWrapUp }) {
  const when = new Date(session.meeting_date);
  const completed = session.status === 'completed';

  return (
    <article
      className={`overflow-hidden rounded-2xl bg-white shadow-card ring-1 transition duration-300 hover:shadow-raised ${
        completed ? 'ring-ink-100' : 'ring-gold-200'
      }`}
    >
      <div className="flex flex-wrap items-start gap-4 p-5">
        {/* The date block, matching the adviser's schedule rail. */}
        <div
          className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl leading-none ${
            completed ? 'bg-ink-100' : 'bg-gold-50'
          }`}
        >
          <span
            className={`text-[10px] font-bold uppercase ${
              completed ? 'text-ink-500' : 'text-gold-700'
            }`}
          >
            {monthFormatter.format(when)}
          </span>
          <span
            className={`text-lg font-extrabold ${completed ? 'text-ink-800' : 'text-gold-700'}`}
          >
            {when.getDate()}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              {session.group_name ? (
                <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
                  {session.group_name}
                </p>
              ) : null}
              <h3 className="mt-1 text-lg font-extrabold tracking-tight text-ink-900">
                {session.topic}
              </h3>
              <p className="mt-0.5 text-xs font-medium text-ink-500">
                {fullFormatter.format(when)}
                {session.adviser_name && !isAdviser ? ` - ${session.adviser_name}` : ''}
              </p>
            </div>

            <span
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${
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
            <div className="mt-3 rounded-xl bg-ink-50 px-3.5 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wide text-ink-400">
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
              className="relative flex items-center gap-1.5 rounded-lg text-xs font-bold text-brand-700 transition hover:underline"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              {session.message_count > 0
                ? `${session.message_count} ${session.message_count === 1 ? 'message' : 'messages'}`
                : 'Messages'}
              {unread > 0 ? (
                <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </button>

            {isAdviser && !completed ? (
              <button
                type="button"
                onClick={onWrapUp}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99]"
              >
                <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
                Wrap up
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function EmptyHistory({ isAdviser }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-14 text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50">
        <History className="h-8 w-8 text-brand-600" aria-hidden="true" />
      </span>
      <p className="mt-4 text-lg font-extrabold tracking-tight text-ink-900">No past sessions yet</p>
      <p className="mx-auto mt-1.5 flex max-w-md items-center justify-center gap-1.5 text-sm leading-relaxed text-ink-500">
        <Sparkles className="h-4 w-4 shrink-0 text-gold-500" aria-hidden="true" />
        {isAdviser
          ? 'Once a session you advised has passed, it lands here to be wrapped up.'
          : 'Your consultations appear here once they have happened.'}
      </p>
    </div>
  );
}
