import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FileText,
  GraduationCap,
  Printer,
  Users,
} from 'lucide-react';
import { api } from '../lib/api.js';

const sessionDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const sessionTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const rangeFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const stampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

/**
 * The consultation record: the paper logbook, printed from real data.
 *
 * Every capstone program asks a group to bring a signed log of the
 * consultations they held. Everything on that form already existed in this
 * database -- dates, topics, minutes, action items, and now attendance -- and
 * nothing could get it out of the screen. This is that way out.
 *
 * Printing is the browser's own print-to-PDF rather than a PDF library: the
 * sheet is already HTML, a print stylesheet strips the app shell around it, and
 * a dependency that renders the same thing twice is a dependency that drifts.
 */
export default function RecordView({ token, isAdviser, profile }) {
  const [groups, setGroups] = useState([]);
  const [selected, setSelected] = useState(profile?.group_name ?? '');
  const [record, setRecord] = useState(null);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  /* Which groups this person can pull a record for. */
  useEffect(() => {
    let cancelled = false;
    api('/groups', { token })
      .then((result) => {
        if (cancelled) return;
        const list = result.groups ?? [];
        setGroups(list);
        // A student has one group; an adviser lands on their most recent.
        setSelected((current) => current || list[0]?.group_name || '');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingGroups(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      setRecord(await api(`/record?group=${encodeURIComponent(selected)}`, { token }));
    } catch (err) {
      setRecord(null);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selected, token]);

  useEffect(() => {
    load();
  }, [load]);

  const completed = record?.sessions.filter((s) => s.status === 'completed').length ?? 0;

  return (
    <div className="animate-rise">
      {/* --------------------------------------------- controls (never print) */}
      <div className="no-print mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">
            Consultation record
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-500">
            The log your group hands in: every session held, what was agreed, who was there and
            what it left you to do. Print it or save it as a PDF from the print dialog.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {isAdviser && groups.length > 1 ? (
            <div>
              <label
                htmlFor="record-group"
                className="mb-1.5 block text-[12px] font-medium text-ink-700"
              >
                Group
              </label>
              <select
                id="record-group"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className="rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-sm font-medium text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15"
              >
                {groups.map((group) => (
                  <option key={group.group_name} value={group.group_name}>
                    {group.group_name} ({group.total})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => window.print()}
            disabled={!record || loading}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
          >
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print / save as PDF
          </button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="no-print mb-5 flex items-start gap-2.5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
        </div>
      ) : null}

      {loadingGroups || loading ? (
        <div className="skeleton h-96 rounded-xl" />
      ) : !record ? (
        <EmptyRecord isAdviser={isAdviser} hasGroups={groups.length > 0} />
      ) : (
        <RecordSheet record={record} completed={completed} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the sheet -- */

function RecordSheet({ record, completed }) {
  const first = record.sessions[0];
  const last = record.sessions[record.sessions.length - 1];

  return (
    <article className="print-sheet rounded-xl bg-white p-8 border border-ink-200 sm:p-10">
      {/* --------------------------------------------------------- letterhead */}
      <header className="border-b-2 border-ink-900 pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-brand-800 text-white">
              <GraduationCap className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight text-ink-900">
                Holy Angel University
              </p>
              <p className="text-xs font-medium text-ink-500">Capstone consultation record</p>
            </div>
          </div>
          <p className="text-right text-xs text-ink-500">
            Generated {stampFormatter.format(new Date(record.generated_at))}
          </p>
        </div>

        <h2 className="mt-5 text-2xl font-bold tracking-tight text-ink-900">
          {record.group}
        </h2>

        <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <SummaryFact label="Adviser" value={adviserOf(record.sessions)} />
          <SummaryFact
            label="Sessions held"
            value={`${record.sessions.length} (${completed} wrapped up)`}
          />
          <SummaryFact
            label="Period"
            value={
              first && last
                ? `${rangeFormatter.format(new Date(first.meeting_date))} - ${sessionDateFormatter.format(new Date(last.meeting_date))}`
                : '-'
            }
          />
        </dl>

        {record.members.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-start gap-2 text-sm">
            <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-500">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              Members
            </span>
            <p className="flex-1 font-semibold text-ink-800">
              {record.members
                .map((m) => (m.student_id ? `${m.full_name} (${m.student_id})` : m.full_name))
                .join(' · ')}
            </p>
          </div>
        ) : null}
      </header>

      {/* ----------------------------------------------------------- sessions */}
      <ol className="divide-y divide-ink-200">
        {record.sessions.map((session, index) => (
          <SessionEntry key={session.id} session={session} index={index + 1} />
        ))}
      </ol>

      {/* ---------------------------------------------------------- signature */}
      <footer className="mt-10 break-inside-avoid border-t-2 border-ink-900 pt-6">
        <p className="text-xs leading-relaxed text-ink-600">
          Each session marked <span className="font-bold">wrapped up</span> was closed by the
          adviser named above on the date shown, together with the minutes and action items
          recorded against it.
        </p>
        <div className="mt-8 flex flex-wrap gap-10">
          <div className="min-w-56 flex-1">
            <div className="h-10 border-b border-ink-400" />
            <p className="mt-1.5 text-xs font-semibold text-ink-700">
              {adviserOf(record.sessions)}
            </p>
            <p className="text-[11px] text-ink-500">Thesis adviser - signature over printed name</p>
          </div>
          <div className="min-w-40 flex-1">
            <div className="h-10 border-b border-ink-400" />
            <p className="mt-1.5 text-xs font-semibold text-ink-700">Date</p>
          </div>
        </div>
      </footer>
    </article>
  );
}

function SessionEntry({ session, index }) {
  const when = new Date(session.meeting_date);
  const completed = session.status === 'completed';
  const present = session.attendance.filter((a) => a.present);
  const missing = session.attendance.filter((a) => !a.present);

  return (
    <li className="print-session break-inside-avoid py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-bold tracking-tight text-ink-900">
          <span className="mr-2 text-ink-400">#{index}</span>
          {session.topic}
        </h3>
        <p className="text-sm font-semibold text-ink-600">
          {sessionDateFormatter.format(when)} · {sessionTimeFormatter.format(when)}
          {session.location ? ` · ${session.location}` : ''}
        </p>
      </div>

      {/* Attendance: the three states are meaningfully different. */}
      <p className="mt-2 text-sm">
        <span className="text-[12px] font-medium text-ink-500">Present: </span>
        {session.attendance.length === 0 ? (
          <span className="italic text-ink-400">not recorded</span>
        ) : (
          <>
            <span className="font-semibold text-ink-800">
              {present.map((a) => a.name).join(', ') || 'none'}
            </span>
            {missing.length > 0 ? (
              <span className="text-ink-500">
                {' '}
                (absent: {missing.map((a) => a.name).join(', ')})
              </span>
            ) : null}
          </>
        )}
      </p>

      {session.minutes ? (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">
          <span className="text-[12px] font-medium text-ink-500">
            Agreed:{' '}
          </span>
          {session.minutes}
        </p>
      ) : null}

      {session.action_items.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {session.action_items.map((item, key) => (
            <li key={key} className="flex items-start gap-2 text-sm text-ink-700">
              {item.status === 'resolved' ? (
                <CheckCircle2
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
              ) : (
                <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-300" aria-hidden="true" />
              )}
              <span className="flex-1">
                {item.description}
                <span className="text-ink-500">
                  {item.assignee ? ` - ${item.assignee}` : ' - whole group'}
                  {item.due_date ? `, due ${item.due_date}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2.5 text-xs font-semibold">
        {completed ? (
          <span className="text-emerald-700">
            Wrapped up{' '}
            {session.completed_at
              ? stampFormatter.format(new Date(session.completed_at))
              : ''}
          </span>
        ) : (
          <span className="text-gold-700">Held, not yet wrapped up by the adviser</span>
        )}
      </p>
    </li>
  );
}

function SummaryFact({ label, value }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-ink-500">{label}</dt>
      <dd className="mt-0.5 font-semibold text-ink-800">{value}</dd>
    </div>
  );
}

/** The adviser on the record, taken from the sessions themselves. */
function adviserOf(sessions) {
  const names = [...new Set(sessions.map((s) => s.adviser_name).filter(Boolean))];
  return names.join(', ') || 'Not recorded';
}

function EmptyRecord({ isAdviser, hasGroups }) {
  return (
    <div className="no-print rounded-xl border border-dashed border-ink-300 bg-white px-6 py-14 text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-xl bg-brand-50">
        <FileText className="h-8 w-8 text-brand-600" aria-hidden="true" />
      </span>
      <p className="mt-4 text-lg font-bold tracking-tight text-ink-900">
        Nothing to record yet
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-500">
        {hasGroups
          ? 'This group has no sessions that have already happened. The record fills in as consultations are held.'
          : isAdviser
            ? 'Once you have held a session with a group, their record builds itself from the minutes and action items you write at wrap-up.'
            : 'Your record builds itself as your group holds consultations. Book one to get started.'}
      </p>
    </div>
  );
}
