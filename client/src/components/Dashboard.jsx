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
  FileText,
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
import RecordView from './RecordView.jsx';
import ProposeTimeModal from './ProposeTimeModal.jsx';
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
    // The printable log a group hands in. Everything on it is already in the
    // database; this is the only way it gets out.
    { key: 'record', label: 'Consultation record', icon: FileText },
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
// For the three-across detail strip, where the long form overflows.
const detailDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

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
  // The consultation whose time is being renegotiated.
  const [proposeFor, setProposeFor] = useState(null);
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

  /**
   * Answering a counter-offer. Accepting is the only thing that actually moves
   * a consultation, so the whole dashboard is reloaded rather than patched --
   * the upcoming session, the schedule and the inbox all change at once.
   */
  async function decideProposal(item, decision) {
    if (busyRequestId) return;
    setBusyRequestId(item.id);
    setError('');
    setNotice('');

    try {
      await api(`/consultations/${item.id}/proposal`, {
        method: 'PATCH',
        token,
        body: { decision },
      });
      setNotice(
        decision === 'accepted'
          ? 'Time confirmed - the session is on the schedule.'
          : item.status === 'pending'
            ? 'Request closed. You can book another slot whenever you are ready.'
            : 'Declined - the original time still stands.',
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

  /** Either side calling a consultation off. */
  async function cancelConsultation(item, reason) {
    if (busyRequestId) return;
    setBusyRequestId(item.id);
    setError('');
    setNotice('');

    try {
      await api(`/consultations/${item.id}/cancel`, {
        method: 'PATCH',
        token,
        body: { reason },
      });
      setNotice('Cancelled. The other side can see your reason.');
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
  // `needs_you` is the server's answer to "whose move is it": an adviser who
  // has already counter-offered is waiting on the group, so the request leaves
  // their count rather than nagging them about their own offer.
  const pendingRequests = useMemo(
    () => requests.filter((request) => request.needs_you),
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
    <div className="min-h-screen bg-white">
      <div className="app-shell flex min-h-screen w-full">
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
            view={view}
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

          <main className="app-main scrollbar-slim flex-1 overflow-y-auto bg-canvas px-4 py-6 sm:px-7 sm:py-8">
            {error ? (
              <div
                role="alert"
                className="mb-6 flex items-start gap-2.5 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3.5 text-sm font-medium text-rose-700"
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
                className="mb-6 flex items-start gap-2.5 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3.5 text-sm font-medium text-emerald-800"
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
                myId={profile.id}
                onDecideProposal={decideProposal}
                onPropose={setProposeFor}
                onCancel={cancelConsultation}
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
                myId={profile.id}
                onDecideProposal={decideProposal}
                onPropose={setProposeFor}
                onCancelRequest={cancelConsultation}
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

            {view === 'record' ? (
              <RecordView token={token} isAdviser={isAdviser} profile={profile} />
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

      {proposeFor ? (
        <ProposeTimeModal
          token={token}
          consultation={proposeFor}
          isAdviser={isAdviser}
          onClose={() => setProposeFor(null)}
          onProposed={() => {
            setProposeFor(null);
            setError('');
            setNotice(
              isAdviser
                ? 'Offer sent. The slot is held until the group answers.'
                : 'Sent. Your adviser has to accept before the session moves.',
            );
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
          className="fixed inset-0 z-40 bg-ink-950/50 lg:hidden"
        />
      ) : null}

      {/*
        Near-black rather than crimson. A dark neutral rail lets the one
        institutional colour do its job -- it marks the current view and the
        primary action, instead of competing with itself across the whole panel.
      */}
      <aside
        className={`no-print fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col bg-ink-950 px-3 py-4 transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-[15.5rem] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-700 shadow-sm">
              <GraduationCap className="h-[18px] w-[18px] text-white" aria-hidden="true" />
            </span>
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold tracking-tight text-white">
                ConsultTrack
              </span>
              <span className="block text-[11px] text-ink-400">Holy Angel University</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-1.5 text-ink-400 transition hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </div>

        {/*
          The primary action sits above the nav, not inside a promo card at the
          bottom of it: booking is the thing people came to do, so it should be
          the first thing under the wordmark.
        */}
        <button
          type="button"
          onClick={onBook}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-3 py-2.5 text-[13px] font-semibold text-white transition hover:bg-brand-600 active:bg-brand-800"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          {isAdviser ? 'Schedule session' : 'Book consultation'}
        </button>

        <nav className="mt-7 flex flex-1 flex-col gap-0.5">
          <p className="mb-1.5 px-2 text-[11px] font-medium tracking-wide text-ink-500">Menu</p>
          {navItems(isAdviser).map(({ key, label, icon: Icon, badge }) => {
            const active = view === key;
            const count = badge ? requestCount : 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNavigate(key)}
                aria-current={active ? 'page' : undefined}
                className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition ${
                  active
                    ? 'bg-white/[0.08] font-semibold text-white'
                    : 'font-medium text-ink-400 hover:bg-white/[0.05] hover:text-ink-100'
                }`}
              >
                {/* A crimson rule on the active item, readable from the corner
                    of the eye without adding a second filled surface. */}
                <span
                  aria-hidden="true"
                  className={`absolute left-0 top-1/2 h-4.5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand-500 transition-opacity ${
                    active ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <Icon
                  className={`h-4 w-4 shrink-0 ${active ? 'text-brand-400' : 'text-ink-500 group-hover:text-ink-300'}`}
                  aria-hidden="true"
                />
                <span className="truncate">{label}</span>
                {count > 0 ? (
                  <span
                    className={`tnum ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${
                      active ? 'bg-brand-600 text-white' : 'bg-brand-600/90 text-white'
                    }`}
                  >
                    {count > 9 ? '9+' : count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="mt-4 border-t border-white/[0.08] pt-3">
          <button
            type="button"
            onClick={onSignOut}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink-400 transition hover:bg-white/[0.05] hover:text-ink-100"
          >
            <LogOut className="h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

/* ----------------------------------------------------------------- topbar -- */

function TopBar({
  view,
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
    .join(' · ');

  // The bar names the page. Without it the only cue for "where am I" is the
  // sidebar, which is off-screen on a phone exactly when it is needed most.
  const title = navItems(isAdviser).find((item) => item.key === view)?.label ?? 'Dashboard';

  return (
    <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-ink-200 bg-white/90 px-4 py-2.5 backdrop-blur-xl sm:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="-ml-1 rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-ink-900 lg:hidden">
        {title}
      </h1>

      <div className="relative hidden min-w-0 md:block md:w-64 lg:w-80">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search action items"
          aria-label="Search action items"
          className="w-full rounded-lg border border-ink-200 bg-ink-50 py-1.5 pl-9 pr-3 text-[13px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-700/15"
        />
      </div>

      <div className="ml-auto flex items-center gap-0.5 md:ml-3">
        <IconButton
          onClick={onRefresh}
          disabled={refreshing}
          label="Refresh dashboard"
          icon={RefreshCw}
          spin={refreshing}
        />

        {/* Unread messages, separate from the bell: the bell is about requests
            waiting on a decision, this is about somebody talking to you. */}
        <IconButton
          onClick={onOpenMessages}
          label={
            unreadTotal === 0
              ? 'No unread messages'
              : `${unreadTotal} unread ${unreadTotal === 1 ? 'message' : 'messages'}`
          }
          icon={MessageSquare}
          count={unreadTotal}
          countClass="bg-emerald-600"
        />

        {/* The bell is the consultation-request notification: for an adviser,
            requests awaiting their approval. */}
        <IconButton
          onClick={onBell}
          label={
            noticeCount === 0
              ? 'No consultation requests'
              : isAdviser
                ? `${noticeCount} consultation ${noticeCount === 1 ? 'request' : 'requests'} awaiting your approval`
                : `${noticeCount} consultation ${noticeCount === 1 ? 'request' : 'requests'} to review`
          }
          icon={Bell}
          count={noticeCount}
          countClass="bg-brand-700"
        />

        <span aria-hidden="true" className="mx-2 hidden h-5 w-px bg-ink-200 sm:block" />

        <div className="flex items-center gap-2.5">
          <Avatar name={profile.full_name || profile.email} />
          <div className="hidden leading-tight sm:block">
            <p className="max-w-[11rem] truncate text-[13px] font-semibold text-ink-900">
              {profile.full_name || profile.email}
            </p>
            <p className="max-w-[11rem] truncate text-[11px] text-ink-500">
              {subtitle || (profile.role ?? 'student')}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

/** One 32px icon control, optionally badged with a count. */
function IconButton({ onClick, disabled, label, icon: Icon, count = 0, countClass, spin }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="relative rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
    >
      <Icon className={`h-4 w-4 ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {count > 0 ? (
        <span
          className={`tnum absolute right-0.5 top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-semibold text-white ring-2 ring-white ${countClass}`}
        >
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </button>
  );
}

function Avatar({ name, size = 'md', onBrand = false }) {
  const initials = (name || '?')
    .replace(/[^\p{L}\s,]/gu, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

  const dimensions = size === 'lg' ? 'h-14 w-14 text-base' : 'h-8 w-8 text-[11px]';
  // On a crimson surface the crimson fill would disappear.
  const surface = onBrand ? 'bg-white/15 ring-1 ring-white/25' : 'bg-brand-700';

  return (
    <span
      aria-hidden="true"
      className={`flex ${dimensions} ${surface} shrink-0 items-center justify-center rounded-full font-semibold tracking-wide text-white`}
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
  myId,
  onDecideProposal,
  onPropose,
  onCancel,
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
      <HeroBanner displayName={displayName} isAdviser={isAdviser} />

      {/* An adviser with no published hours is still fielding guessed times. */}
      {isAdviser && !loading && hourBlocks === 0 ? (
        <PublishHoursPrompt onSetHours={onSetHours} />
      ) : null}

      {/* ------------------------------------------------------- stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          [0, 1, 2].map((key) => (
            <div key={key} className="h-32 skeleton rounded-xl" />
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
                      className="flex items-center gap-1 rounded-lg text-sm font-semibold text-brand-700 hover:underline"
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
                    myId={myId}
                    onDecideProposal={onDecideProposal}
                    onPropose={onPropose}
                    onCancel={onCancel}
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
              <div className="h-52 skeleton rounded-xl" />
            ) : (
              <ConsultationCard
                consultation={consultation}
                countdown={countdown}
                isAdviser={isAdviser}
                onBook={onBook}
                unread={unreadByConsultation?.[consultation?.id] ?? 0}
                onOpenThread={onOpenThread}
                onWrapUp={onWrapUp}
                myId={myId}
                onDecideProposal={onDecideProposal}
                onPropose={onPropose}
                onCancel={onCancel}
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
                    className="flex items-center gap-1 rounded-lg text-sm font-semibold text-brand-700 hover:underline"
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
                  <div key={key} className="h-32 skeleton rounded-xl" />
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
    <section className="animate-rise flex flex-wrap items-center gap-4 rounded-xl border border-gold-200 bg-gold-50/60 p-5">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gold-100 text-gold-700">
        <CalendarClock className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-bold tracking-tight text-ink-900">
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
        className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-ink-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800 active:scale-[0.99]"
      >
        Set my hours
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

/*
 * A page header, not a banner. The gradient slab this replaces spent the most
 * valuable strip of the screen on decoration; a greeting, the date and the one
 * action worth taking say the same thing in a third of the height and leave the
 * colour budget for the data underneath.
 */
function HeroBanner({ displayName, isAdviser }) {
  return (
    <section className="animate-rise flex flex-wrap items-end justify-between gap-4 border-b border-ink-200 pb-6">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-[13px] text-ink-500">
          <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          {todayFormatter.format(new Date())}
        </p>
        <h2 className="mt-1.5 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink-900">
          Welcome back, {displayName}
        </h2>
        <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-ink-500">
          {isAdviser
            ? 'Your consultation schedule and every action item still open across your groups.'
            : 'Where your capstone stands today — sessions, advisers and everything still open.'}
        </p>
      </div>

    </section>
  );
}

/*
 * The icon chip is the only colour on a tile, and it is the status colour --
 * so three tiles are told apart by one small mark each rather than by three
 * competing backgrounds and three gradient rules.
 */
const TONES = {
  indigo: 'bg-brand-50 text-brand-700',
  amber: 'bg-gold-50 text-gold-600',
  emerald: 'bg-emerald-50 text-emerald-600',
};

function StatTile({ icon: Icon, tone, label, value, hint, highlighted = false, delay = 0 }) {
  return (
    <article
      style={{ '--delay': `${delay}ms` }}
      className={`animate-rise rounded-xl border bg-white p-4 transition-colors ${
        highlighted ? 'border-brand-200 bg-brand-50/40' : 'border-ink-200 hover:border-ink-300'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-[12px] font-medium text-ink-500">
          <span className={`flex h-6 w-6 items-center justify-center rounded-md ${TONES[tone]}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          {label}
        </span>
        {highlighted ? (
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-800">
            Up next
          </span>
        ) : null}
      </div>
      <p className="tnum mt-3 text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink-900">
        {value}
      </p>
      <p className="mt-2 truncate text-[12px] text-ink-500">{hint}</p>
    </article>
  );
}

function ThreadButton({ unread = 0, onClick, label = 'Messages' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-xs font-semibold text-ink-700 transition hover:border-brand-300 hover:bg-brand-50/50 hover:text-brand-700"
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
      {unread > 0 ? (
        <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-semibold text-white">
          {unread > 9 ? '9+' : unread}
        </span>
      ) : null}
    </button>
  );
}

function SectionHeading({ title, action }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-base font-bold tracking-tight text-ink-900">{title}</h2>
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
  myId,
  onDecideProposal,
  onPropose,
  onCancel,
}) {
  // Declared before the early return below: hooks cannot sit behind a branch.
  const [cancelling, setCancelling] = useState(false);

  if (!consultation) {
    return (
      <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-6 py-12 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-ink-100">
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
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          {isAdviser ? 'Schedule a session' : 'Book consultation'}
        </button>
      </div>
    );
  }

  const meetingDate = new Date(consultation.meeting_date);

  return (
    <article className="animate-rise rounded-xl bg-white p-6 border border-ink-200 transition-colors hover:border-ink-300">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-ink-500">
            {consultation.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-xl font-bold tracking-tight text-ink-900">
            {consultation.topic}
          </h3>
        </div>
        <span className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700">
          {countdown}
        </span>
      </div>

      <dl className="mt-5 grid gap-4 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3.5 sm:grid-cols-3">
        <Detail icon={CalendarDays} label="Date" value={detailDateFormatter.format(meetingDate)} />
        <Detail icon={Clock} label="Time" value={timeFormatter.format(meetingDate)} />
        <Detail
          icon={MapPin}
          label="Location"
          value={consultation.location || 'To be announced'}
        />
      </dl>

      {/* A move somebody has asked for, but which has not happened yet -- the
          card still shows the agreed time above, because that is still the plan
          until the other side accepts. */}
      {consultation.proposal_live ? (
        <ProposalBanner
          item={consultation}
          myId={myId}
          busy={false}
          onDecide={onDecideProposal}
        />
      ) : null}

      {cancelling ? (
        <InlineReason
          id={`cancel-session-${consultation.id}`}
          label={isAdviser ? 'Why are you calling this off?' : 'Why are you cancelling?'}
          placeholder="e.g. A faculty meeting was moved onto that slot."
          confirmLabel="Call it off"
          tone="ink"
          busy={false}
          onCancel={() => setCancelling(false)}
          onConfirm={(reason) => {
            setCancelling(false);
            onCancel(consultation, reason);
          }}
        />
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-ink-200 pt-4">
        <ThreadButton unread={unread} onClick={() => onOpenThread(consultation.id)} />

        {!consultation.proposal_live ? (
          <>
            <button
              type="button"
              onClick={() => onPropose(consultation)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-xs font-semibold text-ink-700 transition hover:border-gold-300 hover:bg-gold-50 hover:text-gold-800"
            >
              <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
              Move
            </button>
            <button
              type="button"
              onClick={() => setCancelling(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-xs font-semibold text-ink-700 transition hover:border-rose-200 hover:text-rose-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Cancel
            </button>
          </>
        ) : null}

        {/* The adviser ran the session, so the adviser closes it. */}
        {isAdviser ? (
          <button
            type="button"
            onClick={() => onWrapUp(consultation.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99]"
          >
            <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
            Wrap up
          </button>
        ) : null}
        </div>
      )}
    </article>
  );
}

function Detail({ icon: Icon, label, value }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
      <div className="min-w-0">
        <dt className="text-[11px] text-ink-500">{label}</dt>
        <dd className="truncate text-[13px] font-medium text-ink-900">{value}</dd>
      </div>
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
/**
 * A live counter-offer, from whichever side is looking at it.
 *
 * The person who did NOT propose is the one who answers: letting someone accept
 * their own offer would let one side write into the other's diary.
 */
function ProposalBanner({ item, myId, busy, onDecide }) {
  const mine = item.proposed_by === myId;
  const when = new Date(item.proposed_date);

  if (mine) {
    return (
      <div className="mt-4 rounded-lg border border-gold-200 bg-gold-50 px-3.5 py-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gold-800">
          <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
          Waiting for them to confirm {dateFormatter.format(when)} at{' '}
          {timeFormatter.format(when)}
        </p>
        <p className="mt-1 text-xs text-gold-700">
          The slot is held until they answer, or until that time passes.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-lg border border-gold-300 bg-gold-50 px-3.5 py-3.5">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-gold-800">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
        {item.proposed_by_name || 'The other side'} suggested a different time
      </p>
      <p className="mt-1.5 text-sm font-semibold text-ink-900">
        {dateFormatter.format(when)} at {timeFormatter.format(when)}
      </p>
      {item.proposed_note ? (
        <p className="mt-1 text-sm text-ink-700">&ldquo;{item.proposed_note}&rdquo;</p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(item, 'declined')}
          className="rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:border-rose-200 hover:text-rose-700 disabled:opacity-60"
        >
          Can&apos;t make it
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(item, 'accepted')}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-4 w-4" aria-hidden="true" />
          )}
          Accept this time
        </button>
      </div>
    </div>
  );
}

/** A reason box, for the two actions that owe the other side an explanation. */
function InlineReason({ id, label, placeholder, confirmLabel, tone, busy, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  const confirmClass =
    tone === 'rose'
      ? 'bg-rose-600 hover:bg-rose-700'
      : 'bg-ink-800 hover:bg-ink-900';

  return (
    <div className="mt-4 border-t border-ink-200 pt-4">
      <label htmlFor={id} className="text-[12px] font-medium text-ink-700">
        {label}
      </label>
      <textarea
        id={id}
        rows={2}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15"
      />
      <div className="mt-3 flex flex-wrap justify-end gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-ink-200 px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
        >
          Back
        </button>
        <button
          type="button"
          disabled={busy || !reason.trim()}
          onClick={() => onConfirm(reason.trim())}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${confirmClass}`}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <X className="h-4 w-4" aria-hidden="true" />
          )}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * One request, from both sides of the approval.
 *
 * The adviser can approve, decline, or offer a different time -- that last one
 * is the realistic case: a group asks for 9am, the adviser teaches then. The
 * offer still goes back to the group to accept, because they picked 9am around
 * their own class timetable, and booking noon for them produces a no-show
 * rather than a meeting.
 */
function RequestCard({
  request,
  isAdviser,
  myId,
  busy,
  onDecide,
  onDecideProposal,
  onPropose,
  onCancel,
  unread = 0,
  onOpenThread,
}) {
  // null | 'declining' | 'cancelling'
  const [mode, setMode] = useState(null);

  const when = new Date(request.meeting_date);
  const declined = request.status === 'declined';
  const cancelled = request.status === 'cancelled';
  const closed = declined || cancelled;
  const proposalLive = Boolean(request.proposal_live);

  const statusChip = cancelled
    ? { label: 'Cancelled', tone: 'bg-ink-100 text-ink-600', Icon: X }
    : declined
      ? { label: 'Declined', tone: 'bg-rose-50 text-rose-700', Icon: X }
      : proposalLive
        ? { label: 'New time suggested', tone: 'bg-gold-50 text-gold-700 ring-1 ring-gold-200', Icon: CalendarClock }
        : {
            label: isAdviser ? 'Needs your approval' : 'Waiting for approval',
            tone: 'bg-gold-50 text-gold-700 ring-1 ring-gold-200',
            Icon: Hourglass,
          };

  return (
    <article
      className={`animate-rise relative overflow-hidden rounded-xl border bg-white p-5 transition-colors ${
        cancelled ? 'border-ink-200' : declined ? 'border-rose-200' : 'border-ink-200 hover:border-ink-300'
      }`}
    >

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-ink-500">
            {request.group_name || 'Consultation'}
          </p>
          <h3 className="mt-1.5 text-lg font-bold tracking-tight text-ink-900">
            {request.topic}
          </h3>
        </div>
        <span
          className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusChip.tone}`}
        >
          <statusChip.Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {statusChip.label}
        </span>
      </div>

      <dl className="mt-4 grid gap-4 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-3.5 sm:grid-cols-3">
        <Detail icon={CalendarDays} label="Date" value={detailDateFormatter.format(when)} />
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
        <p className="mt-4 rounded-lg bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-800">
          <span className="font-bold">Adviser&apos;s note: </span>
          {request.decline_reason}
        </p>
      ) : null}

      {cancelled && request.cancel_reason ? (
        <p className="mt-4 rounded-lg bg-ink-100 px-3.5 py-3 text-sm font-medium text-ink-700">
          <span className="font-bold">Called off: </span>
          {request.cancel_reason}
        </p>
      ) : null}

      {proposalLive ? (
        <ProposalBanner
          item={request}
          myId={myId}
          busy={busy}
          onDecide={onDecideProposal}
        />
      ) : null}

      {/* ------------------------------------------------ the decision --- */}
      {mode === 'declining' ? (
        <InlineReason
          id={`decline-${request.id}`}
          label="Why are you declining?"
          placeholder="e.g. That chapter is not ready for review yet."
          confirmLabel="Send decline"
          tone="rose"
          busy={busy}
          onCancel={() => setMode(null)}
          onConfirm={(reason) => onDecide(request, 'declined', reason)}
        />
      ) : mode === 'cancelling' ? (
        <InlineReason
          id={`cancel-${request.id}`}
          label={isAdviser ? 'Why are you calling this off?' : 'Why are you withdrawing?'}
          placeholder="e.g. We are not ready — we will rebook next week."
          confirmLabel={isAdviser ? 'Call it off' : 'Withdraw request'}
          tone="ink"
          busy={busy}
          onCancel={() => setMode(null)}
          onConfirm={(reason) => onCancel(request, reason)}
        />
      ) : onOpenThread || (!closed && !proposalLive) ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-200 pt-4">
          {onOpenThread ? (
            <ThreadButton
              unread={unread}
              onClick={() => onOpenThread(request.id)}
              label={closed ? 'Reply' : 'Messages'}
            />
          ) : null}
          {isAdviser && !closed && !proposalLive && request.status === 'pending' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setMode('declining')}
                className="ml-auto rounded-lg border border-ink-200 px-3.5 py-2 text-[13px] font-semibold text-ink-700 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-60"
              >
                Decline
              </button>
              {/* The realistic middle answer: not no, just not then. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => onPropose(request)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-[13px] font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50 disabled:opacity-60"
              >
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                Offer another time
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(request, 'approved')}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                Approve
              </button>
            </>
          ) : null}

          {/* A group that no longer needs the slot should give it back. */}
          {!isAdviser && !closed && !proposalLive && request.status === 'pending' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('cancelling')}
              className="ml-auto rounded-lg border border-ink-200 px-3.5 py-2 text-[13px] font-semibold text-ink-700 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-60"
            >
              Withdraw request
            </button>
          ) : null}
        </div>
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
  myId,
  onDecideProposal,
  onPropose,
  onCancelRequest,
}) {
  const pending = requests.filter((request) => request.status === 'pending').length;

  return (
    <div className="animate-rise">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-900">
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
            <div key={key} className="h-56 skeleton rounded-xl" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-ink-100">
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
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-800"
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
              myId={myId}
              onDecideProposal={onDecideProposal}
              onPropose={onPropose}
              onCancel={onCancelRequest}
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
    <section className="animate-rise rounded-xl bg-white p-6 border border-ink-200">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold tracking-tight text-ink-900">
          Capstone milestones
        </h2>
        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
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
          className="h-full rounded-full bg-brand-600 transition-[width] duration-500"
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
  if (loading) return <div className="h-64 skeleton rounded-xl" />;

  return (
    <section className="animate-rise rounded-xl bg-white p-6 border border-ink-200">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold tracking-tight text-ink-900">Your schedule</h2>
        <button
          type="button"
          onClick={onBook}
          className="rounded-lg text-sm font-semibold text-brand-700 hover:underline"
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
                  className="flex w-full gap-3 rounded-lg p-1 text-left transition hover:bg-ink-50"
                >
                  <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-lg bg-brand-50 leading-none">
                    <span className="text-[10px] font-semibold uppercase text-brand-600">
                      {monthFormatter.format(when)}
                    </span>
                    <span className="text-base font-bold text-brand-800">
                      {when.getDate()}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-900">{item.topic}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                      <span className="font-semibold">{timeFormatter.format(when)}</span>
                      {item.group_name ? <span className="truncate">{item.group_name}</span> : null}
                    </p>
                  </div>
                  {unread > 0 ? (
                    <span className="mt-1 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold text-white">
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
  if (loading) return <div className="h-40 skeleton rounded-xl" />;

  return (
    <section className="animate-rise rounded-xl bg-white p-6 border border-ink-200">
      <h2 className="text-base font-bold tracking-tight text-ink-900">Your adviser</h2>

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
          <h1 className="text-2xl font-bold tracking-tight text-ink-900">Action items</h1>
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
            className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-ink-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            Clear "{query}"
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="h-32 skeleton rounded-xl" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        query ? (
          <div className="rounded-xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
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
    <div className="rounded-xl border border-dashed border-ink-300 bg-white px-6 py-12 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-50">
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
    <article className="animate-rise flex flex-col rounded-xl bg-white p-5 border border-ink-200 transition-colors hover:border-ink-300">
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
        <span className="mb-4 mt-3 w-fit max-w-full truncate rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600">
          {task.consultation_topic}
        </span>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-200 pt-3 text-xs font-medium text-ink-500">
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
      <h1 className="text-2xl font-bold tracking-tight text-ink-900">My profile</h1>
      <p className="mt-1 text-sm text-ink-500">The details you registered with.</p>

      <section className="mt-6 overflow-hidden rounded-xl bg-white border border-ink-200">
        <div className="flex flex-wrap items-center gap-4 bg-brand-700 px-6 py-6">
          <Avatar name={profile.full_name || profile.email} size="lg" onBrand />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold tracking-tight text-white">
              {profile.full_name || profile.email}
            </p>
            <p className="truncate text-[13px] text-brand-100">
              {(profile.role === 'adviser'
                ? [profile.faculty_position || 'Adviser', profile.department]
                : [profile.year_level, profile.course]
              )
                .filter(Boolean)
                .join(' - ') || (profile.role ?? 'student')}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25">
              {profile.role === 'adviser' ? (
                <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {profile.role === 'adviser' ? 'Adviser' : 'Student'}
            </span>
            {profile.email_verified_at ? (
              <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Email verified
              </span>
            ) : null}
          </div>
        </div>

        <dl className="divide-y divide-ink-200">
          {rows.map(([label, value, capitalized]) => (
            <div key={label} className="flex flex-wrap gap-2 px-6 py-4">
              <dt className="w-40 text-[13px] text-ink-500">{label}</dt>
              <dd
                className={`flex-1 break-all text-[13px] font-medium text-ink-900 ${
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
        className="mt-6 inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 transition hover:border-brand-200 hover:text-brand-700"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        Sign out
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
