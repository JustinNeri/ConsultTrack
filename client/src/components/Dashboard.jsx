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
  ChevronDown,
  FileText,
  Circle,
  Clock,
  GraduationCap,
  History,
  Hourglass,
  Inbox,
  LayoutDashboard,
  ClipboardList,
  Users2,
  CalendarRange,
  Building2,
  ListChecks,
  Lightbulb,
  Pencil,
  Loader2,
  Lock,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
  MessagesSquare,
  Menu,
  RefreshCw,
  Search,
  TrendingUp,
  User,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import Logo from './Logo.jsx';
import BookingModal from './BookingModal.jsx';
import AvailabilityView from './AvailabilityView.jsx';
import ConsultationThread from './ConsultationThread.jsx';
import CompleteSessionModal from './CompleteSessionModal.jsx';
import HistoryView from './HistoryView.jsx';
import RecordView from './RecordView.jsx';
import ProposeTimeModal from './ProposeTimeModal.jsx';
import GroupView from './GroupView.jsx';
import CalendarView from './CalendarView.jsx';
import CoordinatorView from './CoordinatorView.jsx';
import { api } from '../lib/api.js';
import { toDateInput, upcomingDatesFor } from '../lib/schedule.js';
import { MILESTONE_ACTIONS, readMilestones } from '../lib/milestones.js';
import { DEPARTMENTS, FACULTY_POSITIONS, YEAR_LEVELS } from '../lib/hau.js';

/** "2h ago", "3d ago", then a date once it stops being recent. */
function relativeTime(value) {
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDateFormatter.format(then);
}

/**
 * The sidebar only lists views this app can actually render, grouped the way
 * the design groups them: what you do daily, what you hand in, and your account.
 */
function navSections(isAdviser, isCoordinator = false) {
  return [
    {
      label: 'Main',
      items: [
        { key: 'overview', label: 'Dashboard', icon: LayoutDashboard },
        // An adviser answers requests; a student watches their own.
        { key: 'requests', label: isAdviser ? 'Requests' : 'My requests', icon: Inbox, badge: 'requests' },
        { key: 'tasks', label: 'Action items', icon: ListChecks, badge: 'tasks' },
        // A student's group is the thing every consultation hangs off, so it
        // sits with the daily work rather than under Account.
        ...(isAdviser ? [] : [{ key: 'group', label: 'My group', icon: Users2 }]),
        // Only an adviser has hours to publish; a student books out of them.
        ...(isAdviser
          ? [
              { key: 'calendar', label: 'Calendar', icon: CalendarRange },
              { key: 'availability', label: 'Consultation hours', icon: CalendarClock },
            ]
          : []),
        // Where a session goes once it has happened, and where an adviser
        // finishes wrapping one up.
        { key: 'history', label: 'Past sessions', icon: History },
      ],
    },
    // A coordinator is an adviser who also runs the program, so their views are
    // an extra section rather than a different sidebar.
    ...(isCoordinator
      ? [
          {
            label: 'Program',
            items: [{ key: 'coordinator', label: 'Capstone program', icon: Building2 }],
          },
        ]
      : []),
    {
      label: 'Records',
      // The printable log a group hands in. Everything on it is already in the
      // database; this is the only way it gets out.
      items: [{ key: 'record', label: 'Consultation record', icon: FileText }],
    },
    {
      label: 'Account',
      items: [{ key: 'profile', label: 'My profile', icon: UserRound }],
    },
  ];
}

/** Flat list, for anything that just needs to look a view up by key. */
function navItems(isAdviser, isCoordinator = false) {
  return navSections(isAdviser, isCoordinator).flatMap((section) => section.items);
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
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
// The slot chips: "Thu, Sep 11".
const slotDayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
// For the three-across detail strip, where the long form overflows.
const detailDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export default function Dashboard({ session, onSignOut, onProfileChanged }) {
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
  // Sessions already held, which is what the activity feed is built out of.
  const [history, setHistory] = useState([]);
  // The department adviser directory, and the open slots of whichever of them
  // is this group's adviser.
  const [directory, setDirectory] = useState([]);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // The group's real capstone progress, as rows of completed milestones.
  const [milestoneRows, setMilestoneRows] = useState([]);
  // The student's thesis group, or null while they have not joined one.
  const [group, setGroup] = useState(null);
  // The capstone sequence their department is measured against.
  const [milestoneSequence, setMilestoneSequence] = useState([]);
  // Bumped to make the history view re-read itself after a wrap-up.
  const [historyKey, setHistoryKey] = useState(0);
  const [view, setView] = useState('overview');
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);

  const profile = session.profile ?? {};
  const token = session.access_token;
  const isAdviser = profile.role === 'adviser';
  const isCoordinator = Boolean(profile.is_coordinator);

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
        const [
          nextResult,
          tasksResult,
          requestsResult,
          scheduleResult,
          hoursResult,
          historyResult,
          advisersResult,
          milestonesResult,
          groupResult,
          sequenceResult,
        ] = await Promise.all([
          api('/consultations/next', { token }),
          api('/tasks/pending', { token }),
          api('/consultations/requests', { token }),
          isAdviser ? api('/consultations?limit=6', { token }) : Promise.resolve(null),
          isAdviser ? api('/availability', { token }) : Promise.resolve(null),
          // Recent sessions feed the activity list on both sides.
          api('/consultations/history?limit=6', { token }).catch(() => null),
          // Only a student needs the directory: it is where the adviser's
          // faculty position and department come from.
          isAdviser ? Promise.resolve(null) : api('/advisers', { token }).catch(() => null),
          // A student's own group progress. An adviser has many groups, so
          // theirs is read per group on the session they are wrapping up.
          isAdviser ? Promise.resolve(null) : api('/milestones', { token }).catch(() => null),
          // Which thesis group they are in, if any. Everything a student books
          // belongs to it, so the dashboard has to know before it offers to.
          isAdviser
            ? Promise.resolve(null)
            : api('/thesis-groups/mine', { token }).catch(() => null),
          // Which steps this department uses. Rows now, not a constant.
          api('/program-milestones', { token }).catch(() => null),
        ]);
        setConsultation(nextResult.consultation);
        setTasks(tasksResult.tasks ?? []);
        setRequests(requestsResult.requests ?? []);
        setSchedule(scheduleResult?.consultations ?? []);
        setHourBlocks(hoursResult ? (hoursResult.availability ?? []).length : null);
        setHistory(historyResult?.consultations ?? []);
        setDirectory(advisersResult?.advisers ?? []);
        setMilestoneRows(milestonesResult?.milestones ?? []);
        setGroup(groupResult?.group ?? null);
        setMilestoneSequence(sequenceResult?.milestones ?? []);
        // The signed-in profile carries group_name and section, both of which
        // move when a group does. Cheap to re-read, and wrong if we do not.
        api('/me', { token })
          .then((result) => onProfileChanged?.(result.profile))
          .catch(() => {});
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
  /**
   * Every "book a consultation" button in the app goes through here.
   *
   * A student with no thesis group has nothing to attach a booking to, so they
   * are sent to set one up rather than to a form the API would refuse.
   */
  function startBooking() {
    // `group` is null until the first load answers, so without the loading
    // guard an early click sent a student who does have a group to the group
    // screen anyway.
    if (loading) return;
    if (!isAdviser && !group) {
      setView('group');
      return;
    }
    setBookingOpen(true);
  }

  function handleSearch(value) {
    // Typing no longer drags you to the action-items page. That made sense when
    // search only filtered that one list; now the results panel spans every
    // record, and jumping the page out from under a half-typed word is worse
    // than useless. Results navigate when you pick one.
    setQuery(value);
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

  /**
   * Who this group's adviser is. A student is not assigned one in the schema --
   * they pick when booking -- so the adviser is whoever their live consultation
   * is with, else whoever ran the last session, else the only adviser in their
   * department. Anything less certain than that resolves to null, and the card
   * says so rather than guessing.
   */
  const adviserRecord = useMemo(() => {
    if (isAdviser) return null;
    const email =
      consultation?.adviser_email ??
      history.find((item) => item.adviser_email)?.adviser_email ??
      null;

    if (email) {
      const match = directory.find((item) => item.email === email);
      if (match) return match;
      // Known from the consultation but missing from the directory (a different
      // department, or a directory call that failed). Name and email are still
      // real; the rest of the card degrades.
      return {
        id: null,
        full_name: consultation?.adviser_name ?? history.find((i) => i.adviser_email === email)?.adviser_name ?? null,
        email,
      };
    }
    return directory.length === 1 ? directory[0] : null;
  }, [consultation, directory, history, isAdviser]);

  const adviserId = adviserRecord?.id ?? null;

  /*
   * The adviser's next open slots. `weekdays` comes back on every slot call, so
   * one probe tells us which days are worth asking about and the loop stops as
   * soon as it has four -- usually two or three requests, not fourteen.
   */
  useEffect(() => {
    if (isAdviser || !adviserId) {
      setSlots([]);
      return undefined;
    }
    const controller = new AbortController();
    setSlotsLoading(true);

    (async () => {
      try {
        const today = toDateInput(new Date());
        const probe = await api(`/advisers/${adviserId}/slots?date=${today}`, {
          token,
          signal: controller.signal,
        });
        const weekdays = probe.weekdays ?? [];
        if (weekdays.length === 0) {
          setSlots([]);
          return;
        }

        const open = [];
        const now = Date.now();
        // upcomingDatesFor yields Date objects; the endpoint wants YYYY-MM-DD.
        for (const cursor of upcomingDatesFor(weekdays, 6)) {
          if (open.length >= 4) break;
          const date = toDateInput(cursor);
          const day =
            date === today
              ? probe
              : await api(`/advisers/${adviserId}/slots?date=${date}`, {
                  token,
                  signal: controller.signal,
                });
          for (const slot of day.slots ?? []) {
            if (slot.taken || new Date(slot.start).getTime() <= now) continue;
            open.push(slot);
            if (open.length >= 4) break;
          }
        }
        setSlots(open);
      } catch (err) {
        // A directory or slot failure must not take the dashboard down with it.
        if (err.name !== 'AbortError') setSlots([]);
      } finally {
        setSlotsLoading(false);
      }
    })();

    return () => controller.abort();
  }, [adviserId, isAdviser, token]);

  const adviser = useMemo(
    () => (adviserRecord ? { ...adviserRecord, availableFrom: slots[0]?.start ?? null } : null),
    [adviserRecord, slots],
  );

  /*
   * The activity feed. There is no activity table, so every row is derived from
   * a record the API already returned: a request raised or answered, a session
   * wrapped up, a thread with something unread. Nothing here is synthesised.
   */
  const activity = useMemo(() => {
    const rows = [];

    for (const request of requests) {
      if (request.responded_at && request.status === 'declined') {
        rows.push({
          id: `declined-${request.id}`,
          at: request.responded_at,
          icon: X,
          tone: 'bg-rose-50 text-rose-600',
          title: 'Consultation declined',
          detail: request.topic,
        });
      } else if (request.created_at) {
        rows.push({
          id: `requested-${request.id}`,
          at: request.created_at,
          icon: CalendarPlus,
          // A submitted request is waiting on a decision, and waiting is gold
          // everywhere else in the app. It was the last blue left.
          tone: 'bg-gold-50 text-gold-700',
          title: isAdviser ? 'New consultation request' : 'Consultation request submitted',
          detail: request.topic,
        });
      }
    }

    for (const session of history) {
      if (session.completed_at) {
        rows.push({
          id: `completed-${session.id}`,
          at: session.completed_at,
          icon: ClipboardList,
          tone: 'bg-emerald-50 text-emerald-600',
          title: 'Session wrapped up',
          detail: session.topic,
        });
      }
    }

    rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // Unread threads carry no timestamp of their own, so they sit at the top as
    // a state rather than an event, and show no relative time.
    const unreadRows = unread.threads.slice(0, 2).map((thread) => ({
      id: `unread-${thread.consultation_id}`,
      icon: MessagesSquare,
      tone: 'bg-brand-50 text-brand-700',
      title: `${thread.unread} unread ${thread.unread === 1 ? 'message' : 'messages'}`,
      detail: thread.topic,
      when: '',
    }));

    return [...unreadRows, ...rows.map((row) => ({ ...row, when: relativeTime(row.at) }))].slice(
      0,
      5,
    );
  }, [history, isAdviser, requests, unread.threads]);

  /*
   * Search now asks the server.
   *
   * It used to filter the rows this dashboard had already loaded, which meant a
   * search for a session from last term, a message, or a task somebody had since
   * ticked off found nothing at all -- the box said "search anything" and meant
   * "search what is on screen". One endpoint, scoped by the same visibility
   * rules as everything else.
   */
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setSearchResults([]);
      return undefined;
    }

    const controller = new AbortController();
    // Typing is faster than the network; without this every keystroke races.
    const timer = setTimeout(() => {
      api(`/search?q=${encodeURIComponent(term)}`, { token, signal: controller.signal })
        .then((result) => setSearchResults(flattenSearch(result.results, { goTo, setThreadId })))
        .catch((err) => {
          if (err.name !== 'AbortError') setSearchResults([]);
        });
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, token]);

  const milestones = useMemo(
    () => readMilestones(milestoneRows, milestoneSequence),
    [milestoneRows, milestoneSequence],
  );
  const progress = milestones.progress;
  const nextMilestone = milestones.next;
  const firstName = profile.first_name || (profile.full_name || '').split(',').pop()?.trim();
  const displayName = firstName || profile.email || 'there';

  return (
    <div className="min-h-screen bg-white">
      <div className="app-shell flex min-h-screen w-full">
        <Sidebar
          view={view}
          isAdviser={isAdviser}
          isCoordinator={isCoordinator}
          requestCount={noticeCount}
          taskCount={tasks.length}
          onNavigate={goTo}
          onSignOut={onSignOut}
          onBook={() => {
            startBooking();
            setNavOpen(false);
          }}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            view={view}
            profile={profile}
            isCoordinator={isCoordinator}
            query={query}
            onSearch={handleSearch}
            results={searchResults}
            noticeCount={noticeCount}
            isAdviser={isAdviser}
            refreshing={refreshing}
            onRefresh={() => loadDashboard({ silent: true })}
            onBell={() => goTo('requests')}
            onOpenNav={() => setNavOpen(true)}
            unreadTotal={unread.total}
            onNavigate={goTo}
            onSignOut={onSignOut}
            // The busiest thread is the one worth opening first; the list is
            // already ordered by unread count.
            onOpenMessages={() => {
              const busiest = unread.threads[0];
              if (busiest) setThreadId(busiest.consultation_id);
              else goTo('history');
            }}
          />

          <main className="app-main scrollbar-slim flex-1 overflow-y-auto bg-canvas px-4 pb-24 pt-6 sm:px-7 sm:py-8 lg:pb-8">
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
                onBook={startBooking}
                onSeeAllTasks={() => goTo('tasks')}
                progress={progress}
                nextMilestone={nextMilestone}
                completedMilestones={milestones.completed}
                milestoneSteps={milestones.steps}
                hourBlocks={hourBlocks}
                onSetHours={() => goTo('availability')}
                unreadByConsultation={unreadByConsultation}
                onOpenThread={setThreadId}
                onWrapUp={setWrapUpId}
                myId={profile.id}
                onDecideProposal={decideProposal}
                onPropose={setProposeFor}
                onCancel={cancelConsultation}
                adviser={adviser}
                slots={slots}
                slotsLoading={slotsLoading}
                activity={activity}
                onSeeAllHistory={() => goTo('history')}
                group={group}
                onOpenGroup={() => goTo('group')}
              />
            ) : null}

            {view === 'requests' ? (
              <RequestsView
                loading={loading}
                isAdviser={isAdviser}
                requests={requests}
                busyRequestId={busyRequestId}
                onDecide={decideRequest}
                onBook={startBooking}
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
              <RecordView token={token} isAdviser={isAdviser} />
            ) : null}

            {view === 'calendar' && isAdviser ? (
              <CalendarView
                token={token}
                onOpenConsultation={setThreadId}
                onBook={startBooking}
              />
            ) : null}

            {view === 'coordinator' && isCoordinator ? (
              <CoordinatorView token={token} profile={profile} />
            ) : null}

            {view === 'group' && !isAdviser ? (
              <GroupView
                profile={{ ...profile, token }}
                // Joining or leaving changes which consultations are visible,
                // so the whole dashboard is stale afterwards.
                onGroupChanged={() => loadDashboard({ silent: true })}
              />
            ) : null}

            {view === 'profile' ? (
              <ProfileView
                token={token}
                refreshToken={session.refresh_token}
                profile={profile}
                onSignOut={onSignOut}
                onProfileChanged={onProfileChanged}
              />
            ) : null}
          </main>

          <MobileTabBar
            view={view}
            isAdviser={isAdviser}
            requestCount={noticeCount}
            taskCount={tasks.length}
            onNavigate={goTo}
            onBook={startBooking}
          />
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
          group={group}
          defaultGroupName={profile.group_name}
          onClose={() => setBookingOpen(false)}
          onCreated={(created, outcome) => {
            setBookingOpen(false);
            setError('');
            // The booking itself succeeded either way; a failed attachment is a
            // warning about the file, not about the session.
            if (outcome?.warning) setError(outcome.warning);
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

function Sidebar({
  view,
  isAdviser,
  isCoordinator,
  requestCount,
  taskCount,
  onNavigate,
  onSignOut,
  onBook,
  open,
  onClose,
}) {
  const counts = { requests: requestCount, tasks: taskCount };

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

      <aside
        className={`no-print fixed inset-y-0 left-0 z-50 flex w-[17rem] flex-col bg-gradient-to-b from-brand-900 to-brand-950 px-3 py-4 transition-transform duration-200 ease-out lg:static lg:z-auto lg:w-[15.5rem] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2.5">
            <Logo className="h-9 w-9 shrink-0" />
            <span className="leading-tight">
              <span className="block text-h3 font-semibold tracking-tight text-white">
                ConsultTrack
              </span>
              <span className="block text-small text-brand-200/80">Holy Angel University</span>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-md p-1.5 text-brand-200 transition hover:bg-white/10 hover:text-white lg:hidden"
          >
            <X className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </div>

        {/*
          The primary action sits above the nav: booking is the thing people
          came to do, so it should be the first thing under the wordmark.
        */}
        <button
          type="button"
          onClick={onBook}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-3 py-2.5 text-body font-semibold text-white ring-1 ring-white/10 transition hover:bg-brand-600 active:bg-brand-800"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          {isAdviser ? 'Schedule session' : 'Book consultation'}
        </button>

        <nav className="scrollbar-slim mt-6 flex flex-1 flex-col gap-5 overflow-y-auto">
          {navSections(isAdviser, isCoordinator).map((section) => (
            <div key={section.label}>
              <p className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-brand-300/60">
                {section.label}
              </p>
              <div className="flex flex-col gap-0.5">
                {section.items.map(({ key, label, icon: Icon, badge }) => {
                  const active = view === key;
                  const count = badge ? (counts[badge] ?? 0) : 0;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onNavigate(key)}
                      aria-current={active ? 'page' : undefined}
                      className={`group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-body transition ${
                        active
                          ? 'bg-brand-700 font-semibold text-white'
                          : 'font-medium text-brand-100/70 hover:bg-white/[0.07] hover:text-white'
                      }`}
                    >
                      <Icon
                        className={`h-4 w-4 shrink-0 ${active ? 'text-white' : 'text-brand-200/60 group-hover:text-brand-100'}`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{label}</span>
                      {count > 0 ? (
                        <span
                          className={`tnum ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${
                            active ? 'bg-white/20 text-white' : 'bg-brand-600 text-white'
                          }`}
                        >
                          {count > 9 ? '9+' : count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* The institution the app belongs to, and its motto. */}
        <div className="mt-4 flex items-center gap-2.5 border-t border-white/[0.08] px-2.5 pt-4">
          <HauCrest />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-small font-medium text-brand-100/80">
              Holy Angel University
            </span>
            <span className="block truncate text-[10px] text-brand-300/60">
              Veritas &middot; Fortitudo &middot; Caritas
            </span>
          </span>
        </div>

        {/* Sign out also lives in the account menu; on a phone that menu is a
            reach away, so the rail keeps its own. */}
        <button
          type="button"
          onClick={onSignOut}
          className="mt-3 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-body font-medium text-brand-100/70 transition hover:bg-white/[0.07] hover:text-white lg:hidden"
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          Sign out
        </button>
      </aside>
    </>
  );
}

/**
 * The phone navigation. The sidebar is a drawer on small screens, which is one
 * tap too many for the four places people actually move between, so those get a
 * permanent bar and booking gets the raised button in the middle of it.
 */
function MobileTabBar({ view, isAdviser, requestCount, taskCount, onNavigate, onBook }) {
  const tabs = [
    { key: 'overview', label: 'Home', icon: LayoutDashboard, count: 0 },
    {
      key: 'requests',
      label: isAdviser ? 'Requests' : 'Requests',
      icon: Inbox,
      count: requestCount,
    },
    { key: 'tasks', label: 'Tasks', icon: ListChecks, count: taskCount },
    { key: 'profile', label: 'Profile', icon: UserRound, count: 0 },
  ];

  return (
    <nav
      aria-label="Main"
      className="no-print fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-ink-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
    >
      {tabs.slice(0, 2).map((tab) => (
        <MobileTab key={tab.key} tab={tab} active={view === tab.key} onNavigate={onNavigate} />
      ))}

      <div className="relative flex w-16 shrink-0 justify-center">
        <button
          type="button"
          onClick={onBook}
          aria-label={isAdviser ? 'Schedule a session' : 'Book a consultation'}
          className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-brand-700 text-white shadow-raised transition hover:bg-brand-600 active:bg-brand-800"
        >
          <CalendarPlus className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {tabs.slice(2).map((tab) => (
        <MobileTab key={tab.key} tab={tab} active={view === tab.key} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

function MobileTab({ tab, active, onNavigate }) {
  const { key, label, icon: Icon, count } = tab;
  return (
    <button
      type="button"
      onClick={() => onNavigate(key)}
      aria-current={active ? 'page' : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition ${
        active ? 'font-semibold text-brand-700' : 'font-medium text-ink-500'
      }`}
    >
      <span className="relative">
        <Icon className="h-5 w-5" aria-hidden="true" />
        {count > 0 ? (
          <span className="tnum absolute -right-1.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand-700 px-1 text-[9px] font-semibold text-white">
            {count > 9 ? '9+' : count}
          </span>
        ) : null}
      </span>
      {label}
    </button>
  );
}

/** A small shield mark, so the footer reads as the university and not as chrome. */
function HauCrest() {
  return (
    <svg
      viewBox="0 0 24 28"
      aria-hidden="true"
      className="h-7 w-6 shrink-0 text-brand-300/70"
    >
      <path
        d="M12 1.5 22 5v9.5c0 6-4.2 10.2-10 12.2C6.2 24.7 2 20.5 2 14.5V5z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M12 8.2 17 10.6 12 13l-5-2.4z M8.4 12.2v3.1c0 1.4 1.6 2.4 3.6 2.4s3.6-1 3.6-2.4v-3.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ----------------------------------------------------------------- topbar -- */

function TopBar({
  view,
  profile,
  isCoordinator,
  query,
  onSearch,
  results,
  noticeCount,
  isAdviser,
  refreshing,
  onRefresh,
  onBell,
  onOpenNav,
  unreadTotal,
  onOpenMessages,
  onNavigate,
  onSignOut,
}) {
  // The bar names the page wherever the sidebar is off-screen, which is the
  // only place the current view is not already marked.
  const title =
    navItems(isAdviser, isCoordinator).find((item) => item.key === view)?.label ?? 'Dashboard';

  return (
    <header className="no-print sticky top-0 z-30 flex items-center gap-3 border-b border-ink-200 bg-white px-4 py-2.5 sm:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="-ml-1 rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <h1 className="shrink-0 text-h3 font-semibold tracking-tight text-ink-900 lg:hidden">
        {title}
      </h1>

      <GlobalSearch query={query} onSearch={onSearch} results={results} />

      <div className="ml-auto flex items-center gap-1">
        <IconButton
          onClick={onRefresh}
          disabled={refreshing}
          label="Refresh dashboard"
          icon={RefreshCw}
          spin={refreshing}
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
          countClass="bg-brand-700"
        />

        <AccountMenu profile={profile} onNavigate={onNavigate} onSignOut={onSignOut} />
      </div>
    </header>
  );
}

/**
 * Turns the endpoint's four lists into the flat, grouped rows the panel draws.
 *
 * Kept out of the component so the shape of a result -- what it is called, what
 * opening it does -- lives in one place rather than in a render.
 */
function flattenSearch(results, { goTo, setThreadId }) {
  if (!results) return [];
  const rows = [];

  for (const item of results.consultations ?? []) {
    rows.push({
      id: `consultation-${item.id}`,
      group: item.status === 'completed' ? 'Past sessions' : 'Consultations',
      icon: CalendarDays,
      title: item.topic,
      detail: [item.group_name, dateFormatter.format(new Date(item.meeting_date))]
        .filter(Boolean)
        .join(' \u00b7 '),
      open: () => setThreadId(item.id),
    });
  }

  for (const item of results.tasks ?? []) {
    rows.push({
      id: `task-${item.id}`,
      group: 'Action items',
      icon: ListChecks,
      title: item.task_description,
      detail: [item.consultation_topic, item.status === 'resolved' ? 'resolved' : null]
        .filter(Boolean)
        .join(' \u00b7 '),
      open: () => goTo('tasks'),
    });
  }

  for (const item of results.messages ?? []) {
    rows.push({
      id: `message-${item.id}`,
      group: 'Messages',
      icon: MessagesSquare,
      title: item.body,
      detail: [item.sender_name, item.topic].filter(Boolean).join(' \u00b7 '),
      open: () => setThreadId(item.consultation_id),
    });
  }

  for (const item of results.groups ?? []) {
    rows.push({
      id: `group-${item.id}`,
      group: 'Groups',
      icon: Users2,
      title: item.name,
      detail: item.section,
      open: () => goTo('group'),
    });
  }

  return rows;
}

/**
 * The search box and its results.
 *
 * Every match opens the thing it names.
 */
function GlobalSearch({ query, onSearch, results }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!event.target.closest?.('[data-global-search]')) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const searching = query.trim().length >= 2;
  const showPanel = open && searching;

  // Results arrive flat and pre-ordered; grouping is presentation only.
  const groups = [];
  for (const result of results) {
    const bucket = groups.find((group) => group.label === result.group);
    if (bucket) bucket.items.push(result);
    else groups.push({ label: result.group, items: [result] });
  }

  return (
    <div className="relative hidden min-w-0 md:block md:w-72 lg:w-[26rem]" data-global-search>
      <Search
        className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        aria-hidden="true"
      />
      <input
        type="search"
        value={query}
        onChange={(event) => {
          onSearch(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search anything..."
        aria-label="Search consultations, requests, action items and past sessions"
        aria-expanded={showPanel}
        className="w-full rounded-full border border-ink-200 bg-ink-50 py-2 pl-10 pr-4 text-body text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-700/15"
      />

      {showPanel ? (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lift">
          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-small text-ink-500">
              Nothing matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <div className="max-h-[22rem] overflow-y-auto py-1">
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="px-3.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    {group.label}
                  </p>
                  {group.items.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        result.open();
                      }}
                      className="flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition hover:bg-ink-50"
                    >
                      <result.icon
                        className="mt-0.5 h-4 w-4 shrink-0 text-ink-400"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-ink-900">
                          {result.title}
                        </span>
                        {result.detail ? (
                          <span className="block truncate text-small text-ink-500">
                            {result.detail}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One icon control, optionally badged with a count. */
function IconButton({ onClick, disabled, label, icon: Icon, count = 0, countClass, spin }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="relative rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:opacity-50"
    >
      <Icon className={`h-[18px] w-[18px] ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      {count > 0 ? (
        <span
          className={`tnum absolute right-0 top-0 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-semibold text-white ring-2 ring-white ${countClass}`}
        >
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The avatar is a menu, not a label. The sidebar dropped its desktop sign-out
 * on the strength of this, so the menu has to close on Escape and on a click
 * anywhere outside it.
 */
function AccountMenu({ profile, onNavigate, onSignOut }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!event.target.closest?.('[data-account-menu]')) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const subtitle =
    profile.role === 'adviser'
      ? profile.faculty_position || 'Adviser'
      : profile.course || profile.department || 'Student';

  return (
    <div className="relative ml-1" data-account-menu>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition hover:bg-ink-100"
      >
        <Avatar name={profile.full_name || profile.email} />
        <span className="hidden max-w-[9rem] truncate text-body font-medium text-ink-900 sm:block">
          {profile.full_name || profile.email}
        </span>
        <ChevronDown
          className={`hidden h-4 w-4 shrink-0 text-ink-400 transition-transform sm:block ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lift"
        >
          <div className="border-b border-ink-200 px-3.5 py-3">
            <p className="truncate text-body font-semibold text-ink-900">
              {profile.full_name || profile.email}
            </p>
            <p className="truncate text-small text-ink-500">{subtitle}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate('profile');
            }}
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-body text-ink-700 transition hover:bg-ink-50"
          >
            <UserRound className="h-4 w-4 text-ink-400" aria-hidden="true" />
            My profile
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="flex w-full items-center gap-2.5 border-t border-ink-200 px-3.5 py-2.5 text-body text-ink-700 transition hover:bg-ink-50"
          >
            <LogOut className="h-4 w-4 text-ink-400" aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
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
  completedMilestones,
  milestoneSteps,
  hourBlocks,
  onSetHours,
  unreadByConsultation,
  onOpenThread,
  onWrapUp,
  myId,
  onDecideProposal,
  onPropose,
  onCancel,
  adviser,
  slots,
  slotsLoading,
  activity,
  onSeeAllHistory,
  group,
  onOpenGroup,
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

  // Only groups with a session on the books can be counted - nothing else in
  // the data says who an adviser advises.
  const bookedGroups = new Set(schedule.map((item) => item.group_name).filter(Boolean)).size;

  return (
    <div className="space-y-5">
      <GreetingHeader displayName={displayName} isAdviser={isAdviser} />

      {/* An adviser with no published hours is still fielding guessed times. */}
      {isAdviser && !loading && hourBlocks === 0 ? (
        <PublishHoursPrompt onSetHours={onSetHours} />
      ) : null}

      {/* A student cannot book until they are in a group: the consultation
          belongs to the group, not to whoever happened to fill the form in. */}
      {!isAdviser && !loading && !group ? <JoinGroupPrompt onOpenGroup={onOpenGroup} /> : null}

      {/* ------------------------------------------------------- stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          [0, 1, 2].map((key) => <div key={key} className="skeleton h-[8.5rem] rounded-2xl" />)
        ) : (
          <>
            <StatCard
              icon={CalendarDays}
              tone="brand"
              label="Next consultation"
              delay={0}
            >
              {consultation ? (
                <>
                  <p className="text-h2 font-semibold tracking-tight text-ink-900">{countdown}</p>
                  <p className="mt-1 truncate text-small text-ink-500">
                    {dateFormatter.format(meetingDate)}
                  </p>
                  <p className="mt-0.5 truncate text-small text-ink-500">
                    {timeFormatter.format(meetingDate)}
                    {consultation.location ? ` \u00b7 ${consultation.location}` : ''}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-h3 font-semibold tracking-tight text-ink-900">
                    No consultation booked
                  </p>
                  <p className="mt-1 text-small text-ink-500">
                    {isAdviser
                      ? 'Nothing is on your schedule yet.'
                      : adviser
                        ? 'Your adviser has available slots.'
                        : 'Pick an adviser to get started.'}
                  </p>
                  <button
                    type="button"
                    onClick={onBook}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 text-small font-semibold text-white transition hover:bg-brand-600 active:bg-brand-800"
                  >
                    <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    {isAdviser ? 'Schedule a session' : 'Book a consultation'}
                  </button>
                </>
              )}
            </StatCard>

            <StatCard
              icon={tasks.length === 0 ? CheckCircle2 : ListChecks}
              tone={tasks.length === 0 ? 'success' : 'warning'}
              label="Action items"
              delay={60}
              action={
                tasks.length > 0
                  ? { label: 'View all', onClick: onSeeAllTasks }
                  : null
              }
            >
              <p className="tnum text-h1 font-bold tracking-tight text-ink-900">
                {tasks.length}{' '}
                <span className="text-h3 font-semibold text-ink-500">pending</span>
              </p>
              <p className="mt-1 text-small text-ink-500">
                {tasks.length === 0
                  ? "You're all caught up!"
                  : isAdviser
                    ? 'Across your groups'
                    : 'Waiting on your group'}
              </p>
            </StatCard>

            {isAdviser ? (
              <StatCard icon={Users} tone="brand" label="Groups booked" delay={120}>
                <p className="tnum text-h1 font-bold tracking-tight text-ink-900">
                  {bookedGroups}
                </p>
                <p className="mt-1 text-small text-ink-500">
                  {schedule.length} upcoming {schedule.length === 1 ? 'session' : 'sessions'}
                </p>
              </StatCard>
            ) : (
              <StatCard
                icon={TrendingUp}
                tone="brand"
                label="Capstone progress"
                delay={120}
                action={{ label: 'View details', onClick: onSeeAllHistory }}
              >
                <p className="tnum text-h1 font-bold tracking-tight text-ink-900">{progress}%</p>
                <p className="mt-1 text-small text-ink-500">
                  {nextMilestone ? nextMilestone.label : 'All milestones complete'}
                </p>
                <ProgressBar value={progress} className="mt-3" />
              </StatCard>
            )}
          </>
        )}
      </div>

      {/* ----------------------------------------------- the three-up row --- */}
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="xl:col-span-5">
          {isAdviser ? (
            <RequestQueuePanel
              loading={loading}
              requests={requests}
              busyRequestId={busyRequestId}
              onDecide={onDecide}
              onSeeAll={onSeeAllRequests}
              unreadByConsultation={unreadByConsultation}
              onOpenThread={onOpenThread}
            />
          ) : (
            <NextStepCard
              loading={loading}
              nextMilestone={nextMilestone}
              tasks={tasks}
              onSeeAllTasks={onSeeAllTasks}
              onBook={onBook}
            />
          )}
        </div>

        <div className="xl:col-span-4">
          {isAdviser ? (
            <SchedulePanel
              schedule={schedule}
              loading={loading}
              onBook={onBook}
              unreadByConsultation={unreadByConsultation}
              onOpenThread={onOpenThread}
            />
          ) : (
            <MilestonePanel
              progress={progress}
              completed={completedMilestones}
              steps={milestoneSteps}
            />
          )}
        </div>

        <div className="xl:col-span-3">
          {isAdviser ? (
            <ActivityFeed items={activity} loading={loading} onSeeAll={onSeeAllHistory} />
          ) : (
            <AdviserPanel adviser={adviser} consultation={consultation} loading={loading} onOpenThread={onOpenThread} onBook={onBook} />
          )}
        </div>
      </div>

      {/* ---------------------------------------------------- the wide row --- */}
      <div className="grid gap-4 xl:grid-cols-12">
        <div className="xl:col-span-9">
          {consultation ? (
            <section>
              <SectionHeading title="Upcoming consultation" />
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
            </section>
          ) : isAdviser ? (
            <section>
              <SectionHeading title="Upcoming consultation" />
              <ConsultationCard
                consultation={null}
                countdown={countdown}
                isAdviser={isAdviser}
                onBook={onBook}
                onOpenThread={onOpenThread}
                onWrapUp={onWrapUp}
                myId={myId}
                onDecideProposal={onDecideProposal}
                onPropose={onPropose}
                onCancel={onCancel}
              />
            </section>
          ) : (
            <OpenSlotsPanel
              adviser={adviser}
              slots={slots}
              loading={slotsLoading}
              onBook={onBook}
            />
          )}
        </div>

        <div className="xl:col-span-3">
          {isAdviser ? (
            <TaskDigestPanel
              loading={loading}
              tasks={tasks}
              busyTaskId={busyTaskId}
              onResolve={onResolve}
              onSeeAll={onSeeAllTasks}
            />
          ) : (
            <ActivityFeed items={activity} loading={loading} onSeeAll={onSeeAllHistory} />
          )}
        </div>
      </div>

      {/* Requests come first for a student too, but below the fold: theirs are
          waiting on somebody else, so they are news rather than a queue. */}
      {!isAdviser && !loading && requests.length > 0 ? (
        <section>
          <SectionHeading
            title="Waiting on your adviser"
            action={
              requests.length > 2 ? (
                <SeeAllLink label="See all" onClick={onSeeAllRequests} />
              ) : null
            }
          />
          <div className="grid gap-4">
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

      {/* The student's own action items, in full. */}
      {!isAdviser ? (
        <section>
          <SectionHeading
            title="Pending action items"
            action={
              tasks.length > 4 ? <SeeAllLink label="See all" onClick={onSeeAllTasks} /> : null
            }
          />
          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1].map((key) => (
                <div key={key} className="skeleton h-32 rounded-2xl" />
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
      ) : null}
    </div>
  );
}

/**
 * Shown once, to an adviser who has published nothing. Consultation hours are
 * the difference between answering every guessed time and having students pick
 * from slots that already work -- but only if the adviser knows they exist.
 */
/*
 * The banner shown when the app cannot do its job until someone finishes a
 * setup step -- an adviser with no published hours, a student with no group.
 * Both are the same object, so they are one component with one tint rather than
 * two that drifted into gold and maroon.
 *
 * The layout is the part worth keeping. The first version was a single
 * `flex flex-wrap` row in which the text had `min-w-0 flex-1`: that lets the
 * copy shrink toward nothing while the 40px icon and the ~150px button refuse
 * to give up a pixel, so on a phone the paragraph collapsed into a
 * four-words-wide column and the wrap never fired, because nothing ever
 * overflowed. Icon and text are now one unit that stacks above a full-width
 * button, and the row only re-forms once there is room for one.
 */
function PromptBanner({ icon: Icon, title, body, action, onAction }) {
  return (
    <section className="animate-rise flex flex-col gap-4 rounded-2xl border border-brand-200 bg-brand-50/50 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-700">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-h3 font-semibold text-ink-900">{title}</p>
          <p className="mt-0.5 text-body text-ink-600">{body}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-body font-semibold text-white transition hover:bg-brand-600 sm:w-auto"
      >
        {action}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

function PublishHoursPrompt({ onSetHours }) {
  return (
    <PromptBanner
      icon={CalendarClock}
      title="You have not published any hours"
      body="Until you do, students are guessing a time and waiting to be declined."
      action="Set consultation hours"
      onAction={onSetHours}
    />
  );
}

/**
 * Shown to a student who is not in a thesis group. Booking is blocked until
 * they are, because a consultation belongs to a group and there is nothing to
 * attach one to -- and because the whole point of groups is that a session
 * booked by one member reaches the others.
 */
function JoinGroupPrompt({ onOpenGroup }) {
  return (
    <PromptBanner
      icon={Users2}
      title="You are not in a thesis group yet"
      body="Create one or join with your leader's code. Consultations belong to the group, so everything you book reaches your group mates too."
      action="Set up my group"
      onAction={onOpenGroup}
    />
  );
}

/* -------------------------------------------------------------- greeting -- */

/** Morning before noon, afternoon before 18:00, evening after. */
function greetingFor(date) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/*
 * The greeting is the only element on the page that can carry the identity
 * without lying about anything, so it does.
 *
 * On a phone there is no maroon chrome at all -- the sidebar that holds it on a
 * desktop is off-screen -- which left the whole app reading as grey cards on a
 * grey page, nothing like the sign-in screen the student just came through.
 * Deepening the canvas alone could not fix that: the problem was not contrast
 * between card and ground, it was that no brand colour was on the page.
 */
function GreetingHeader({ displayName, isAdviser }) {
  const now = new Date();
  return (
    <section className="animate-rise overflow-hidden rounded-2xl bg-gradient-to-br from-brand-800 via-brand-900 to-brand-950 p-5 shadow-raised sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-h1 font-bold tracking-tight text-white">
            {greetingFor(now)}, {displayName}
          </h2>
          <p className="mt-1 text-body text-brand-100/80">
            {isAdviser
              ? "Here's what's happening across your groups today."
              : "Here's what's happening with your capstone today."}
          </p>
        </div>
        <p className="flex shrink-0 items-center gap-2 self-start rounded-xl bg-white/10 px-3 py-2 text-body ring-1 ring-white/15 sm:self-auto">
          <CalendarDays className="h-4 w-4 shrink-0 text-brand-200" aria-hidden="true" />
          <span className="leading-tight">
            <span className="block font-semibold text-white">{todayFormatter.format(now)}</span>
            <span className="block text-small text-brand-200/80">
              {weekdayFormatter.format(now)}
            </span>
          </span>
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ stat cards -- */

/*
 * The icon chip is the only colour on a card, so what it is allowed to say
 * matters. `brand` is the default and means nothing beyond "this is ours";
 * `success` and `warning` are claims about the data underneath and may only be
 * used where that claim is true *right now*.
 *
 * Capstone progress used to be permanently `success`, which put a reassuring
 * green tick beside a capstone that was 12% done -- a category wearing a
 * status's colour. Groups booked was permanently `info` for the same reason.
 * Both are `brand` now, and `info` had no honest use left.
 */
const TONES = {
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-600',
  warning: 'bg-gold-50 text-gold-600',
};

function StatCard({ icon: Icon, tone, label, action, delay = 0, children }) {
  return (
    <article
      style={{ '--delay': `${delay}ms` }}
      className="animate-rise flex flex-col rounded-2xl border border-ink-200 bg-white p-4 transition-colors hover:border-ink-300"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-body font-medium text-ink-600">
          <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${TONES[tone]}`}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          {label}
        </span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {action ? (
        <div className="mt-3 flex justify-end">
          <SeeAllLink label={action.label} onClick={action.onClick} />
        </div>
      ) : null}
    </article>
  );
}

function ProgressBar({ value, className = '' }) {
  return (
    <div
      className={`h-1.5 w-full overflow-hidden rounded-full bg-ink-200 ${className}`}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-brand-700 transition-[width] duration-500"
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

function SeeAllLink({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded text-small font-semibold text-brand-700 transition hover:text-brand-600 hover:underline"
    >
      {label}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------- next step -- */

function NextStepCard({ loading, nextMilestone, tasks, onSeeAllTasks, onBook }) {
  if (loading) return <div className="skeleton h-[17rem] rounded-2xl" />;

  const steps = nextMilestone ? (MILESTONE_ACTIONS[nextMilestone.key] ?? []) : [];
  const done = !nextMilestone;

  return (
    <article className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <p className="flex items-center gap-2 text-body font-medium text-ink-600">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <Lightbulb className="h-4 w-4" aria-hidden="true" />
        </span>
        Your next step
      </p>

      <h3 className="mt-3 text-h2 font-semibold tracking-tight text-brand-700">
        {nextMilestone ? nextMilestone.label : 'All milestones complete'}
      </h3>
      <p className="mt-1 text-body text-ink-500">
        {done
          ? 'Every milestone is checked off. Nothing is blocking your defense.'
          : 'Prepare this milestone for adviser evaluation.'}
      </p>

      {steps.length > 0 ? (
        <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50/50 p-4">
          <p className="text-small font-semibold text-ink-700">Recommended actions</p>
          <ul className="mt-2.5 space-y-2">
            {steps.map((step) => (
              <li key={step} className="flex items-start gap-2 text-body text-ink-700">
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-brand-400"
                  aria-hidden="true"
                />
                {step}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <button
          type="button"
          onClick={onSeeAllTasks}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-body font-semibold text-white transition hover:bg-brand-600 active:bg-brand-800"
        >
          <ListChecks className="h-4 w-4" aria-hidden="true" />
          View action items
          {tasks.length > 0 ? (
            <span className="tnum ml-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white/20 px-1.5 text-[10px] font-semibold">
              {tasks.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onBook}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-body font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          Book consultation
        </button>
      </div>
    </article>
  );
}

/* --------------------------------------------------------- open slots ----- */

/**
 * The adviser's next open slots, so booking starts from something real rather
 * than from an empty date field. Slots come from the same endpoint the booking
 * form uses, so anything shown here is genuinely bookable.
 */
function OpenSlotsPanel({ adviser, slots, loading, onBook }) {
  return (
    <section className="animate-rise h-full rounded-2xl border border-ink-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-h3 font-semibold text-ink-900">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
            </span>
            Open consultation slots
          </p>
          <p className="mt-1 text-small text-ink-500">
            {adviser
              ? `Next available times from ${adviser.full_name}.`
              : 'Pick an adviser to see the times they hold hours.'}
          </p>
        </div>
        {slots.length > 0 ? <SeeAllLink label="View all slots" onClick={onBook} /> : null}
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="skeleton h-[4.5rem] rounded-xl" />
          ))}
        </div>
      ) : slots.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-6 py-8 text-center">
          <p className="text-body font-medium text-ink-700">
            {adviser
              ? 'No open slots in the next two weeks'
              : 'No adviser selected yet'}
          </p>
          <p className="mt-1 text-small text-ink-500">
            {adviser
              ? 'You can still request a time and let your adviser confirm it.'
              : 'Start a booking to choose an adviser from your department.'}
          </p>
          <button
            type="button"
            onClick={onBook}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-small font-semibold text-white transition hover:bg-brand-600"
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Book a consultation
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {slots.map((slot) => (
            <button
              key={slot.start}
              type="button"
              onClick={onBook}
              className="group rounded-xl border border-ink-200 bg-white px-3.5 py-3 text-left transition hover:border-brand-300 hover:bg-brand-50/50"
            >
              <p className="text-small font-medium text-ink-500">
                {slotDayFormatter.format(new Date(slot.start))}
              </p>
              <p className="tnum mt-1 text-body font-semibold text-ink-900">
                {timeFormatter.format(new Date(slot.start))}
                {slot.end ? ` \u2013 ${timeFormatter.format(new Date(slot.end))}` : ''}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------- recent activity -- */

/**
 * A feed assembled from the records the API already returns: requests raised
 * and answered, sessions wrapped up, and threads with something unread. There
 * is no activity table, so nothing here is invented -- every row points at a
 * consultation that exists.
 */
function ActivityFeed({ items, loading, onSeeAll }) {
  return (
    <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-h3 font-semibold text-ink-900">Recent activity</p>
        {items.length > 0 ? <SeeAllLink label="View all" onClick={onSeeAll} /> : null}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-4 py-8 text-center text-small text-ink-500">
          Nothing has happened yet. Booking a consultation starts the trail.
        </p>
      ) : (
        <ul className="space-y-3.5">
          {items.map((item) => (
            <li key={item.id} className="flex gap-2.5">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${item.tone}`}
              >
                <item.icon className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium leading-snug text-ink-900">{item.title}</p>
                {item.detail ? (
                  <p className="mt-0.5 truncate text-small text-ink-500">{item.detail}</p>
                ) : null}
              </div>
              {item.when ? (
                <span className="shrink-0 text-small text-ink-400">{item.when}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------- adviser request queue -- */

/** The adviser's approval queue, condensed to fit the three-up row. */
function RequestQueuePanel({
  loading,
  requests,
  busyRequestId,
  onDecide,
  onSeeAll,
  unreadByConsultation,
  onOpenThread,
}) {
  if (loading) return <div className="skeleton h-[17rem] rounded-2xl" />;

  if (requests.length === 0) {
    return (
      <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
        <p className="text-h3 font-semibold text-ink-900">Consultation requests</p>
        <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-6 py-10 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="mt-3 text-body font-medium text-ink-700">Nothing waiting on you</p>
          <p className="mt-1 text-small text-ink-500">
            Every request has an answer. New ones land here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-h3 font-semibold text-ink-900">Consultation requests</p>
        <SeeAllLink label="See all" onClick={onSeeAll} />
      </div>

      <ul className="space-y-3">
        {requests.slice(0, 3).map((request) => (
          <RequestQueueItem
            key={request.id}
            request={request}
            busy={busyRequestId === request.id}
            onDecide={onDecide}
            onSeeAll={onSeeAll}
            unread={unreadByConsultation?.[request.id] ?? 0}
            onOpenThread={onOpenThread}
          />
        ))}
      </ul>

      {requests.length > 3 ? (
        <p className="mt-3 text-small text-ink-500">
          {requests.length - 3} more waiting on you.
        </p>
      ) : null}
    </section>
  );
}

/**
 * One request as a rail row. Declining needs a reason the API insists on, so
 * that answer goes to the full card on the requests page; approving does not,
 * so it can happen here.
 */
function RequestQueueItem({ request, busy, onDecide, onSeeAll, unread, onOpenThread }) {
  const when = new Date(request.meeting_date);
  const proposalLive = Boolean(request.proposal_live);

  return (
    <li className="rounded-xl border border-ink-200 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-small text-ink-500">
            {request.group_name || 'Consultation'}
          </p>
          <p className="mt-0.5 truncate text-body font-semibold text-ink-900">{request.topic}</p>
        </div>
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => onOpenThread(request.id)}
            aria-label={`${unread} unread ${unread === 1 ? 'message' : 'messages'}`}
            className="relative shrink-0 rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
            <span className="tnum absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand-700 px-1 text-[9px] font-semibold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          </button>
        ) : null}
      </div>

      <p className="tnum mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-500">
        <span className="inline-flex items-center gap-1.5">
          <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          {slotDayFormatter.format(when)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          {timeFormatter.format(when)}
        </span>
      </p>

      {proposalLive ? (
        <p className="mt-2.5 rounded-lg bg-gold-50 px-2.5 py-1.5 text-small font-medium text-gold-800">
          A new time is on the table. Answer it on the requests page.
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide(request, 'approved')}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-small font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Approve
          </button>
          <button
            type="button"
            onClick={onSeeAll}
            className="inline-flex flex-1 items-center justify-center rounded-lg border border-ink-200 px-3 py-1.5 text-small font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
          >
            Review
          </button>
        </div>
      )}
    </li>
  );
}

/** The adviser's action items, condensed into the right rail. */
function TaskDigestPanel({ loading, tasks, busyTaskId, onResolve, onSeeAll }) {
  return (
    <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-h3 font-semibold text-ink-900">Action items</p>
        {tasks.length > 3 ? <SeeAllLink label="View all" onClick={onSeeAll} /> : null}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="skeleton h-12 rounded-lg" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-4 py-8 text-center text-small text-ink-500">
          Nothing open across your groups.
        </p>
      ) : (
        <ul className="space-y-3">
          {tasks.slice(0, 4).map((task) => (
            <li key={task.id} className="flex items-start gap-2.5">
              <button
                type="button"
                onClick={() => onResolve(task)}
                disabled={busyTaskId === task.id}
                aria-label={`Mark "${task.task_description}" as resolved`}
                className="mt-0.5 shrink-0 rounded-full text-ink-300 transition hover:text-brand-700 disabled:opacity-50"
              >
                {busyTaskId === task.id ? (
                  <CheckCircle2 className="h-4 w-4 animate-pulse text-brand-700" aria-hidden="true" />
                ) : (
                  <Circle className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-body leading-snug text-ink-900">
                  {task.task_description}
                </p>
                {task.assignee_name ? (
                  <p className="mt-0.5 truncate text-small text-ink-500">{task.assignee_name}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
            /* Green is reserved for approving something against a rose decline.
               This button has no counterpart -- it is just the primary action. */
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-600 active:scale-[0.99]"
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

/**
 * The capstone as a vertical timeline. The current milestone is the only row
 * with a fill behind it, so the eye lands on "where are we" before it reads
 * anything else.
 */
function MilestonePanel({ progress, completed, steps }) {
  return (
    <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-h3 font-semibold text-ink-900">Capstone milestones</p>
        <span className="tnum shrink-0 rounded-full bg-emerald-50 px-2.5 py-1 text-small font-semibold text-emerald-700">
          {progress}% complete
        </span>
      </div>

      <ol>
        {steps.map((milestone, index) => {
          const done = completed.has(milestone.key);
          // The step in progress is the first unfinished one, so a milestone
          // signed off out of order does not leave two rows highlighted.
          const current =
            !done && steps.slice(0, index).every((earlier) => completed.has(earlier.key));
          const last = index === steps.length - 1;
          return (
            <li key={milestone.key} className="flex gap-3">
              <div className="flex flex-col items-center">
                {done ? (
                  <CheckCircle2
                    className="h-5 w-5 shrink-0 text-emerald-500"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    className={`h-5 w-5 shrink-0 ${current ? 'text-brand-700' : 'text-ink-300'}`}
                    aria-hidden="true"
                  />
                )}
                {!last ? (
                  <span
                    className={`my-1 w-0.5 flex-1 rounded-full ${done ? 'bg-emerald-200' : 'bg-ink-200'}`}
                  />
                ) : null}
              </div>

              <div
                className={`min-w-0 flex-1 rounded-lg px-2.5 ${last ? 'pb-0' : 'pb-3'} ${
                  current ? '-mt-1 bg-brand-50/70 py-2' : 'pt-px'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p
                    className={`truncate text-body ${
                      current
                        ? 'font-semibold text-brand-700'
                        : done
                          ? 'font-medium text-ink-900'
                          : 'text-ink-400'
                    }`}
                  >
                    {milestone.label}
                  </p>
                  {current ? (
                    <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold text-brand-800">
                      Now
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-small text-ink-500">
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

/**
 * Who the group is working with, and when they are next free.
 *
 * `adviser` is the directory record, which is the only place the faculty
 * position and department live; `consultation` is what proves they are this
 * group's adviser at all. Either can be missing, and the card says so rather
 * than inventing a name.
 */
function AdviserPanel({ adviser, consultation, loading, onOpenThread, onBook }) {
  if (loading) return <div className="skeleton h-[17rem] rounded-2xl" />;

  const name = adviser?.full_name ?? consultation?.adviser_name ?? null;
  const email = adviser?.email ?? consultation?.adviser_email ?? null;

  if (!name) {
    return (
      <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
        <p className="text-h3 font-semibold text-ink-900">Your adviser</p>
        <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-4 py-8 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-100">
            <User className="h-5 w-5 text-ink-400" aria-hidden="true" />
          </span>
          <p className="mt-3 text-body font-medium text-ink-700">No adviser yet</p>
          <p className="mt-1 text-small text-ink-500">
            They appear here once you book your first consultation.
          </p>
          <button
            type="button"
            onClick={onBook}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand-700 px-3.5 py-2 text-small font-semibold text-white transition hover:bg-brand-600"
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Book a consultation
          </button>
        </div>
      </section>
    );
  }

  const subtitle = [adviser?.faculty_position || 'Thesis Adviser', adviser?.department]
    .filter(Boolean)
    .join(' \u00b7 ');
  const publishesHours = Boolean(adviser?.availableFrom);

  return (
    <section className="animate-rise flex h-full flex-col rounded-2xl border border-ink-200 bg-white p-5">
      <p className="text-h3 font-semibold text-ink-900">Your adviser</p>

      <div className="mt-4 flex items-center gap-3">
        <Avatar name={name} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-ink-900">{name}</p>
          <p className="truncate text-small text-ink-500">{subtitle}</p>
        </div>
      </div>

      <span
        className={`mt-3 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-small font-medium ${
          publishesHours
            ? 'bg-emerald-50 text-emerald-700'
            : 'bg-ink-100 text-ink-600'
        }`}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${publishesHours ? 'bg-emerald-500' : 'bg-ink-400'}`}
          aria-hidden="true"
        />
        {publishesHours ? 'Available for consultation' : 'No published hours'}
      </span>

      {adviser?.availableFrom ? (
        <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/60 px-3.5 py-3">
          <p className="text-small text-ink-500">Next available</p>
          <p className="tnum mt-0.5 text-body font-semibold text-ink-900">
            {slotDayFormatter.format(new Date(adviser.availableFrom))}
            {' \u00b7 '}
            {timeFormatter.format(new Date(adviser.availableFrom))}
          </p>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {email ? (
          <a
            href={`mailto:${email}`}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-200 px-3 py-2 text-small font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
          >
            <Mail className="h-3.5 w-3.5" aria-hidden="true" />
            Email
          </a>
        ) : null}
        {consultation?.id ? (
          <button
            type="button"
            onClick={() => onOpenThread(consultation.id)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 text-small font-semibold text-white transition hover:bg-brand-600"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            Message
          </button>
        ) : (
          <button
            type="button"
            onClick={onBook}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 text-small font-semibold text-white transition hover:bg-brand-600"
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            Book
          </button>
        )}
      </div>
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

/**
 * The profile, and the parts of it a person may correct themselves.
 *
 * Editing exists because sections arrived after 43 accounts already did, and
 * without a section you cannot create a thesis group -- so every one of those
 * accounts was locked out of the feature with no way back in.
 *
 * Email, role, student and faculty ID and department stay read-only: they are
 * the registrar's or are derived from the address the login code went to.
 */
function ProfileView({ token, refreshToken, profile, onSignOut, onProfileChanged }) {
  const isAdviser = profile.role === 'adviser';
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(() => draftFrom(profile));

  // A student with no section cannot make a group, so say so where they will
  // be standing when they find out.
  const missingSection = !isAdviser && !profile.section;

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api('/me', { method: 'PATCH', token, body: form });
      onProfileChanged?.(result.profile);
      setNotice('Profile updated.');
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const rows = [
    ['Full name', profile.full_name],
    ['Email', profile.email],
    ['Student ID', profile.student_id],
    ['Faculty ID', profile.employee_id],
    ['Position', profile.faculty_position],
    ['Department', profile.department],
    ['Course', profile.course],
    ['Year level', profile.year_level],
    ['Section', profile.section],
    ['Thesis group', profile.group_name],
    ['Role', profile.role, true],
  ].filter(([, value]) => Boolean(value));

  return (
    <div className="animate-rise max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-h1 font-bold tracking-tight text-ink-900">My profile</h1>
          <p className="mt-1 text-body text-ink-500">The details you registered with.</p>
        </div>
        {!editing ? (
          <button
            type="button"
            onClick={() => {
              setForm(draftFrom(profile));
              setNotice('');
              setEditing(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3.5 py-2 text-body font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit profile
          </button>
        ) : null}
      </div>

      {missingSection && !editing ? (
        <p className="mt-5 flex items-start gap-2 rounded-xl border border-gold-200 bg-gold-50/60 px-3.5 py-3 text-body text-gold-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Your account has no section. Add one to create or join a thesis group.
          </span>
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-body font-medium text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="mt-5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-body font-medium text-emerald-800"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      ) : null}

      <section className="mt-6 overflow-hidden rounded-xl border border-ink-200 bg-white">
        <div className="flex flex-wrap items-center gap-4 bg-brand-700 px-6 py-6">
          <Avatar name={profile.full_name || profile.email} size="lg" onBrand />
          <div className="min-w-0">
            <p className="truncate text-[17px] font-semibold tracking-tight text-white">
              {profile.full_name || profile.email}
            </p>
            <p className="truncate text-[13px] text-brand-100">
              {(isAdviser
                ? [profile.faculty_position || 'Adviser', profile.department]
                : [profile.year_level, profile.course]
              )
                .filter(Boolean)
                .join(' - ') || (profile.role ?? 'student')}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25">
              {isAdviser ? (
                <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {isAdviser ? 'Adviser' : 'Student'}
            </span>
            {profile.email_verified_at ? (
              <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/25">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Email verified
              </span>
            ) : null}
          </div>
        </div>

        {editing ? (
          <form onSubmit={save} className="p-6">
            <div className="grid gap-4 sm:grid-cols-[2fr_2fr_1fr]">
              <ProfileField label="Last name" id="edit-last">
                <input
                  id="edit-last"
                  required
                  value={form.lastName}
                  onChange={(event) => update('lastName', event.target.value)}
                  className={EDIT_INPUT}
                />
              </ProfileField>
              <ProfileField label="First name" id="edit-first">
                <input
                  id="edit-first"
                  required
                  value={form.firstName}
                  onChange={(event) => update('firstName', event.target.value)}
                  className={EDIT_INPUT}
                />
              </ProfileField>
              <ProfileField label="M.I." id="edit-mi">
                <input
                  id="edit-mi"
                  maxLength={1}
                  value={form.middleInitial}
                  onChange={(event) => update('middleInitial', event.target.value)}
                  className={`${EDIT_INPUT} text-center uppercase`}
                />
              </ProfileField>
            </div>

            {isAdviser ? (
              <div className="mt-4">
                <ProfileField label="Academic position" id="edit-position">
                  <select
                    id="edit-position"
                    value={form.facultyPosition}
                    onChange={(event) => update('facultyPosition', event.target.value)}
                    className={EDIT_INPUT}
                  >
                    <option value="">Not set</option>
                    {FACULTY_POSITIONS.map((position) => (
                      <option key={position} value={position}>
                        {position}
                      </option>
                    ))}
                  </select>
                </ProfileField>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <ProfileField label="Section" id="edit-section">
                  <input
                    id="edit-section"
                    required
                    maxLength={20}
                    value={form.section}
                    onChange={(event) => update('section', event.target.value.toUpperCase())}
                    placeholder="CS-401"
                    className={`${EDIT_INPUT} uppercase`}
                  />
                </ProfileField>
                <ProfileField label="Course" id="edit-course">
                  <select
                    id="edit-course"
                    required
                    value={form.course}
                    onChange={(event) => update('course', event.target.value)}
                    className={EDIT_INPUT}
                  >
                    <option value="">Select course</option>
                    {(DEPARTMENTS[profile.department] ?? []).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                    {/* Keeps a course from another department selectable rather
                        than silently clearing it. */}
                    {form.course && !(DEPARTMENTS[profile.department] ?? []).includes(form.course) ? (
                      <option value={form.course}>{form.course}</option>
                    ) : null}
                  </select>
                </ProfileField>
                <ProfileField label="Year level" id="edit-year">
                  <select
                    id="edit-year"
                    required
                    value={form.yearLevel}
                    onChange={(event) => update('yearLevel', event.target.value)}
                    className={EDIT_INPUT}
                  >
                    <option value="">Select year level</option>
                    {YEAR_LEVELS.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </ProfileField>
              </div>
            )}

            <p className="mt-4 text-small text-ink-500">
              Your email, role, department and
              {isAdviser ? ' faculty ID ' : ' student ID '}
              cannot be changed here. Ask the registrar if one of them is wrong.
            </p>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setError('');
                }}
                className="rounded-lg border border-ink-200 px-4 py-2 text-body font-semibold text-ink-700 transition hover:bg-ink-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-body font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Save changes
              </button>
            </div>
          </form>
        ) : (
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
        )}
      </section>

      <PasswordCard token={token} refreshToken={refreshToken} />

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

/*
 * Changing a password from inside the app.
 *
 * Collapsed until asked for: on a page people open to check their section, a
 * permanently expanded set of three password boxes is three boxes of noise.
 *
 * The three fields are one form and are submitted together, which is what lets
 * the browser's password manager offer to update the saved entry -- a "new
 * password" field with no "current password" beside it usually does not.
 */
function PasswordCard({ token, refreshToken }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [visible, setVisible] = useState(false);
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function close() {
    setOpen(false);
    setForm({ current: '', next: '', confirm: '' });
    setError('');
    setVisible(false);
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setNotice('');

    if (form.next !== form.confirm) {
      setError('The new passwords do not match.');
      return;
    }
    if (form.next.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    setSaving(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        token,
        body: {
          currentPassword: form.current,
          newPassword: form.next,
          refresh_token: refreshToken,
        },
      });
      close();
      setNotice('Password changed. Your next sign-in uses the new one.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-ink-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="min-w-0">
          <p className="text-h3 font-semibold tracking-tight text-ink-900">Password</p>
          <p className="mt-0.5 text-[13px] text-ink-500">
            {open
              ? 'You will need your current password to set a new one.'
              : 'The password you sign in with.'}
          </p>
        </div>
        {open ? (
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-ink-200 px-4 py-2 text-body font-semibold text-ink-700 transition hover:bg-ink-50"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setNotice('');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-4 py-2 text-body font-semibold text-ink-700 transition hover:border-brand-200 hover:text-brand-700"
          >
            <Lock className="h-4 w-4" aria-hidden="true" />
            Change password
          </button>
        )}
      </div>

      {notice && !open ? (
        <p className="flex items-start gap-2 border-t border-ink-200 bg-emerald-50 px-6 py-3 text-body font-medium text-emerald-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      ) : null}

      {open ? (
        <form onSubmit={submit} noValidate className="border-t border-ink-200 px-6 py-5">
          <ProfileField label="Current password" id="pw-current">
            <input
              id="pw-current"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={form.current}
              onChange={(event) => update('current', event.target.value)}
              className={EDIT_INPUT}
            />
          </ProfileField>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ProfileField label="New password" id="pw-next">
              <input
                id="pw-next"
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={form.next}
                onChange={(event) => update('next', event.target.value)}
                className={EDIT_INPUT}
              />
              <p className="mt-1.5 text-small text-ink-500">At least 8 characters.</p>
            </ProfileField>

            <ProfileField label="Confirm new password" id="pw-confirm">
              <input
                id="pw-confirm"
                type={visible ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={form.confirm}
                onChange={(event) => update('confirm', event.target.value)}
                className={EDIT_INPUT}
              />
            </ProfileField>
          </div>

          <label className="mt-3 flex w-fit items-center gap-2 text-small text-ink-600">
            <input
              type="checkbox"
              checked={visible}
              onChange={(event) => setVisible(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-ink-300 text-brand-700 focus:ring-brand-700/20"
            />
            Show passwords
          </label>

          {error ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3.5 py-3 text-body font-medium text-rose-700"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-body font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Update password
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

/** Only the fields PATCH /api/me accepts, so the form cannot send anything else. */
function draftFrom(profile) {
  return {
    lastName: profile.last_name ?? '',
    firstName: profile.first_name ?? '',
    middleInitial: profile.middle_initial ?? '',
    section: profile.section ?? '',
    course: profile.course ?? '',
    yearLevel: profile.year_level ?? '',
    facultyPosition: profile.faculty_position ?? '',
  };
}

function ProfileField({ label, id, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-medium text-ink-700">
        {label}
      </label>
      {children}
    </div>
  );
}

const EDIT_INPUT =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';
