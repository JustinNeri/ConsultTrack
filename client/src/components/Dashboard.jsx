import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Circle,
  Clock,
  GraduationCap,
  LogOut,
  MapPin,
  RefreshCw,
  Sparkles,
  User,
} from 'lucide-react';
import BookingModal from './BookingModal.jsx';
import { api } from '../lib/api.js';

/**
 * Capstone milestones are a program-level checklist rather than table data, so
 * they live here. Swap COMPLETED_MILESTONES for a real column when you track it.
 */
const MILESTONES = [
  'Title Proposal',
  'Chapters 1-3',
  'Data Gathering',
  'System Review',
  'Final Defense',
];
const COMPLETED_MILESTONES = 3;

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

export default function Dashboard({ session, onSignOut }) {
  const [consultation, setConsultation] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busyTaskId, setBusyTaskId] = useState(null);
  const [bookingOpen, setBookingOpen] = useState(false);

  const profile = session.profile ?? {};
  const token = session.access_token;

  const loadDashboard = useCallback(
    async ({ silent = false } = {}) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');

      try {
        const [nextResult, tasksResult] = await Promise.all([
          api('/consultations/next', { token }),
          api('/tasks/pending', { token }),
        ]);
        setConsultation(nextResult.consultation);
        setTasks(tasksResult.tasks ?? []);
      } catch (err) {
        if (err.status === 401) {
          onSignOut();
          return;
        }
        setError(err.message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onSignOut, token],
  );

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  async function resolveTask(task) {
    if (busyTaskId) return;
    setBusyTaskId(task.id);

    // Optimistic: drop it from the pending list, restore it if the call fails.
    const snapshot = tasks;
    setTasks((prev) => prev.filter((item) => item.id !== task.id));

    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', token, body: { status: 'resolved' } });
    } catch (err) {
      if (err.status === 401) {
        onSignOut();
        return;
      }
      setTasks(snapshot);
      setError(err.message);
    } finally {
      setBusyTaskId(null);
    }
  }

  const progress = Math.round((COMPLETED_MILESTONES / MILESTONES.length) * 100);
  const nextMilestone = MILESTONES[COMPLETED_MILESTONES] ?? 'All milestones complete';
  const displayName = profile.full_name || profile.email || 'there';

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-800">
              <GraduationCap className="h-5 w-5 text-white" aria-hidden="true" />
            </div>
            <div>
              <p className="font-semibold leading-tight text-slate-900">ConsultTrack</p>
              <p className="text-xs capitalize text-slate-500">
                {profile.role ?? 'student'}
                {profile.group_name ? ` - ${profile.group_name}` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadDashboard({ silent: true })}
              disabled={refreshing}
              className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
              aria-label="Refresh dashboard"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={onSignOut}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              Welcome back, {displayName}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Here is where your capstone stands today.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBookingOpen(true)}
            className="flex items-center gap-2 rounded-xl bg-rose-800 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-800/40 focus:ring-offset-2"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            Book consultation
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-6 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => loadDashboard()}
              className="font-medium underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        ) : null}

        {/* -------------------------------------------------------- hero card */}
        <section className="mt-6">
          {loading ? (
            <div className="h-64 animate-pulse rounded-2xl bg-slate-200" />
          ) : (
            <HeroCard
              consultation={consultation}
              progress={progress}
              nextMilestone={nextMilestone}
              onBook={() => setBookingOpen(true)}
            />
          )}
        </section>

        {/* ----------------------------------------------------- action items */}
        <section className="mt-10">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Pending action items</h2>
            {!loading ? (
              <span className="text-sm text-slate-500">
                {tasks.length} open {tasks.length === 1 ? 'task' : 'tasks'}
              </span>
            ) : null}
          </div>

          {loading ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((key) => (
                <div key={key} className="h-32 animate-pulse rounded-xl bg-slate-200" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" aria-hidden="true" />
              <p className="mt-3 font-medium text-slate-900">Nothing pending</p>
              <p className="mt-1 text-sm text-slate-500">
                Every action item from your consultations is resolved.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  busy={busyTaskId === task.id}
                  onResolve={() => resolveTask(task)}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {bookingOpen ? (
        <BookingModal
          token={token}
          defaultGroupName={profile.group_name}
          onClose={() => setBookingOpen(false)}
          onCreated={() => {
            setBookingOpen(false);
            loadDashboard({ silent: true });
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- hero card -- */

function HeroCard({ consultation, progress, nextMilestone, onBook }) {
  if (!consultation) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <CalendarDays className="mx-auto h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="mt-3 font-medium text-slate-900">No upcoming consultation</p>
        <p className="mt-1 text-sm text-slate-500">
          Book a session with your adviser to keep the thesis moving.
        </p>
        <button
          type="button"
          onClick={onBook}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-rose-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-rose-900"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          Book consultation
        </button>
      </div>
    );
  }

  const meetingDate = new Date(consultation.meeting_date);
  const daysAway = Math.ceil((meetingDate.getTime() - Date.now()) / 86_400_000);
  const countdown = daysAway <= 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `In ${daysAway} days`;

  return (
    <article className="overflow-hidden rounded-2xl bg-rose-800 shadow-lg shadow-rose-900/10">
      <div className="p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-rose-200">
              Next consultation
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">
              {consultation.topic}
            </h2>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-sm font-medium text-white">
            {countdown}
          </span>
        </div>

        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <HeroDetail icon={CalendarDays} label="Date" value={dateFormatter.format(meetingDate)} />
          <HeroDetail icon={Clock} label="Time" value={timeFormatter.format(meetingDate)} />
          <HeroDetail
            icon={MapPin}
            label="Location"
            value={consultation.location || 'To be announced'}
          />
        </dl>

        {consultation.adviser_name ? (
          <p className="mt-5 flex items-center gap-2 text-sm text-rose-100">
            <User className="h-4 w-4" aria-hidden="true" />
            Adviser: {consultation.adviser_name}
            {consultation.group_name ? ` - ${consultation.group_name}` : ''}
          </p>
        ) : null}
      </div>

      {/* ------------------------------------------------- milestone progress */}
      <div className="border-t border-white/15 bg-rose-900/40 px-6 py-5 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium text-white">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Capstone progress
          </p>
          <p className="text-sm text-rose-100">
            {progress}% complete - next up:{' '}
            <span className="font-medium text-white">{nextMilestone}</span>
          </p>
        </div>

        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/20"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Capstone milestone progress"
        >
          <div
            className="h-full rounded-full bg-white transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>

        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {MILESTONES.map((milestone, index) => (
            <li
              key={milestone}
              className={
                index < COMPLETED_MILESTONES
                  ? 'flex items-center gap-1 text-white'
                  : 'flex items-center gap-1 text-rose-200/70'
              }
            >
              {index < COMPLETED_MILESTONES ? (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Circle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {milestone}
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

function HeroDetail({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl bg-white/10 p-4">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-rose-200">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 font-medium text-white">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------- task card -- */

function TaskCard({ task, busy, onResolve }) {
  const due = task.consultation_date ? new Date(task.consultation_date) : null;

  return (
    <article className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-rose-200 hover:shadow-md">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onResolve}
          disabled={busy}
          aria-label={`Mark "${task.task_description}" as resolved`}
          className="mt-0.5 shrink-0 rounded-full text-slate-300 transition hover:text-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-800/30 disabled:opacity-50"
        >
          {busy ? (
            <CheckCircle2 className="h-5 w-5 animate-pulse text-rose-800" aria-hidden="true" />
          ) : (
            <Circle className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
        <p className="flex-1 text-sm font-medium leading-snug text-slate-900">
          {task.task_description}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500">
        {task.consultation_topic ? (
          <span className="truncate">{task.consultation_topic}</span>
        ) : null}
        {due ? (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            {shortDateFormatter.format(due)}
          </span>
        ) : null}
        {task.assignee_name ? (
          <span className="flex items-center gap-1">
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            {task.assignee_name}
          </span>
        ) : null}
      </div>
    </article>
  );
}
