import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Briefcase,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  GraduationCap,
  Hourglass,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  Menu,
  RefreshCw,
  Search,
  Sparkles,
  TrendingUp,
  User,
  UserRound,
  Users,
  X,
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

/** The sidebar only lists views this app can actually render. */
function navItems(isAdviser) {
  return [
    { key: 'overview', label: 'Dashboard', icon: LayoutDashboard },
    // An adviser answers requests; a student watches their own.
    { key: 'requests', label: isAdviser ? 'Requests' : 'My requests', icon: Inbox, badge: true },
    { key: 'tasks', label: 'Action items', icon: ListChecks },
    { key: 'profile', label: 'My profile', icon: UserRound },
  ];
}

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
const todayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });

export default function Dashboard({ session, onSignOut }) {
  const [consultation, setConsultation] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [tasks, setTasks] = useState([]);
  // Consultation requests: an adviser's are waiting on their decision, a
  // student's are waiting on their adviser.
  const [requests, setRequests] = useState([]);
  const [busyRequestId, setBusyRequestId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyTaskId, setBusyTaskId] = useState(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [view, setView] = useState('overview');
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const profile = session.profile ?? {};
  const token = session.access_token;
  const isAdviser = profile.role === 'adviser';

  const loadDashboard = useCallback(
    async ({ silent = false } = {}) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');

      try {
        // Advisers also get their full upcoming schedule - it is what their
        // side rail shows in place of the student milestone tracker.
        const [nextResult, tasksResult, requestsResult, scheduleResult] = await Promise.all([
          api('/consultations/next', { token }),
          api('/tasks/pending', { token }),
          api('/consultations/requests', { token }),
          isAdviser ? api('/consultations?limit=6', { token }) : Promise.resolve(null),
        ]);
        setConsultation(nextResult.consultation);
        setTasks(tasksResult.tasks ?? []);
        setRequests(requestsResult.requests ?? []);
        setSchedule(scheduleResult?.consultations ?? []);
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
    [isAdviser, onSignOut, token],
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

  /**
   * The adviser's answer to a request. Approving turns it into a real session,
   * so the whole dashboard is reloaded rather than patched in place - the
   * upcoming consultation and the schedule both change.
   */
  async function decideRequest(request, decision, reason) {
    if (busyRequestId) return;
    setBusyRequestId(request.id);
    setError('');
    setNotice('');

    try {
      await api(`/consultations/${request.id}/decision`, {
        method: 'PATCH',
        token,
        body: { decision, ...(reason ? { reason } : {}) },
      });
      setNotice(
        decision === 'approved'
          ? `Approved - "${request.topic}" is now on your schedule and the group can see it.`
          : `Declined "${request.topic}". The group will see your reason.`,
      );
      await loadDashboard({ silent: true });
    } catch (err) {
      if (err.status === 401) {
        onSignOut();
        return;
      }
      setError(err.message);
    } finally {
      setBusyRequestId(null);
    }
  }

  /* Typing in the header search jumps to the list it filters. */
  function handleSearch(value) {
    setQuery(value);
    if (value && view !== 'tasks') setView('tasks');
  }

  function goTo(next) {
    setView(next);
    setNavOpen(false);
  }

  const visibleTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) =>
      [task.task_description, task.consultation_topic, task.assignee_name]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle)),
    );
  }, [query, tasks]);

  // The bell counts what actually needs someone's attention: for an adviser the
  // requests they have not answered, for a student the answers they have not
  // seen yet (a decline stays in the list for a fortnight).
  const pendingRequests = useMemo(
    () => requests.filter((request) => request.status === 'pending'),
    [requests],
  );
  const noticeCount = isAdviser ? pendingRequests.length : requests.length;

  const progress = Math.round((COMPLETED_MILESTONES / MILESTONES.length) * 100);
  const nextMilestone = MILESTONES[COMPLETED_MILESTONES] ?? 'All milestones complete';
  const firstName = profile.first_name || (profile.full_name || '').split(',').pop()?.trim();
  const displayName = firstName || profile.email || 'there';

  return (
    <div className="min-h-screen bg-canvas lg:p-4">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] overflow-hidden bg-white lg:min-h-[calc(100vh-2rem)] lg:rounded-3xl lg:shadow-lift lg:ring-1 lg:ring-slate-900/5">
        <Sidebar
          view={view}
          isAdviser={isAdviser}
          requestCount={noticeCount}
          onNavigate={goTo}
          onSignOut={onSignOut}
          onBook={() => {
            setBookingOpen(true);
            setNavOpen(false);
          }}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            profile={profile}
            query={query}
            onSearch={handleSearch}
            noticeCount={noticeCount}
            isAdviser={isAdviser}
            refreshing={refreshing}
            onRefresh={() => loadDashboard({ silent: true })}
            onBell={() => goTo('requests')}
            onOpenNav={() => setNavOpen(true)}
          />

          <main className="scrollbar-slim flex-1 overflow-y-auto bg-slate-50/70 px-4 py-6 sm:px-7 sm:py-8">
            {error ? (
              <div
                role="alert"
                className="mb-6 flex items-start gap-2.5 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{error}</span>
                <button
                  type="button"
                  onClick={() => loadDashboard()}
                  className="rounded font-bold underline underline-offset-2"
                >
                  Retry
                </button>
              </div>
            ) : null}

            {notice ? (
              <div
                role="status"
                className="mb-6 flex items-start gap-2.5 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-800"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{notice}</span>
                <button
                  type="button"
                  onClick={() => setNotice('')}
                  aria-label="Dismiss"
                  className="rounded p-0.5 text-emerald-700/70 transition hover:text-emerald-900"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {view === 'overview' ? (
              <OverviewView
                displayName={displayName}
                isAdviser={isAdviser}
                loading={loading}
                consultation={consultation}
                schedule={schedule}
                tasks={tasks}
                requests={requests}
                busyRequestId={busyRequestId}
                onDecide={decideRequest}
                onSeeAllRequests={() => goTo('requests')}
                busyTaskId={busyTaskId}
                onResolve={resolveTask}
                onBook={() => setBookingOpen(true)}
                onSeeAllTasks={() => goTo('tasks')}
                progress={progress}
                nextMilestone={nextMilestone}
              />
            ) : null}

            {view === 'requests' ? (
              <RequestsView
                loading={loading}
                isAdviser={isAdviser}
                requests={requests}
                busyRequestId={busyRequestId}
                onDecide={decideRequest}
                onBook={() => setBookingOpen(true)}
              />
            ) : null}

            {view === 'tasks' ? (
              <TasksView
                loading={loading}
                tasks={visibleTasks}
                totalCount={tasks.length}
                query={query}
                onQueryChange={handleSearch}
                busyTaskId={busyTaskId}
                onResolve={resolveTask}
              />
            ) : null}

            {view === 'profile' ? <ProfileView profile={profile} onSignOut={onSignOut} /> : null}
          </main>
        </div>
      </div>

      {bookingOpen ? (
        <BookingModal
          token={token}
          role={profile.role}
          defaultGroupName={profile.group_name}
          onClose={() => setBookingOpen(false)}
          onCreated={(created) => {
            setBookingOpen(false);
            setError('');
            setNotice(
              created?.status === 'pending'
                ? 'Request sent. Your adviser has been notified - it becomes official once they approve it.'
                : 'Consultation scheduled.',
            );
            loadDashboard({ silent: true });
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- sidebar -- */

function Sidebar({ view, isAdviser, requestCount, onNavigate, onSignOut, onBook, open, onClose }) {
  return (
    <>
      {/* Mobile backdrop. */}
      {open ? (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-gradient-to-b from-brand-800 via-brand-800 to-brand-950 p-5 transition-transform duration-300 lg:static lg:z-auto lg:w-64 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25">
              <GraduationCap className="h-6 w-6 text-white" aria-hidden="true" />
            </div>
            <div>
              <p className="font-extrabold tracking-tight text-white">ConsultTrack</p>
              <p className="text-[11px] font-medium text-brand-200">Holy Angel University</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-1.5 text-brand-100 transition hover:bg-white/10 lg:hidden"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <nav className="mt-9 flex flex-1 flex-col gap-1.5">
          <p className="mb-1 px-3 text-[10px] font-bold uppercase tracking-widest text-brand-300/70">
            Menu
          </p>
          {navItems(isAdviser).map(({ key, label, icon: Icon, badge }) => {
            const active = view === key;
            const count = badge ? requestCount : 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNavigate(key)}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                  active
                    ? 'bg-white font-bold text-brand-800 shadow-md shadow-brand-950/30'
                    : 'font-medium text-brand-100/80 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
                {label}
                {count > 0 ? (
                  <span
                    className={`ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                      active ? 'bg-brand-700 text-white' : 'bg-amber-400 text-brand-950'
                    }`}
                  >
                    {count > 9 ? '9+' : count}
                  </span>
                ) : null}
              </button>
            );
          })}

          <div className="mt-6 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15">
            <Sparkles className="h-5 w-5 text-amber-300" aria-hidden="true" />
            <p className="mt-2.5 text-sm font-bold text-white">
              {isAdviser ? 'Set a session' : 'Need your adviser?'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-brand-100/80">
              {isAdviser
                ? 'Schedule a consultation with one of your thesis groups.'
                : 'Book a consultation slot and keep the capstone moving.'}
            </p>
            <button
              type="button"
              onClick={onBook}
              className="mt-3.5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-white px-3 py-2.5 text-xs font-bold text-brand-800 transition hover:bg-brand-50"
            >
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
              {isAdviser ? 'Schedule' : 'Book now'}
            </button>
          </div>
        </nav>

        <button
          type="button"
          onClick={onSignOut}
          className="mt-6 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brand-100/80 transition hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
          Sign out
        </button>
      </aside>
    </>
  );
}

/* ----------------------------------------------------------------- topbar -- */

function TopBar({
  profile,
  query,
  onSearch,
  noticeCount,
  isAdviser,
  refreshing,
  onRefresh,
  onBell,
  onOpenNav,
}) {
  const subtitle = (
    profile.role === 'adviser'
      ? [profile.faculty_position || 'Adviser', profile.department]
      : [profile.year_level, profile.course || profile.department]
  )
    .filter(Boolean)
    .join(' - ');

  return (
    <header className="flex items-center gap-3 border-b border-slate-100 bg-white px-4 py-3.5 sm:px-7">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search action items..."
          aria-label="Search action items"
          className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh dashboard"
          className="rounded-xl p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>

        {/* The bell is the consultation-request notification: for an adviser,
            requests awaiting their approval. */}
        <button
          type="button"
          onClick={onBell}
          aria-label={
            noticeCount === 0
              ? 'No consultation requests'
              : isAdviser
                ? `${noticeCount} consultation ${noticeCount === 1 ? 'request' : 'requests'} awaiting your approval`
                : `${noticeCount} consultation ${noticeCount === 1 ? 'request' : 'requests'} to review`
          }
          className="relative rounded-xl p-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {noticeCount > 0 ? (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white">
              {noticeCount > 9 ? '9+' : noticeCount}
            </span>
          ) : null}
        </button>

        <div className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-1 sm:pr-3">
          <Avatar name={profile.full_name || profile.email} />
          <div className="hidden leading-tight sm:block">
            <p className="max-w-[11rem] truncate text-sm font-bold text-slate-900">
              {profile.full_name || profile.email}
            </p>
            <p className="max-w-[11rem] truncate text-xs text-slate-500">
              {subtitle || (profile.role ?? 'student')}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

function Avatar({ name, size = 'md' }) {
  const initials = (name || '?')
    .replace(/[^\p{L}\s,]/gu, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  const dimensions = size === 'lg' ? 'h-14 w-14 text-lg' : 'h-10 w-10 text-xs';

  return (
    <span
      aria-hidden="true"
      className={`flex ${dimensions} shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-600 to-brand-800 font-bold text-white ring-2 ring-white`}
    >
      {initials || '?'}
    </span>
  );
}

/* --------------------------------------------------------------- overview -- */

function OverviewView({
  displayName,
  isAdviser,
  loading,
  consultation,
  schedule,
  tasks,
  requests,
  busyRequestId,
  onDecide,
  onSeeAllRequests,
  busyTaskId,
  onResolve,
  onBook,
  onSeeAllTasks,
  progress,
  nextMilestone,
}) {
  const meetingDate = consultation ? new Date(consultation.meeting_date) : null;
  const daysAway = meetingDate
    ? Math.ceil((meetingDate.getTime() - Date.now()) / 86_400_000)
    : null;
  const countdown =
    daysAway === null
      ? 'None booked'
      : daysAway <= 0
        ? 'Today'
        : daysAway === 1
          ? 'Tomorrow'
          : `In ${daysAway} days`;

  // Only groups with a session on the books can be counted - nothing else in the
  // data says who an adviser advises.
  const bookedGroups = new Set(schedule.map((item) => item.group_name).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      <HeroBanner displayName={displayName} isAdviser={isAdviser} onBook={onBook} />

      {/* ------------------------------------------------------- stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          [0, 1, 2].map((key) => (
            <div key={key} className="h-32 animate-pulse rounded-2xl bg-slate-200/70" />
          ))
        ) : (
          <>
            <StatTile
              icon={CalendarDays}
              tone="indigo"
              label="Next consultation"
              value={countdown}
              hint={
                meetingDate
                  ? dateFormatter.format(meetingDate)
                  : isAdviser
                    ? 'Nothing booked with you yet'
                    : 'Book a slot with your adviser'
              }
              highlighted
            />
            <StatTile
              icon={ListChecks}
              tone="amber"
              label="Open action items"
              value={String(tasks.length)}
              hint={
                tasks.length === 0
                  ? 'Everything is resolved'
                  : isAdviser
                    ? 'Across your groups'
                    : 'Waiting on your group'
              }
            />
            {isAdviser ? (
              <StatTile
                icon={Users}
                tone="emerald"
                label="Groups booked"
                value={String(bookedGroups)}
                hint={`${schedule.length} upcoming ${schedule.length === 1 ? 'session' : 'sessions'}`}
              />
            ) : (
              <StatTile
                icon={TrendingUp}
                tone="emerald"
                label="Capstone progress"
                value={`${progress}%`}
                hint={`Next up: ${nextMilestone}`}
              />
            )}
          </>
        )}
      </div>

      {/* --------------------------------------------------- main + rail --- */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          {/* Requests come first when there are any: for an adviser this is the
              queue they have to clear before anything is on the books. */}
          {!loading && requests.length > 0 ? (
            <section>
              <SectionHeading
                title={isAdviser ? 'Consultation requests' : 'Waiting on your adviser'}
                action={
                  requests.length > 2 ? (
                    <button
                      type="button"
                      onClick={onSeeAllRequests}
                      className="flex items-center gap-1 rounded-lg text-sm font-bold text-brand-700 hover:underline"
                    >
                      See all
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </button>
                  ) : null
                }
              />
              <div className="space-y-4">
                {requests.slice(0, 2).map((request) => (
                  <RequestCard
                    key={request.id}
                    request={request}
                    isAdviser={isAdviser}
                    busy={busyRequestId === request.id}
                    onDecide={onDecide}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <SectionHeading title="Upcoming consultation" />
            {loading ? (
              <div className="h-52 animate-pulse rounded-2xl bg-slate-200/70" />
            ) : (
              <ConsultationCard
                consultation={consultation}
                countdown={countdown}
                isAdviser={isAdviser}
                onBook={onBook}
              />
            )}
          </section>

          <section>
            <SectionHeading
              title="Pending action items"
              action={
                tasks.length > 3 ? (
                  <button
                    type="button"
                    onClick={onSeeAllTasks}
                    className="flex items-center gap-1 rounded-lg text-sm font-bold text-brand-700 hover:underline"
                  >
                    See all
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null
              }
            />
            {loading ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {[0, 1].map((key) => (
                  <div key={key} className="h-32 animate-pulse rounded-2xl bg-slate-200/70" />
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <EmptyTasks />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {tasks.slice(0, 4).map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    busy={busyTaskId === task.id}
                    onResolve={() => onResolve(task)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          {isAdviser ? (
            <SchedulePanel schedule={schedule} loading={loading} onBook={onBook} />
          ) : (
            <>
              <MilestonePanel progress={progress} />
              <AdviserPanel consultation={consultation} loading={loading} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function HeroBanner({ displayName, isAdviser, onBook }) {
  return (
    <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 px-6 py-8 sm:px-9 sm:py-10">
      <div
        className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-brand-400/30 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-20 left-1/3 h-52 w-52 rounded-full bg-amber-400/20 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative flex flex-wrap items-center justify-between gap-8">
        <div className="min-w-0 max-w-xl">
          <p className="text-xs font-semibold text-brand-200">
            {todayFormatter.format(new Date())}
          </p>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight text-white sm:text-4xl">
            Welcome back, {displayName}!
          </h1>
          <p className="mt-2.5 text-sm leading-relaxed text-brand-100/85">
            {isAdviser
              ? 'Your consultation schedule and every action item still open across your groups.'
              : 'Here is where your capstone stands today - sessions, advisers and everything still open.'}
          </p>
          <button
            type="button"
            onClick={onBook}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-brand-800 shadow-lg shadow-brand-950/25 transition hover:bg-brand-50 active:scale-[0.99]"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            {isAdviser ? 'Schedule a session' : 'Book consultation'}
          </button>
        </div>

        {/* Decorative badge - the illustration slot in the reference layouts. */}
        <div className="relative hidden shrink-0 sm:block" aria-hidden="true">
          <div className="animate-float flex h-32 w-32 items-center justify-center rounded-3xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <GraduationCap className="h-16 w-16 text-white/90" />
          </div>
          <span className="absolute -left-6 top-4 h-4 w-4 rounded-full bg-amber-300" />
          <span className="absolute -bottom-2 -left-2 h-6 w-6 rounded-full bg-brand-300/70" />
          <span className="absolute -right-3 bottom-6 h-3 w-3 rounded-full bg-emerald-300" />
        </div>
      </div>
    </section>
  );
}

const TONES = {
  indigo: 'bg-indigo-50 text-indigo-600',
  amber: 'bg-amber-50 text-amber-600',
  emerald: 'bg-emerald-50 text-emerald-600',
};

function StatTile({ icon: Icon, tone, label, value, hint, highlighted = false }) {
  return (
    <article
      className={`rounded-2xl bg-white p-5 shadow-card transition ${
        highlighted ? 'ring-2 ring-brand-600' : 'ring-1 ring-slate-100 hover:ring-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${TONES[tone]}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        {highlighted ? (
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-700">
            Up next
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900">{value}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
      <p className="mt-1 truncate text-xs text-slate-400">{hint}</p>
    </article>
  );
}

function SectionHeading({ title, action }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-base font-extrabold tracking-tight text-slate-900">{title}</h2>
      {action}
    </div>
  );
}

/* ----------------------------------------------------- consultation card -- */

function ConsultationCard({ consultation, countdown, isAdviser, onBook }) {
  if (!consultation) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-card">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
          <CalendarDays className="h-7 w-7 text-slate-400" aria-hidden="true" />
        </span>
        <p className="mt-4 font-bold text-slate-900">No upcoming consultation</p>
        <p className="mt-1 text-sm text-slate-500">
          {isAdviser
            ? 'Nothing is booked with you yet. You can schedule a session yourself.'
            : 'Book a session with your adviser to keep the thesis moving.'}
        </p>
        <button
          type="button"
          onClick={onBook}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-800"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          {isAdviser ? 'Schedule a session' : 'Book consultation'}
        </button>
      </div>
    );
  }

  const meetingDate = new Date(consultation.meeting_date);

  return (
    <article className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
            {consultation.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-xl font-extrabold tracking-tight text-slate-900">
            {consultation.topic}
          </h3>
        </div>
        <span className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-bold text-brand-700">
          {countdown}
        </span>
      </div>

      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        <Detail icon={CalendarDays} label="Date" value={dateFormatter.format(meetingDate)} />
        <Detail icon={Clock} label="Time" value={timeFormatter.format(meetingDate)} />
        <Detail
          icon={MapPin}
          label="Location"
          value={consultation.location || 'To be announced'}
        />
      </dl>
    </article>
  );
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3.5">
      <dt className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-bold text-slate-800">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------ consultation requests */

/**
 * One request, from both sides of the approval.
 *
 * The adviser sees who is asking and the two buttons that answer it; declining
 * opens a reason box, because the API insists on one and the group deserves it.
 * The student sees the same request as a status: waiting, or declined with the
 * adviser's note.
 */
function RequestCard({ request, isAdviser, busy, onDecide }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const when = new Date(request.meeting_date);
  const declined = request.status === 'declined';

  return (
    <article
      className={`rounded-2xl bg-white p-5 shadow-card ring-1 transition ${
        declined ? 'ring-rose-100' : 'ring-amber-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
            {request.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-lg font-extrabold tracking-tight text-slate-900">
            {request.topic}
          </h3>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${
            declined ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          {declined ? (
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {declined ? 'Declined' : isAdviser ? 'Needs your approval' : 'Waiting for approval'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <Detail icon={CalendarDays} label="Date" value={dateFormatter.format(when)} />
        <Detail icon={Clock} label="Time" value={timeFormatter.format(when)} />
        <Detail icon={MapPin} label="Location" value={request.location || 'To be announced'} />
      </dl>

      {/* Who is on the other side of this request. */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium text-slate-500">
        {isAdviser ? (
          <>
            {request.requester_name ? (
              <span className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" aria-hidden="true" />
                {request.requester_name}
                {request.requester_year_level ? ` - ${request.requester_year_level}` : ''}
              </span>
            ) : null}
            {request.requester_email ? (
              <a
                href={`mailto:${request.requester_email}`}
                className="flex items-center gap-1.5 font-semibold text-brand-700 hover:underline"
              >
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                {request.requester_email}
              </a>
            ) : null}
          </>
        ) : request.adviser_name ? (
          <span className="flex items-center gap-1.5">
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            {request.adviser_name}
          </span>
        ) : null}
      </div>

      {declined && request.decline_reason ? (
        <p className="mt-4 rounded-xl bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-800">
          <span className="font-bold">Adviser's note: </span>
          {request.decline_reason}
        </p>
      ) : null}

      {/* ------------------------------------------------ the decision --- */}
      {isAdviser && request.status === 'pending' ? (
        declining ? (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <label
              htmlFor={`decline-${request.id}`}
              className="text-xs font-bold uppercase tracking-wide text-slate-600"
            >
              Why are you declining?
            </label>
            <textarea
              id={`decline-${request.id}`}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. I have a class then - try Thursday afternoon."
              className="mt-1.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setDeclining(false);
                  setReason('');
                }}
                className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={() => onDecide(request, 'declined', reason.trim())}
                className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <X className="h-4 w-4" aria-hidden="true" />
                )}
                Send decline
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap justify-end gap-2.5 border-t border-slate-100 pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeclining(true)}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:border-rose-200 hover:text-rose-700 disabled:opacity-60"
            >
              Decline
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide(request, 'approved')}
              className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-emerald-900/15 transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              Approve
            </button>
          </div>
        )
      ) : null}
    </article>
  );
}

function RequestsView({ loading, isAdviser, requests, busyRequestId, onDecide, onBook }) {
  const pending = requests.filter((request) => request.status === 'pending').length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
          {isAdviser ? 'Consultation requests' : 'My requests'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {isAdviser
            ? `${pending} ${pending === 1 ? 'request is' : 'requests are'} waiting for your approval. Nothing is on your schedule until you approve it.`
            : 'Requests you have sent. Your adviser has to approve one before it becomes an official session.'}
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1].map((key) => (
            <div key={key} className="h-56 animate-pulse rounded-2xl bg-slate-200/70" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
            <Inbox className="h-7 w-7 text-slate-400" aria-hidden="true" />
          </span>
          <p className="mt-4 font-bold text-slate-900">
            {isAdviser ? 'No requests waiting' : 'No pending requests'}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {isAdviser
              ? 'When a group from your department books you, it lands here for approval.'
              : 'Every request you sent has been answered.'}
          </p>
          {isAdviser ? null : (
            <button
              type="button"
              onClick={onBook}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-brand-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-800"
            >
              <CalendarPlus className="h-4 w-4" aria-hidden="true" />
              Request consultation
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              isAdviser={isAdviser}
              busy={busyRequestId === request.id}
              onDecide={onDecide}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- side rail -- */

function MilestonePanel({ progress }) {
  return (
    <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold tracking-tight text-slate-900">
          Capstone milestones
        </h2>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
          {progress}%
        </span>
      </div>

      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Capstone milestone progress"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-500 transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>

      <ol className="mt-5 space-y-1">
        {MILESTONES.map((milestone, index) => {
          const done = index < COMPLETED_MILESTONES;
          const current = index === COMPLETED_MILESTONES;
          return (
            <li key={milestone} className="flex gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" aria-hidden="true" />
                ) : (
                  <Circle
                    className={`h-5 w-5 shrink-0 ${current ? 'text-brand-600' : 'text-slate-300'}`}
                    aria-hidden="true"
                  />
                )}
                {index < MILESTONES.length - 1 ? (
                  <span
                    className={`my-0.5 w-0.5 flex-1 rounded-full ${done ? 'bg-emerald-200' : 'bg-slate-200'}`}
                  />
                ) : null}
              </div>
              <div className="pb-4">
                <p
                  className={`text-sm ${
                    done
                      ? 'font-semibold text-slate-700'
                      : current
                        ? 'font-bold text-brand-700'
                        : 'font-medium text-slate-400'
                  }`}
                >
                  {milestone}
                </p>
                <p className="text-xs text-slate-400">
                  {done ? 'Completed' : current ? 'In progress' : 'Not started'}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SchedulePanel({ schedule, loading, onBook }) {
  if (loading) return <div className="h-64 animate-pulse rounded-2xl bg-slate-200/70" />;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold tracking-tight text-slate-900">Your schedule</h2>
        <button
          type="button"
          onClick={onBook}
          className="rounded-lg text-sm font-bold text-brand-700 hover:underline"
        >
          Add
        </button>
      </div>

      {schedule.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No sessions booked with you yet. Students pick you from the adviser list when they book.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {schedule.map((item) => {
            const when = new Date(item.meeting_date);
            return (
              <li key={item.id} className="flex gap-3">
                <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-brand-50 leading-none">
                  <span className="text-[10px] font-bold uppercase text-brand-600">
                    {monthFormatter.format(when)}
                  </span>
                  <span className="text-base font-extrabold text-brand-800">{when.getDate()}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-900">{item.topic}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <span className="font-semibold">{timeFormatter.format(when)}</span>
                    {item.group_name ? <span className="truncate">{item.group_name}</span> : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AdviserPanel({ consultation, loading }) {
  if (loading) return <div className="h-40 animate-pulse rounded-2xl bg-slate-200/70" />;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-slate-100">
      <h2 className="text-base font-extrabold tracking-tight text-slate-900">Your adviser</h2>

      {consultation?.adviser_name ? (
        <div className="mt-4 flex items-center gap-3.5">
          <Avatar name={consultation.adviser_name} size="lg" />
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-900">{consultation.adviser_name}</p>
            {consultation.adviser_email ? (
              <a
                href={`mailto:${consultation.adviser_email}`}
                className="mt-0.5 flex items-center gap-1.5 truncate text-xs font-medium text-brand-700 hover:underline"
              >
                <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {consultation.adviser_email}
              </a>
            ) : null}
            {consultation.group_name ? (
              <p className="mt-1 text-xs text-slate-400">{consultation.group_name}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3.5 text-sm text-slate-500">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-slate-100">
            <User className="h-6 w-6 text-slate-400" aria-hidden="true" />
          </span>
          <p>Your adviser appears here once a consultation is scheduled.</p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ tasks view -- */

function TasksView({ loading, tasks, totalCount, query, onQueryChange, busyTaskId, onResolve }) {
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Action items</h1>
          <p className="mt-1 text-sm text-slate-500">
            {query
              ? `${tasks.length} of ${totalCount} open ${totalCount === 1 ? 'task' : 'tasks'} match "${query}".`
              : `${totalCount} open ${totalCount === 1 ? 'task' : 'tasks'} from your consultations.`}
          </p>
        </div>
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Clear "{query}"
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="h-32 animate-pulse rounded-2xl bg-slate-200/70" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        query ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
            <Search className="mx-auto h-9 w-9 text-slate-300" aria-hidden="true" />
            <p className="mt-3 font-bold text-slate-900">No match for "{query}"</p>
            <p className="mt-1 text-sm text-slate-500">Try a different word.</p>
          </div>
        ) : (
          <EmptyTasks />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              busy={busyTaskId === task.id}
              onResolve={() => onResolve(task)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyTasks() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
        <CheckCircle2 className="h-7 w-7 text-emerald-500" aria-hidden="true" />
      </span>
      <p className="mt-4 font-bold text-slate-900">Nothing pending</p>
      <p className="mt-1 text-sm text-slate-500">
        Every action item from your consultations is resolved.
      </p>
    </div>
  );
}

function TaskCard({ task, busy, onResolve }) {
  const due = task.consultation_date ? new Date(task.consultation_date) : null;

  return (
    <article className="flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:ring-brand-200">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onResolve}
          disabled={busy}
          aria-label={`Mark "${task.task_description}" as resolved`}
          className="mt-0.5 shrink-0 rounded-full text-slate-300 transition hover:text-brand-700 disabled:opacity-50"
        >
          {busy ? (
            <CheckCircle2 className="h-5 w-5 animate-pulse text-brand-700" aria-hidden="true" />
          ) : (
            <Circle className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
        <p className="flex-1 text-sm font-semibold leading-snug text-slate-900">
          {task.task_description}
        </p>
      </div>

      {task.consultation_topic ? (
        <span className="mt-3 w-fit max-w-full truncate rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
          {task.consultation_topic}
        </span>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-100 pt-3 text-xs font-medium text-slate-500">
        {due ? (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            {shortDateFormatter.format(due)}
          </span>
        ) : null}
        {task.assignee_name ? (
          <span className="flex items-center gap-1 truncate">
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {task.assignee_name}
          </span>
        ) : null}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------- profile view -- */

function ProfileView({ profile, onSignOut }) {
  const rows = [
    ['Full name', profile.full_name],
    ['Email', profile.email],
    ['Student ID', profile.student_id],
    ['Faculty ID', profile.employee_id],
    ['Position', profile.faculty_position],
    ['Department', profile.department],
    ['Course', profile.course],
    ['Year level', profile.year_level],
    ['Thesis group', profile.group_name],
    ['Role', profile.role, true],
  ].filter(([, value]) => Boolean(value));

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">My profile</h1>
      <p className="mt-1 text-sm text-slate-500">The details you registered with.</p>

      <section className="mt-6 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-100">
        <div className="flex flex-wrap items-center gap-4 bg-gradient-to-br from-brand-700 to-brand-900 px-6 py-7">
          <Avatar name={profile.full_name || profile.email} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-lg font-extrabold text-white">
              {profile.full_name || profile.email}
            </p>
            <p className="truncate text-sm text-brand-100/85">
              {(profile.role === 'adviser'
                ? [profile.faculty_position || 'Adviser', profile.department]
                : [profile.year_level, profile.course]
              )
                .filter(Boolean)
                .join(' - ') || (profile.role ?? 'student')}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/25">
              {profile.role === 'adviser' ? (
                <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {profile.role === 'adviser' ? 'Adviser' : 'Student'}
            </span>
            {profile.email_verified_at ? (
              <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-bold text-white ring-1 ring-white/25">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Email verified
              </span>
            ) : null}
          </div>
        </div>

        <dl className="divide-y divide-slate-100">
          {rows.map(([label, value, capitalized]) => (
            <div key={label} className="flex flex-wrap gap-2 px-6 py-4">
              <dt className="w-40 text-xs font-bold uppercase tracking-wide text-slate-400">
                {label}
              </dt>
              <dd
                className={`flex-1 break-all text-sm font-semibold text-slate-800 ${
                  capitalized ? 'capitalize' : ''
                }`}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <button
        type="button"
        onClick={onSignOut}
        className="mt-6 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:border-brand-200 hover:text-brand-700"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
