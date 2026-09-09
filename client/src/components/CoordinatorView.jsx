import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  GripVertical,
  Loader2,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { api } from '../lib/api.js';

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** How long a group can go without a session before it is worth a look. */
const QUIET_DAYS = 30;

/**
 * The capstone coordinator's screens.
 *
 * Everything else in this app is scoped to one group and one adviser. A person
 * running the program needs the opposite view: which groups have gone quiet,
 * who is carrying how many, and what the department's milestones even are.
 *
 * Three tabs because they are three jobs, not three views of one thing.
 */
export default function CoordinatorView({ token, profile }) {
  const [tab, setTab] = useState('groups');

  const tabs = [
    { key: 'groups', label: 'Groups' },
    { key: 'advisers', label: 'Advisers' },
    { key: 'milestones', label: 'Milestones' },
  ];

  return (
    <div className="animate-rise">
      <h1 className="text-h1 font-bold tracking-tight text-ink-900">Capstone program</h1>
      <p className="mt-1 text-body text-ink-500">
        {profile.department ?? 'Your department'} &middot; every group, who advises them, and how
        far along they are.
      </p>

      <div className="mt-5 flex gap-1 border-b border-ink-200">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-current={tab === item.key ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3.5 py-2 text-body font-semibold transition ${
              tab === item.key
                ? 'border-brand-700 text-brand-700'
                : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === 'groups' ? <GroupsTab token={token} /> : null}
        {tab === 'advisers' ? <AdvisersTab token={token} /> : null}
        {tab === 'milestones' ? <MilestonesTab token={token} /> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- groups -- */

function GroupsTab({ token }) {
  const [data, setData] = useState(null);
  const [advisers, setAdvisers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [overview, list] = await Promise.all([
        api('/coordinator/overview', { token }),
        api('/coordinator/advisers', { token }),
      ]);
      setData(overview);
      setAdvisers(list.advisers ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function assign(groupId, adviserId) {
    setBusy(groupId);
    setError('');
    try {
      await api(`/coordinator/groups/${groupId}/adviser`, {
        method: 'PATCH',
        token,
        body: { adviserId: adviserId || null },
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (error && !data) return <Problem message={error} />;
  if (!data) return <div className="skeleton h-64 rounded-2xl" />;

  const quiet = data.groups.filter((group) => isQuiet(group)).length;

  return (
    <>
      {error ? <Problem message={error} /> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Tally label="Groups" value={data.groups.length} />
        <Tally
          label="Unassigned"
          value={data.groups.filter((group) => !group.adviser_id).length}
          tone="warning"
        />
        <Tally label={`Quiet ${QUIET_DAYS}+ days`} value={quiet} tone={quiet ? 'alert' : 'ok'} />
      </div>

      {data.groups.length === 0 ? (
        <Empty>No groups have formed in your department yet.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white">
          <table className="w-full min-w-[52rem] text-left">
            <thead className="border-b border-ink-200 text-small text-ink-500">
              <tr>
                <Th>Group</Th>
                <Th>Adviser</Th>
                <Th>Progress</Th>
                <Th>Last session</Th>
                <Th>Open</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200">
              {data.groups.map((group) => (
                <tr key={group.id} className="align-middle">
                  <Td>
                    <p className="font-medium text-ink-900">{group.name}</p>
                    <p className="text-small text-ink-500">
                      {group.section} &middot; {group.member_count}{' '}
                      {group.member_count === 1 ? 'member' : 'members'}
                    </p>
                  </Td>
                  <Td>
                    <select
                      value={group.adviser_id ?? ''}
                      disabled={busy === group.id}
                      onChange={(event) => assign(group.id, event.target.value)}
                      className="w-full max-w-[13rem] rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] text-ink-900 transition hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15 disabled:opacity-60"
                    >
                      <option value="">Unassigned</option>
                      {advisers.map((adviser) => (
                        <option key={adviser.id} value={adviser.id}>
                          {adviser.full_name}
                          {adviser.adviser_capacity !== null
                            ? ` (${adviser.assigned_groups}/${adviser.adviser_capacity})`
                            : ''}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-200">
                        <div
                          className="h-full rounded-full bg-brand-700"
                          style={{ width: `${group.progress}%` }}
                        />
                      </div>
                      <span className="tnum text-small text-ink-600">{group.progress}%</span>
                    </div>
                  </Td>
                  <Td>
                    {group.last_session ? (
                      <span className={isQuiet(group) ? 'font-medium text-rose-600' : 'text-ink-700'}>
                        {shortDate.format(new Date(group.last_session))}
                        {isQuiet(group) ? ` · ${daysSince(group.last_session)}d ago` : ''}
                      </span>
                    ) : (
                      <span className="text-rose-600">None yet</span>
                    )}
                  </Td>
                  <Td>
                    <span className="tnum text-ink-700">{group.open_tasks}</span>
                    {group.awaiting_approval > 0 ? (
                      <span className="ml-2 rounded-full bg-gold-50 px-2 py-0.5 text-[10px] font-semibold text-gold-700">
                        {group.awaiting_approval} waiting
                      </span>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** A group with no session in the last month, or none at all. */
function isQuiet(group) {
  if (!group.last_session) return true;
  return daysSince(group.last_session) >= QUIET_DAYS;
}

function daysSince(value) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

/* -------------------------------------------------------------- advisers -- */

function AdvisersTab({ token }) {
  const [advisers, setAdvisers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api('/coordinator/advisers', { token });
      setAdvisers(result.advisers ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function setCapacity(adviserId, value) {
    setBusy(adviserId);
    setError('');
    try {
      await api(`/coordinator/advisers/${adviserId}`, {
        method: 'PATCH',
        token,
        body: { capacity: value === '' ? null : Number(value) },
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  if (error && !advisers) return <Problem message={error} />;
  if (!advisers) return <div className="skeleton h-64 rounded-2xl" />;

  return (
    <>
      {error ? <Problem message={error} /> : null}
      <p className="mb-4 text-body text-ink-500">
        How many groups each adviser carries, against the cap they accept. An assignment that
        would push someone past their cap is refused.
      </p>

      {advisers.length === 0 ? (
        <Empty>No advisers have completed registration in your department.</Empty>
      ) : (
        <ul className="divide-y divide-ink-200 rounded-xl border border-ink-200 bg-white">
          {advisers.map((adviser) => {
            const over =
              adviser.adviser_capacity !== null &&
              adviser.assigned_groups > adviser.adviser_capacity;
            return (
              <li key={adviser.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body font-medium text-ink-900">
                    {adviser.full_name}
                  </p>
                  <p className="truncate text-small text-ink-500">
                    {[adviser.faculty_position, adviser.email].filter(Boolean).join(' · ')}
                  </p>
                </div>

                <div className="text-right">
                  <p className={`tnum text-body font-semibold ${over ? 'text-rose-600' : 'text-ink-900'}`}>
                    {adviser.assigned_groups}
                    {adviser.adviser_capacity !== null ? ` / ${adviser.adviser_capacity}` : ''}
                  </p>
                  <p className="text-small text-ink-500">groups</p>
                </div>

                {/* Nothing stops an adviser being over a cap set after the fact,
                    so it is shown rather than silently corrected. */}
                {adviser.hour_blocks === 0 ? (
                  <span className="rounded-full bg-gold-50 px-2 py-0.5 text-[10px] font-semibold text-gold-700">
                    No hours published
                  </span>
                ) : null}

                <label className="flex items-center gap-2 text-small text-ink-500">
                  Cap
                  <input
                    type="number"
                    min={0}
                    max={99}
                    defaultValue={adviser.adviser_capacity ?? ''}
                    disabled={busy === adviser.id}
                    onBlur={(event) => {
                      const next = event.target.value;
                      const current = adviser.adviser_capacity ?? '';
                      if (String(next) !== String(current)) setCapacity(adviser.id, next);
                    }}
                    placeholder="none"
                    className="tnum w-20 rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[13px] text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15 disabled:opacity-60"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/* ------------------------------------------------------------ milestones -- */

/**
 * The department's capstone sequence.
 *
 * Renaming a step keeps its key, so a group that has already reached it keeps
 * that progress. Removing one hides it from the tracker without deleting what
 * any group achieved -- which is why nothing here cascades.
 */
function MilestonesTab({ token }) {
  const [steps, setSteps] = useState(null);
  const [department, setDepartment] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api('/program-milestones', { token })
      .then((result) => {
        setSteps(result.milestones ?? []);
        setDepartment(result.department ?? null);
      })
      .catch((err) => setError(err.message));
  }, [token]);

  const usingFallback = useMemo(
    () => Boolean(steps && department === null),
    [steps, department],
  );

  function edit(index, label) {
    setSteps((prev) => prev.map((item, i) => (i === index ? { ...item, label } : item)));
    setDirty(true);
  }

  function remove(index) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  function move(index, delta) {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setDirty(true);
  }

  function add() {
    setSteps((prev) => [...prev, { key: '', label: '' }]);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api('/coordinator/program-milestones', {
        method: 'PUT',
        token,
        body: { milestones: steps.map(({ key, label }) => ({ key: key || undefined, label })) },
      });
      setSteps(result.milestones ?? []);
      setDepartment(result.department ?? null);
      setDirty(false);
      setNotice('Sequence saved. Every group in the department is measured against it.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!steps) return <div className="skeleton h-64 rounded-2xl" />;

  return (
    <>
      {error ? <Problem message={error} /> : null}
      {notice ? (
        <p
          role="status"
          className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-body font-medium text-emerald-800"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      ) : null}

      <p className="mb-4 text-body text-ink-500">
        The steps your department&apos;s groups are measured against.
        {usingFallback
          ? ' You are on the default sequence; saving creates one of your own.'
          : ''}{' '}
        Renaming a step keeps the progress recorded against it.
      </p>

      <ul className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.key || `new-${index}`}
            className="flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2.5"
          >
            <GripVertical className="h-4 w-4 shrink-0 text-ink-300" aria-hidden="true" />
            <span className="tnum w-5 shrink-0 text-small text-ink-400">{index + 1}</span>
            <input
              value={step.label}
              onChange={(event) => edit(index, event.target.value)}
              placeholder="Step name"
              className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-[14px] text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15"
            />
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label={`Move ${step.label || 'step'} up`}
              className="rounded-lg px-2 py-1 text-small text-ink-500 transition hover:bg-ink-100 disabled:opacity-30"
            >
              Up
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === steps.length - 1}
              aria-label={`Move ${step.label || 'step'} down`}
              className="rounded-lg px-2 py-1 text-small text-ink-500 transition hover:bg-ink-100 disabled:opacity-30"
            >
              Down
            </button>
            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${step.label || 'step'}`}
              className="rounded-lg p-1.5 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3.5 py-2 text-body font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a step
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || steps.some((step) => !step.label.trim())}
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-body font-semibold text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Save sequence
        </button>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- pieces -- */

function Tally({ label, value, tone = 'neutral' }) {
  const tint =
    tone === 'alert'
      ? 'text-rose-600'
      : tone === 'warning'
        ? 'text-gold-700'
        : tone === 'ok'
          ? 'text-emerald-600'
          : 'text-ink-900';
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-4 py-3">
      <p className="text-small text-ink-500">{label}</p>
      <p className={`tnum mt-0.5 text-h2 font-semibold ${tint}`}>{value}</p>
    </div>
  );
}

function Th({ children }) {
  return <th className="px-4 py-2.5 font-medium">{children}</th>;
}

function Td({ children }) {
  return <td className="px-4 py-3 text-[13px]">{children}</td>;
}

function Problem({ message }) {
  return (
    <p
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-body font-medium text-rose-700"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

function Empty({ children }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 px-6 py-12 text-center">
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-ink-100">
        <Users className="h-5 w-5 text-ink-400" aria-hidden="true" />
      </span>
      <p className="mt-3 text-body text-ink-600">{children}</p>
    </div>
  );
}
