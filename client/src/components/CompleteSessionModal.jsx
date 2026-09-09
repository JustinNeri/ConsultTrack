import { useEffect, useRef, useState } from 'react';
import { MILESTONES } from '../lib/milestones.js';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  Milestone,
  Plus,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { toDateInput } from '../lib/schedule.js';

const MAX_TASKS = 20;

const sessionFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// A stable list key. A counter rather than crypto.randomUUID(), which is
// missing on Safari before 15.4 and would take the whole form down with it.
let taskSeq = 0;
const blankTask = () => ({
  key: `task-${(taskSeq += 1)}`,
  description: '',
  assignee_id: '',
  due_date: '',
});

/**
 * Closing a session: what was agreed, and who owes what.
 *
 * This is the only thing in the system that creates an action item. Before it,
 * `action_items` had no writer at all -- the Action items screen and its stat
 * tile could only ever be empty. It is also the only way a consultation reaches
 * 'completed', which is what drops it out of every "upcoming" query and into
 * the session history.
 */
export default function CompleteSessionModal({ token, consultationId, onClose, onCompleted }) {
  const [consultation, setConsultation] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [minutes, setMinutes] = useState('');
  const [tasks, setTasks] = useState(() => [blankTask()]);
  // Attendance is opt-in. Defaulting everyone to present would silently record
  // an attestation the adviser never made -- "not recorded" and "all present"
  // are different claims, and the record prints them differently.
  const [takeAttendance, setTakeAttendance] = useState(false);
  // Which capstone milestone, if any, this session signed off.
  const [milestone, setMilestone] = useState('');
  const [absent, setAbsent] = useState(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const dialogRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    api(`/consultations/${consultationId}`, { token, signal: controller.signal })
      .then((result) => {
        setConsultation(result.consultation);
        setMembers(result.members ?? []);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [consultationId, token]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  function updateTask(key, field, value) {
    setTasks((prev) =>
      prev.map((task) => (task.key === key ? { ...task, [field]: value } : task)),
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError('');
    try {
      const result = await api(`/consultations/${consultationId}/complete`, {
        method: 'POST',
        token,
        body: {
          minutes: minutes.trim() || null,
          // Blank rows are dropped server-side too; sending them is harmless
          // but pointless.
          tasks: tasks
            .filter((task) => task.description.trim())
            .map((task) => ({
              description: task.description.trim(),
              assignee_id: task.assignee_id || null,
              due_date: task.due_date || null,
            })),
          // Only sent when the adviser actually picked one; the wrap-up is
          // the moment they know, but most sessions do not close a milestone.
          ...(milestone ? { milestone } : {}),
          // Omitted entirely when the adviser did not take attendance, so the
          // record can say so rather than inventing a full house.
          ...(takeAttendance
            ? {
                attendance: members.map((member) => ({
                  profile_id: member.id,
                  present: !absent.has(member.id),
                })),
              }
            : {}),
        },
      });
      onCompleted(result);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const filledTasks = tasks.filter((task) => task.description.trim()).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (!dialogRef.current?.contains(event.target)) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wrapup-title"
        className="scrollbar-slim max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-white shadow-lift sm:rounded-2xl"
      >
        {/* ---------------------------------------------------------- header */}
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-ink-100 bg-white/95 px-6 py-5 backdrop-blur">
          <div className="flex gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white ">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="wrapup-title" className="text-lg font-bold tracking-tight text-ink-900">
                Wrap up this session
              </h2>
              {loading ? (
                <div className="skeleton mt-1 h-4 w-56 rounded" />
              ) : (
                <p className="mt-0.5 truncate text-sm text-ink-500">
                  {consultation?.topic}
                  {consultation?.meeting_date
                    ? ` - ${sessionFormatter.format(new Date(consultation.meeting_date))}`
                    : ''}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5" noValidate>
          {/* --------------------------------------------------- the minutes */}
          <label
            htmlFor="wrapup-minutes"
            className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
          >
            <FileText className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
            What was agreed
            <span className="font-medium normal-case text-ink-400">(optional)</span>
          </label>
          <textarea
            id="wrapup-minutes"
            rows={4}
            maxLength={5000}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            placeholder="Chapter 4 tables need re-running with the corrected sample. System flow diagram approved..."
            className={`${inputClass} resize-none`}
          />
          <p className="mt-1 text-right text-xs text-ink-400">{minutes.length}/5000</p>

          {/* -------------------------------------------------- milestone --- */}
          <div className="mt-5 rounded-xl border border-ink-200 bg-ink-50 p-4">
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
              <Milestone className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
              Capstone milestone
              <span className="font-medium normal-case text-ink-400">(optional)</span>
            </p>
            <p className="mt-1 text-xs text-ink-500">
              Did this session finish one? Marking it here moves the group&apos;s progress
              tracker.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              {MILESTONES.map((item) => {
                const picked = milestone === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => setMilestone(picked ? '' : item.key)}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                      picked
                        ? 'border-brand-700 bg-brand-700 text-white'
                        : 'border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>

            {milestone ? (
              <p className="mt-2.5 text-xs text-ink-500">
                The group will see this marked complete on their progress tracker.
              </p>
            ) : null}
          </div>

          {/* ------------------------------------------------- attendance --- */}
          <div className="mt-5 rounded-xl border border-ink-200 bg-ink-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
                <Users className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                Attendance
                <span className="font-medium normal-case text-ink-400">(optional)</span>
              </p>

              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink-700">
                <input
                  type="checkbox"
                  checked={takeAttendance}
                  onChange={(event) => setTakeAttendance(event.target.checked)}
                  className="h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-500/30"
                />
                Take attendance
              </label>
            </div>

            {takeAttendance ? (
              members.length === 0 ? (
                <p className="mt-3 text-xs text-ink-500">
                  Nobody in this group has set their thesis group on their profile yet, so there
                  is no one to tick off.
                </p>
              ) : (
                <>
                  <ul className="mt-3 space-y-1.5">
                    {members.map((member) => {
                      const present = !absent.has(member.id);
                      return (
                        <li key={member.id}>
                          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-white px-3 py-2.5 ring-1 ring-ink-200 transition hover:ring-brand-200">
                            <input
                              type="checkbox"
                              checked={present}
                              onChange={() =>
                                setAbsent((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(member.id)) next.delete(member.id);
                                  else next.add(member.id);
                                  return next;
                                })
                              }
                              className="h-4 w-4 rounded border-ink-300 text-brand-700 focus:ring-brand-500/30"
                            />
                            <span
                              className={`flex-1 truncate text-sm font-semibold ${
                                present ? 'text-ink-800' : 'text-ink-400 line-through'
                              }`}
                            >
                              {member.full_name || member.email}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                                present
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-rose-50 text-rose-600'
                              }`}
                            >
                              {present ? 'Present' : 'Absent'}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs text-ink-500">
                    Untick anyone who did not attend. This prints on the group&apos;s
                    consultation record.
                  </p>
                </>
              )
            ) : (
              <p className="mt-2 text-xs text-ink-500">
                Leave this off and the record will show attendance was not taken for this
                session.
              </p>
            )}
          </div>

          {/* ---------------------------------------------------- the tasks -- */}
          <div className="mt-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
                <ClipboardList className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                Action items
                <span className="font-medium normal-case text-ink-400">(optional)</span>
              </p>
              {filledTasks > 0 ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                  {filledTasks} to assign
                </span>
              ) : null}
            </div>

            <ul className="space-y-3">
              {tasks.map((task, index) => (
                <li
                  key={task.key}
                  className="rounded-xl bg-ink-50 p-3.5 border border-ink-200 transition-colors focus-within:border-brand-400"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[11px] font-semibold text-ink-500 ring-1 ring-ink-200">
                      {index + 1}
                    </span>

                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div>
                        <label htmlFor={`task-${task.key}`} className="sr-only">
                          Action item {index + 1}
                        </label>
                        <input
                          id={`task-${task.key}`}
                          type="text"
                          maxLength={500}
                          value={task.description}
                          onChange={(event) =>
                            updateTask(task.key, 'description', event.target.value)
                          }
                          placeholder="Re-run the statistical tests with the corrected sample"
                          className={inputClass}
                        />
                      </div>

                      <div className="grid gap-2.5 sm:grid-cols-2">
                        <div>
                          <label
                            htmlFor={`assignee-${task.key}`}
                            className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-500"
                          >
                            <UserRound className="h-3 w-3" aria-hidden="true" />
                            Who
                          </label>
                          <select
                            id={`assignee-${task.key}`}
                            value={task.assignee_id}
                            onChange={(event) =>
                              updateTask(task.key, 'assignee_id', event.target.value)
                            }
                            className={smallInputClass}
                          >
                            <option value="">The whole group</option>
                            {members.map((member) => (
                              <option key={member.id} value={member.id}>
                                {member.full_name || member.email}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label
                            htmlFor={`due-${task.key}`}
                            className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-500"
                          >
                            <CalendarDays className="h-3 w-3" aria-hidden="true" />
                            Due
                          </label>
                          <input
                            id={`due-${task.key}`}
                            type="date"
                            min={toDateInput(new Date())}
                            value={task.due_date}
                            onChange={(event) =>
                              updateTask(task.key, 'due_date', event.target.value)
                            }
                            className={smallInputClass}
                          />
                        </div>
                      </div>
                    </div>

                    {tasks.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTasks((prev) => prev.filter((item) => item.key !== task.key))
                        }
                        aria-label={`Remove action item ${index + 1}`}
                        className="mt-2 shrink-0 rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            {tasks.length < MAX_TASKS ? (
              <button
                type="button"
                onClick={() => setTasks((prev) => [...prev, blankTask()])}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-ink-300 px-3.5 py-2.5 text-sm font-semibold text-ink-600 transition hover:border-brand-300 hover:bg-brand-50/40 hover:text-brand-700"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add another
              </button>
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          <p className="mt-5 rounded-lg bg-ink-50 px-4 py-3 text-xs leading-relaxed text-ink-600">
            Completing moves this session out of your upcoming schedule and into the session
            history. Action items go straight to the group&apos;s Action items screen.
          </p>

          {/* ---------------------------------------------------- actions --- */}
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-200 px-4 py-3 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || loading}
              className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Complete session
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-900 transition placeholder:text-ink-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';

const smallInputClass =
  'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';
