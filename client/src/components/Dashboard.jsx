import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Bell,
  Briefcase,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  GraduationCap,
  History,
  Hourglass,
  Inbox,
  LayoutDashboard,
  ClipboardList,
  ListChecks,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
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
import AvailabilityView from './AvailabilityView.jsx';
import ConsultationThread from './ConsultationThread.jsx';
import CompleteSessionModal from './CompleteSessionModal.jsx';
import HistoryView from './HistoryView.jsx';
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
    // Only an adviser has hours to publish; a student books out of them.
    ...(isAdviser
      ? [{ key: 'availability', label: 'Consultation hours', icon: CalendarClock }]
      : []),
    { key: 'tasks', label: 'Action items', icon: ListChecks },
    // Where a session goes once it has happened, and where an adviser finishes
    // wrapping one up.
    { key: 'history', label: 'Past sessions', icon: History },
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
  // How many consultation-hour blocks the adviser publishes. Zero is what
  // triggers the nudge on their overview -- students are guessing until then.
  const [hourBlocks, setHourBlocks] = useState(null);
  const [busyRequestId, setBusyRequestId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyTaskId, setBusyTaskId] = useState(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  // Which consultation's thread is open, and which one is being wrapped up.
  const [threadId, setThreadId] = useState(null);
  const [wrapUpId, setWrapUpId] = useState(null);
  const [unread, setUnread] = useState({ total: 0, threads: [] });
  // Bumped to make the history view re-read itself after a wrap-up.
  const [historyKey, setHistoryKey] = useState(0);
  const [view, setView] = useState('overview');
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const profile = session.profile ?? {};
  const token = session.access_token;
  const isAdviser = profile.role === 'adviser';

  const refreshUnread = useCallback(async () => {
    try {
      const result = await api('/messages/unread', { token });
      setUnread({ total: result.total ?? 0, threads: result.threads ?? [] });
    } catch {
      /* The badge is not worth surfacing an error for. */
    }
  }, [token]);

  const loadDashboard = useCallback(
    async ({ silent = false } = {}) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError('');

      try {
        // Advisers also get their full upcoming schedule - it is what their
        // side rail shows in place of the student milestone tracker.
        const [nextResult, tasksResult, requestsResult, scheduleResult, hoursResult] =
          await Promise.all([
            api('/consultations/next', { token }),
            api('/tasks/pending', { token }),
            api('/consultations/requests', { token }),
            isAdviser ? api('/consultations?limit=6', { token }) : Promise.resolve(null),
            isAdviser ? api('/availability', { token }) : Promise.resolve(null),
          ]);
        setConsultation(nextResult.consultation);
        setTasks(tasksResult.tasks ?? []);
        setRequests(requestsResult.requests ?? []);
        setSchedule(scheduleResult?.consultations ?? []);
        setHourBlocks(hoursResult ? (hoursResult.availability ?? []).length : null);
        refreshUnread();
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
    [isAdviser, onSignOut, refreshUnread, token],
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

  // Per-consultation counts, so each card can badge its own thread.
  const unreadByConsultation = useMemo(
    () =>
      Object.fromEntries(unread.threads.map((thread) => [thread.consultation_id, thread.unread])),
    [unread.threads],
  );

  const progress = Math.round((COMPLETED_MILESTONES / MILESTONES.length) * 100);
  const nextMilestone = MILESTONES[COMPLETED_MILESTONES] ?? 'All milestones complete';
  const firstName = profile.first_name || (profile.full_name || '').split(',').pop()?.trim();
  const displayName = firstName || profile.email || 'there';

  return (
    <div className="min-h-screen bg-canvas lg:p-4">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] overflow-hidden bg-white lg:min-h-[calc(100vh-2rem)] lg:rounded-3xl lg:shadow-lift lg:ring-1 lg:ring-ink-900/5">
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
            unreadTotal={unread.total}
            // The busiest thread is the one worth opening first; the list is
            // already ordered by unread count.
            onOpenMessages={() => {
              const busiest = unread.threads[0];
              if (busiest) setThreadId(busiest.consultation_id);
              else goTo('history');
            }}
          />

          <main className="scrollbar-slim flex-1 overflow-y-auto bg-ink-50/70 px-4 py-6 sm:px-7 sm:py-8">
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
                hourBlocks={hourBlocks}
                onSetHours={() => goTo('availability')}
                unreadByConsultation={unreadByConsultation}
                onOpenThread={setThreadId}
                onWrapUp={setWrapUpId}
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
                unreadByConsultation={unreadByConsultation}
                onOpenThread={setThreadId}
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

            {view === 'availability' && isAdviser ? (
              <AvailabilityView
                token={token}
                onSignOut={onSignOut}
                onHoursChanged={setHourBlocks}
              />
            ) : null}

            {view === 'history' ? (
              <HistoryView
                token={token}
                isAdviser={isAdviser}
                unreadByConsultation={unreadByConsultation}
                onOpenThread={setThreadId}
                onWrapUp={setWrapUpId}
                reloadKey={historyKey}
              />
            ) : null}

            {view === 'profile' ? <ProfileView profile={profile} onSignOut={onSignOut} /> : null}
          </main>
        </div>
      </div>

      {threadId ? (
        <ConsultationThread
          token={token}
          consultationId={threadId}
          profile={profile}
          onClose={() => setThreadId(null)}
          onReadChanged={refreshUnread}
        />
      ) : null}

      {wrapUpId ? (
        <CompleteSessionModal
          token={token}
          consultationId={wrapUpId}
          onClose={() => setWrapUpId(null)}
          onCompleted={(result) => {
            setWrapUpId(null);
            setError('');
            const count = result?.tasks?.length ?? 0;
            setNotice(
              count > 0
                ? `Session wrapped up - ${count} action ${count === 1 ? 'item' : 'items'} sent to the group.`
                : 'Session wrapped up and moved to your past sessions.',
            );
            // The session leaves the upcoming schedule and the new action items
            // arrive, so both the dashboard and the history list are now stale.
            setHistoryKey((key) => key + 1);
            loadDashboard({ silent: true });
          }}
        />
      ) : null}

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
          className="fixed inset-0 z-40 bg-ink-900/40 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-hidden bg-gradient-to-b from-brand-800 via-brand-900 to-brand-950 p-5 transition-transform duration-300 lg:static lg:z-auto lg:w-64 lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* A warm bloom behind the wordmark keeps the crimson from going flat. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full bg-brand-500/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 -right-16 h-56 w-56 rounded-full bg-gold-500/10 blur-3xl"
        />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
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

        <nav className="relative mt-9 flex flex-1 flex-col gap-1.5">
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
                className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                  active
                    ? 'bg-white font-bold text-brand-800 shadow-lg shadow-brand-950/40'
                    : 'font-medium text-brand-100/80 hover:bg-white/10 hover:text-white'
                }`}
              >
                {/* A gold rule on the active item, so the current view is
                    readable from the edge of the eye. */}
                <span
                  aria-hidden="true"
                  className={`absolute -left-5 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-gold-300 transition-opacity ${
                    active ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <Icon
                  className={`h-5 w-5 transition-transform ${active ? '' : 'group-hover:scale-110'}`}
                  aria-hidden="true"
                />
                {label}
                {count > 0 ? (
                  <span
                    className={`ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold ${
                      active
                        ? 'bg-brand-700 text-white'
                        : 'animate-ping-badge bg-gold-300 text-brand-950'
                    }`}
                  >
                    {count > 9 ? '9+' : count}
                  </span>
                ) : null}
              </button>
            );
          })}

          <div className="mt-6 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur">
            <Sparkles className="h-5 w-5 text-gold-300" aria-hidden="true" />
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
          className="relative mt-6 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brand-100/80 transition hover:bg-white/10 hover:text-white"
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
  unreadTotal,
  onOpenMessages,
}) {
  const subtitle = (
    profile.role === 'adviser'
      ? [profile.faculty_position || 'Adviser', profile.department]
      : [profile.year_level, profile.course || profile.department]
  )
    .filter(Boolean)
    .join(' - ');

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-100 bg-white/85 px-4 py-3.5 backdrop-blur-xl sm:px-7">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="rounded-xl p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search action items..."
          aria-label="Search action items"
          className="w-full rounded-xl border border-ink-200 bg-ink-50 py-2.5 pl-10 pr-3 text-sm text-ink-900 transition placeholder:text-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
        />
      </div>

      <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh dashboard"
          className="rounded-xl p-2.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>

        {/* Unread messages, separate from the bell: the bell is about requests
            waiting on a decision, this is about somebody talking to you. */}
        <button
          type="button"
          onClick={onOpenMessages}
          aria-label={
            unreadTotal === 0
              ? 'No unread messages'
              : `${unreadTotal} unread ${unreadTotal === 1 ? 'message' : 'messages'}`
          }
          className="relative rounded-xl p-2.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          {unreadTotal > 0 ? (
            <span className="animate-ping-badge absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-1 text-[9px] font-bold text-white ring-2 ring-white">
              {unreadTotal > 9 ? '9+' : unreadTotal}
            </span>
          ) : null}
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
          className="relative rounded-xl p-2.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {noticeCount > 0 ? (
            <span className="animate-ping-badge absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white ring-2 ring-white">
              {noticeCount > 9 ? '9+' : noticeCount}
            </span>
          ) : null}
        </button>

        <div className="flex items-center gap-2.5 rounded-xl py-1 pl-1 pr-1 sm:pr-3">
          <Avatar name={profile.full_name || profile.email} />
          <div className="hidden leading-tight sm:block">
            <p className="max-w-[11rem] truncate text-sm font-bold text-ink-900">
              {profile.full_name || profile.email}
            </p>
            <p className="max-w-[11rem] truncate text-xs text-ink-500">
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
  hourBlocks,
  onSetHours,
  unreadByConsultation,
  onOpenThread,
  onWrapUp,
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

      {/* An adviser with no published hours is still fielding guessed times. */}
      {isAdviser && !loading && hourBlocks === 0 ? (
        <PublishHoursPrompt onSetHours={onSetHours} />
      ) : null}

      {/* ------------------------------------------------------- stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          [0, 1, 2].map((key) => (
            <div key={key} className="h-32 skeleton rounded-2xl" />
          ))
        ) : (
          <>
            <StatTile
              icon={CalendarDays}
              tone="indigo"
              label="Next consultation"
              value={countdown}
              delay={0}
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
              delay={70}
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
                delay={140}
                hint={`${schedule.length} upcoming ${schedule.length === 1 ? 'session' : 'sessions'}`}
              />
            ) : (
              <StatTile
                icon={TrendingUp}
                tone="emerald"
                label="Capstone progress"
                value={`${progress}%`}
                delay={140}
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
                    unread={unreadByConsultation?.[request.id] ?? 0}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <SectionHeading title="Upcoming consultation" />
            {loading ? (
              <div className="h-52 skeleton rounded-2xl" />
            ) : (
              <ConsultationCard
                consultation={consultation}
                countdown={countdown}
                isAdviser={isAdviser}
                onBook={onBook}
                unread={unreadByConsultation?.[consultation?.id] ?? 0}
                onOpenThread={onOpenThread}
                onWrapUp={onWrapUp}
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
                  <div key={key} className="h-32 skeleton rounded-2xl" />
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
            <SchedulePanel
              schedule={schedule}
              loading={loading}
              onBook={onBook}
              unreadByConsultation={unreadByConsultation}
              onOpenThread={onOpenThread}
            />
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

/**
 * Shown once, to an adviser who has published nothing. Consultation hours are
 * the difference between answering every guessed time and having students pick
 * from slots that already work -- but only if the adviser knows they exist.
 */
function PublishHoursPrompt({ onSetHours }) {
  return (
    <section className="animate-rise flex flex-wrap items-center gap-4 rounded-2xl border border-gold-200 bg-gradient-to-r from-gold-50 to-white p-5 shadow-card">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gold-100 text-gold-700">
        <CalendarClock className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-extrabold tracking-tight text-ink-900">
          Publish your consultation hours
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-ink-600">
          Right now students pick any time they like and wait for you to answer. Publish the
          hours you are free and they can only book slots that already work for you.
        </p>
      </div>
      <button
        type="button"
        onClick={onSetHours}
        className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl bg-ink-900 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-ink-800 active:scale-[0.99]"
      >
        Set my hours
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

function HeroBanner({ displayName, isAdviser, onBook }) {
  return (
    <section className="animate-rise relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-800 to-brand-950 px-6 py-8 shadow-raised sm:px-9 sm:py-10">
      <div
        className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-brand-400/30 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-20 left-1/3 h-52 w-52 rounded-full bg-gold-400/20 blur-3xl"
        aria-hidden="true"
      />
      {/* A faint grid, so the largest surface on the page is not bare gradient. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #fff 1px, transparent 1px), linear-gradient(to bottom, #fff 1px, transparent 1px)',
          backgroundSize: '3rem 3rem',
        }}
      />

      <div className="relative flex flex-wrap items-center justify-between gap-8">
        <div className="min-w-0 max-w-xl">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-brand-100 ring-1 ring-white/15 backdrop-blur">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
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
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-brand-800 shadow-lg shadow-brand-950/25 transition hover:-translate-y-0.5 hover:bg-brand-50 hover:shadow-xl active:translate-y-0 active:scale-[0.99]"
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
          <span className="absolute -left-6 top-4 h-4 w-4 rounded-full bg-gold-300" />
          <span className="absolute -bottom-2 -left-2 h-6 w-6 rounded-full bg-brand-300/70" />
          <span className="absolute -right-3 bottom-6 h-3 w-3 rounded-full bg-emerald-300" />
        </div>
      </div>
    </section>
  );
}

/*
 * Each tone is an icon chip plus the hairline that tops the card, so the three
 * tiles are told apart by a 3px rule rather than by three loud backgrounds.
 */
const TONES = {
  indigo: { chip: 'bg-indigo-50 text-indigo-600', rule: 'from-indigo-400 to-indigo-600' },
  amber: { chip: 'bg-gold-100 text-gold-700', rule: 'from-gold-300 to-gold-500' },
  emerald: { chip: 'bg-emerald-50 text-emerald-600', rule: 'from-emerald-400 to-emerald-600' },
};

function StatTile({ icon: Icon, tone, label, value, hint, highlighted = false, delay = 0 }) {
  const { chip, rule } = TONES[tone];

  return (
    <article
      style={{ '--delay': `${delay}ms` }}
      className={`animate-rise group relative overflow-hidden rounded-2xl bg-white p-5 shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-raised ${
        highlighted ? 'ring-2 ring-brand-600' : 'ring-1 ring-ink-100 hover:ring-ink-200'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${
          highlighted ? 'from-brand-500 to-brand-700' : rule
        }`}
      />

      <div className="flex items-start justify-between gap-3">
        <span
          className={`flex h-11 w-11 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 ${chip}`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        {highlighted ? (
          <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-brand-700">
            Up next
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-2xl font-extrabold tracking-tight text-ink-900">{value}</p>
      <p className="mt-0.5 text-sm font-semibold text-ink-600">{label}</p>
      <p className="mt-1 truncate text-xs text-ink-400">{hint}</p>
    </article>
  );
}

/**
 * Opens the thread for one consultation, carrying its unread count.
 *
 * On a request card this is the reply channel a decline never had: the
 * adviser's reason is one sentence with nowhere to answer it, so "try Thursday"
 * used to end the conversation rather than continue it.
 */
function ThreadButton({ unread = 0, onClick, label = 'Messages' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 px-3.5 py-2 text-xs font-bold text-ink-700 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
      {unread > 0 ? (
        <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </button>
  );
}

function SectionHeading({ title, action }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-base font-extrabold tracking-tight text-ink-900">{title}</h2>
      {action}
    </div>
  );
}

/* ----------------------------------------------------- consultation card -- */

function ConsultationCard({
  consultation,
  countdown,
  isAdviser,
  onBook,
  unread = 0,
  onOpenThread,
  onWrapUp,
}) {
  if (!consultation) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center shadow-card">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-100">
          <CalendarDays className="h-7 w-7 text-ink-400" aria-hidden="true" />
        </span>
        <p className="mt-4 font-bold text-ink-900">No upcoming consultation</p>
        <p className="mt-1 text-sm text-ink-500">
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
    <article className="animate-rise rounded-2xl bg-white p-6 shadow-card ring-1 ring-ink-100 transition duration-300 hover:shadow-raised">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
            {consultation.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-xl font-extrabold tracking-tight text-ink-900">
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

      <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-ink-100 pt-4">
        <ThreadButton unread={unread} onClick={() => onOpenThread(consultation.id)} />
        {/* The adviser ran the session, so the adviser closes it. */}
        {isAdviser ? (
          <button
            type="button"
            onClick={() => onWrapUp(consultation.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99]"
          >
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
            Wrap up
          </button>
        ) : null}
      </div>
    </article>
  );
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl bg-ink-50 p-3.5 ring-1 ring-ink-100 transition hover:bg-brand-50/50 hover:ring-brand-100">
      <dt className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-ink-400">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </dt>
      <dd className="mt-1 text-sm font-bold text-ink-800">{value}</dd>
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
function RequestCard({ request, isAdviser, busy, onDecide, unread = 0, onOpenThread }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const when = new Date(request.meeting_date);
  const declined = request.status === 'declined';

  return (
    <article
      className={`animate-rise relative overflow-hidden rounded-2xl bg-white p-5 shadow-card ring-1 transition duration-300 hover:shadow-raised ${
        declined ? 'ring-rose-100' : 'ring-gold-200'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${declined ? 'bg-rose-400' : 'bg-gold-400'}`}
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">
            {request.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-lg font-extrabold tracking-tight text-ink-900">
            {request.topic}
          </h3>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ${
            declined ? 'bg-rose-50 text-rose-700' : 'bg-gold-50 text-gold-700'
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
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-medium text-ink-500">
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

      {onOpenThread ? (
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <ThreadButton
            unread={unread}
            onClick={() => onOpenThread(request.id)}
            label={declined ? 'Reply' : 'Messages'}
          />
        </div>
      ) : null}

      {/* ------------------------------------------------ the decision --- */}
      {isAdviser && request.status === 'pending' ? (
        declining ? (
          <div className="mt-4 border-t border-ink-100 pt-4">
            <label
              htmlFor={`decline-${request.id}`}
              className="text-xs font-bold uppercase tracking-wide text-ink-600"
            >
              Why are you declining?
            </label>
            <textarea
              id={`decline-${request.id}`}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. I have a class then - try Thursday afternoon."
              className="mt-1.5 w-full rounded-xl border border-ink-200 bg-ink-50 px-3.5 py-2.5 text-sm text-ink-900 transition placeholder:text-ink-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10"
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setDeclining(false);
                  setReason('');
                }}
                className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-bold text-ink-700 transition hover:bg-ink-50"
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
          <div className="mt-4 flex flex-wrap justify-end gap-2.5 border-t border-ink-100 pt-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeclining(true)}
              className="rounded-xl border border-ink-200 px-4 py-2.5 text-sm font-bold text-ink-700 transition hover:border-rose-200 hover:text-rose-700 disabled:opacity-60"
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

function RequestsView({
  loading,
  isAdviser,
  requests,
  busyRequestId,
  onDecide,
  onBook,
  unreadByConsultation,
  onOpenThread,
}) {
  const pending = requests.filter((request) => request.status === 'pending').length;

  return (
    <div className="animate-rise">
      <div className="mb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">
          {isAdviser ? 'Consultation requests' : 'My requests'}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {isAdviser
            ? `${pending} ${pending === 1 ? 'request is' : 'requests are'} waiting for your approval. Nothing is on your schedule until you approve it.`
            : 'Requests you have sent. Your adviser has to approve one before it becomes an official session.'}
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[0, 1].map((key) => (
            <div key={key} className="h-56 skeleton rounded-2xl" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-100">
            <Inbox className="h-7 w-7 text-ink-400" aria-hidden="true" />
          </span>
          <p className="mt-4 font-bold text-ink-900">
            {isAdviser ? 'No requests waiting' : 'No pending requests'}
          </p>
          <p className="mt-1 text-sm text-ink-500">
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
              unread={unreadByConsultation?.[request.id] ?? 0}
              onOpenThread={onOpenThread}
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
    <section className="animate-rise rounded-2xl bg-white p-6 shadow-card ring-1 ring-ink-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold tracking-tight text-ink-900">
          Capstone milestones
        </h2>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
          {progress}%
        </span>
      </div>

      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-ink-100"
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
                    className={`h-5 w-5 shrink-0 ${current ? 'text-brand-600' : 'text-ink-300'}`}
                    aria-hidden="true"
                  />
                )}
                {index < MILESTONES.length - 1 ? (
                  <span
                    className={`my-0.5 w-0.5 flex-1 rounded-full ${done ? 'bg-emerald-200' : 'bg-ink-200'}`}
                  />
                ) : null}
              </div>
              <div className="pb-4">
                <p
                  className={`text-sm ${
                    done
                      ? 'font-semibold text-ink-700'
                      : current
                        ? 'font-bold text-brand-700'
                        : 'font-medium text-ink-400'
                  }`}
                >
                  {milestone}
                </p>
                <p className="text-xs text-ink-400">
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

function SchedulePanel({ schedule, loading, onBook, unreadByConsultation, onOpenThread }) {
  if (loading) return <div className="h-64 skeleton rounded-2xl" />;

  return (
    <section className="animate-rise rounded-2xl bg-white p-6 shadow-card ring-1 ring-ink-100">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold tracking-tight text-ink-900">Your schedule</h2>
        <button
          type="button"
          onClick={onBook}
          className="rounded-lg text-sm font-bold text-brand-700 hover:underline"
        >
          Add
        </button>
      </div>

      {schedule.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">
          No sessions booked with you yet. Students pick you from the adviser list when they book.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {schedule.map((item) => {
            const when = new Date(item.meeting_date);
            const unread = unreadByConsultation?.[item.id] ?? 0;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onOpenThread(item.id)}
                  className="flex w-full gap-3 rounded-xl p-1 text-left transition hover:bg-ink-50"
                >
                  <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-brand-50 leading-none">
                    <span className="text-[10px] font-bold uppercase text-brand-600">
                      {monthFormatter.format(when)}
                    </span>
                    <span className="text-base font-extrabold text-brand-800">
                      {when.getDate()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink-900">{item.topic}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                      <span className="font-semibold">{timeFormatter.format(when)}</span>
                      {item.group_name ? <span className="truncate">{item.group_name}</span> : null}
                    </p>
                  </div>
                  {unread > 0 ? (
                    <span className="mt-1 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[10px] font-bold text-white">
                      {unread > 9 ? '9+' : unread}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function AdviserPanel({ consultation, loading }) {
  if (loading) return <div className="h-40 skeleton rounded-2xl" />;

  return (
    <section className="animate-rise rounded-2xl bg-white p-6 shadow-card ring-1 ring-ink-100">
      <h2 className="text-base font-extrabold tracking-tight text-ink-900">Your adviser</h2>

      {consultation?.adviser_name ? (
        <div className="mt-4 flex items-center gap-3.5">
          <Avatar name={consultation.adviser_name} size="lg" />
          <div className="min-w-0">
            <p className="truncate font-bold text-ink-900">{consultation.adviser_name}</p>
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
              <p className="mt-1 text-xs text-ink-400">{consultation.group_name}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3.5 text-sm text-ink-500">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-ink-100">
            <User className="h-6 w-6 text-ink-400" aria-hidden="true" />
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
    <div className="animate-rise">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">Action items</h1>
          <p className="mt-1 text-sm text-ink-500">
            {query
              ? `${tasks.length} of ${totalCount} open ${totalCount === 1 ? 'task' : 'tasks'} match "${query}".`
              : `${totalCount} open ${totalCount === 1 ? 'task' : 'tasks'} from your consultations.`}
          </p>
        </div>
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            className="flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-ink-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Clear "{query}"
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="h-32 skeleton rounded-2xl" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        query ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
            <Search className="mx-auto h-9 w-9 text-ink-300" aria-hidden="true" />
            <p className="mt-3 font-bold text-ink-900">No match for "{query}"</p>
            <p className="mt-1 text-sm text-ink-500">Try a different word.</p>
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
    <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50">
        <CheckCircle2 className="h-7 w-7 text-emerald-500" aria-hidden="true" />
      </span>
      <p className="mt-4 font-bold text-ink-900">Nothing pending</p>
      <p className="mt-1 text-sm text-ink-500">
        Every action item from your consultations is resolved.
      </p>
    </div>
  );
}

function TaskCard({ task, busy, onResolve }) {
  // A real deadline, if the adviser set one when raising the item. The card used
  // to show the session date in this slot, which is where the task came from,
  // not when it is wanted.
  const due = task.due_date ? new Date(`${task.due_date}T00:00`) : null;
  const from = task.consultation_date ? new Date(task.consultation_date) : null;
  const overdue = due ? due < new Date(new Date().toDateString()) : false;

  return (
    <article className="animate-rise flex flex-col rounded-2xl bg-white p-5 shadow-card ring-1 ring-ink-100 transition duration-300 hover:-translate-y-1 hover:shadow-raised hover:ring-brand-200">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onResolve}
          disabled={busy}
          aria-label={`Mark "${task.task_description}" as resolved`}
          className="mt-0.5 shrink-0 rounded-full text-ink-300 transition hover:scale-110 hover:text-brand-700 disabled:opacity-50"
        >
          {busy ? (
            <CheckCircle2 className="h-5 w-5 animate-pulse text-brand-700" aria-hidden="true" />
          ) : (
            <Circle className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
        <p className="flex-1 text-sm font-semibold leading-snug text-ink-900">
          {task.task_description}
        </p>
      </div>

      {task.consultation_topic ? (
        <span className="mt-3 w-fit max-w-full truncate rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-bold text-ink-600">
          {task.consultation_topic}
        </span>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-100 pt-3 text-xs font-medium text-ink-500">
        {due ? (
          <span
            className={`flex items-center gap-1 font-bold ${
              overdue ? 'text-rose-600' : 'text-ink-600'
            }`}
          >
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            {overdue ? 'Overdue' : 'Due'} {shortDateFormatter.format(due)}
          </span>
        ) : from ? (
          <span className="flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            From {shortDateFormatter.format(from)}
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
    <div className="animate-rise max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight text-ink-900">My profile</h1>
      <p className="mt-1 text-sm text-ink-500">The details you registered with.</p>

      <section className="mt-6 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-ink-100">
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

        <dl className="divide-y divide-ink-100">
          {rows.map(([label, value, capitalized]) => (
            <div key={label} className="flex flex-wrap gap-2 px-6 py-4">
              <dt className="w-40 text-xs font-bold uppercase tracking-wide text-ink-400">
                {label}
              </dt>
              <dd
                className={`flex-1 break-all text-sm font-semibold text-ink-800 ${
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
        className="mt-6 inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-bold text-ink-700 transition hover:border-brand-200 hover:text-brand-700"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
