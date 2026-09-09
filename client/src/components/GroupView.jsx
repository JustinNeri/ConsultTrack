import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Crown,
  LogOut,
  Loader2,
  Mail,
  Pencil,
  Plus,
  UserMinus,
  Users,
} from 'lucide-react';
import { api } from '../lib/api.js';

/**
 * The thesis group screen.
 *
 * A group used to be whatever string you typed into the booking form, which
 * meant a typo split a group in two and neither half could see the other's
 * sessions. Here it is a thing you create once and other people join with a
 * code, and every consultation any member books belongs to all of them.
 *
 * Three states: no group (create or join), in a group (roster and code), and
 * no section on the profile, which blocks creating one because the section is
 * what makes a group name unique.
 */
export default function GroupView({ profile, onGroupChanged }) {
  const [group, setGroup] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await api('/thesis-groups/mine', { token: profile.token });
      setGroup(result.group ?? null);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [profile.token]);

  useEffect(() => {
    load();
  }, [load]);

  /** Every mutation returns the group, so they all settle the same way. */
  async function run(key, request) {
    if (busy) return;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const result = await request();
      setGroup(result?.group ?? null);
      onGroupChanged?.();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="skeleton h-8 w-52 rounded-lg" />
        <div className="skeleton h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="animate-rise max-w-3xl">
      <h1 className="text-h1 font-bold tracking-tight text-ink-900">My thesis group</h1>
      <p className="mt-1 text-body text-ink-500">
        {group
          ? 'Every consultation any member books belongs to the whole group.'
          : 'Create a group, or join one with the code your leader shares.'}
      </p>

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
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {notice}
        </p>
      ) : null}

      {group ? (
        <GroupDetail
          group={group}
          profile={profile}
          busy={busy}
          onRename={(name) =>
            run('rename', () =>
              api('/thesis-groups/mine', { method: 'PATCH', token: profile.token, body: { name } }),
            )
          }
          onRemove={(memberId) =>
            run(`remove-${memberId}`, () =>
              api(`/thesis-groups/mine/members/${memberId}`, {
                method: 'DELETE',
                token: profile.token,
              }),
            )
          }
          onLeave={() =>
            run('leave', async () => {
              await api('/thesis-groups/leave', { method: 'POST', token: profile.token });
              return { group: null };
            })
          }
          onCopied={() => setNotice('Join code copied. Send it to your group mates.')}
        />
      ) : (
        <NoGroup
          profile={profile}
          busy={busy}
          onCreate={(name) =>
            run('create', () =>
              api('/thesis-groups', { method: 'POST', token: profile.token, body: { name } }),
            )
          }
          onJoin={(code) =>
            run('join', () =>
              api('/thesis-groups/join', {
                method: 'POST',
                token: profile.token,
                body: { code },
              }),
            )
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- no group -- */

function NoGroup({ profile, busy, onCreate, onJoin }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  // The section is what makes a group name unique, so a profile without one
  // cannot create a group. Older accounts predate the field.
  const section = (profile.section ?? '').trim();

  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      <section className="rounded-2xl border border-ink-200 bg-white p-5">
        <p className="flex items-center gap-2 text-h3 font-semibold text-ink-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <Plus className="h-4 w-4" aria-hidden="true" />
          </span>
          Create a group
        </p>
        <p className="mt-1.5 text-body text-ink-500">
          You become the leader and get a code to share with your group mates.
        </p>

        {section ? (
          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) onCreate(name.trim());
            }}
          >
            <label htmlFor="group-name" className="mb-1.5 block text-[12px] font-medium text-ink-700">
              Group name
            </label>
            <input
              id="group-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Group 7 - Campus Navigation"
              className={INPUT}
            />
            <p className="mt-1.5 text-small text-ink-500">
              Unique within section {section}.
            </p>
            <button
              type="submit"
              disabled={Boolean(busy) || name.trim().length < 2}
              className={PRIMARY}
            >
              {busy === 'create' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4" aria-hidden="true" />
              )}
              Create group
            </button>
          </form>
        ) : (
          <p className="mt-4 rounded-xl border border-gold-200 bg-gold-50/60 px-3.5 py-3 text-body text-gold-800">
            Your profile has no section yet. Ask your adviser or the registrar to set it, then
            come back here.
          </p>
        )}
      </section>

      <section className="rounded-2xl border border-ink-200 bg-white p-5">
        <p className="flex items-center gap-2 text-h3 font-semibold text-ink-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <Users className="h-4 w-4" aria-hidden="true" />
          </span>
          Join a group
        </p>
        <p className="mt-1.5 text-body text-ink-500">
          Enter the six-character code from whoever created it.
        </p>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim().length === 6) onJoin(code.trim().toUpperCase());
          }}
        >
          <label htmlFor="join-code" className="mb-1.5 block text-[12px] font-medium text-ink-700">
            Join code
          </label>
          <input
            id="join-code"
            required
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
            }
            placeholder="K7M2QP"
            className={`${INPUT} tnum text-center text-[20px] font-semibold tracking-[0.3em]`}
          />
          <button
            type="submit"
            disabled={Boolean(busy) || code.trim().length !== 6}
            className={PRIMARY}
          >
            {busy === 'join' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Users className="h-4 w-4" aria-hidden="true" />
            )}
            Join group
          </button>
        </form>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ the group -- */

function GroupDetail({ group, profile, busy, onRename, onRemove, onLeave, onCopied }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const me = group.members.find((member) => member.id === profile.id);
  const isLeader = me?.role === 'leader';

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(group.join_code);
      onCopied();
    } catch {
      // Clipboard access can be refused; the code is on screen either way.
    }
  }

  return (
    <>
      <section className="mt-6 overflow-hidden rounded-2xl border border-ink-200 bg-white">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-200 p-5">
          <div className="min-w-0">
            {renaming ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = draft.trim();
                  if (next.length >= 2 && next !== group.name) onRename(next);
                  setRenaming(false);
                }}
              >
                <input
                  autoFocus
                  maxLength={120}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  className={`${INPUT} max-w-xs`}
                />
                <button type="submit" className={SMALL_PRIMARY}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(group.name);
                    setRenaming(false);
                  }}
                  className={SMALL_GHOST}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="truncate text-h2 font-semibold tracking-tight text-ink-900">
                  {group.name}
                </h2>
                {isLeader ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    aria-label="Rename group"
                    className="rounded-lg p-1.5 text-ink-400 transition hover:bg-ink-100 hover:text-ink-900"
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            )}
            <p className="mt-1 text-body text-ink-500">
              Section {group.section}
              {group.department ? ` · ${group.department}` : ''} ·{' '}
              {group.members.length} {group.members.length === 1 ? 'member' : 'members'}
            </p>
          </div>

          {/* The code is the only way in, so it is the thing this card is for. */}
          <div className="rounded-xl border border-ink-200 bg-ink-50 px-4 py-3">
            <p className="text-small text-ink-500">Join code</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="tnum text-h2 font-semibold tracking-[0.2em] text-ink-900">
                {group.join_code}
              </span>
              <button
                type="button"
                onClick={copyCode}
                aria-label="Copy join code"
                className="rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-200 hover:text-ink-900"
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <ul className="divide-y divide-ink-200">
          {group.members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-5 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-700 text-[11px] font-semibold text-white">
                {initialsOf(member.full_name || member.email)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-body font-medium text-ink-900">
                  {member.full_name || member.email}
                  {member.role === 'leader' ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold-50 px-2 py-0.5 text-[10px] font-semibold text-gold-700">
                      <Crown className="h-3 w-3" aria-hidden="true" />
                      Leader
                    </span>
                  ) : null}
                  {member.id === profile.id ? (
                    <span className="shrink-0 text-small font-normal text-ink-400">(you)</span>
                  ) : null}
                </p>
                <p className="truncate text-small text-ink-500">
                  {[member.student_id, member.course, member.year_level]
                    .filter(Boolean)
                    .join(' · ') || member.email}
                </p>
              </div>

              {member.email ? (
                <a
                  href={`mailto:${member.email}`}
                  aria-label={`Email ${member.full_name || member.email}`}
                  className="rounded-lg p-2 text-ink-400 transition hover:bg-ink-100 hover:text-ink-900"
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : null}

              {isLeader && member.id !== profile.id ? (
                <button
                  type="button"
                  onClick={() => onRemove(member.id)}
                  disabled={Boolean(busy)}
                  aria-label={`Remove ${member.full_name || member.email}`}
                  className="rounded-lg p-2 text-ink-400 transition hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                >
                  {busy === `remove-${member.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4 rounded-2xl border border-ink-200 bg-white p-5">
        <p className="text-h3 font-semibold text-ink-900">Leave this group</p>
        <p className="mt-1 text-body text-ink-500">
          You stop seeing its consultations and action items. Sessions already held stay on the
          group&apos;s record.
          {isLeader && group.members.length > 1
            ? ' Leadership passes to the longest-standing member.'
            : ''}
          {group.members.length === 1 ? ' You are the last member, so the group is deleted.' : ''}
        </p>

        {confirmLeave ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onLeave}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-body font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60"
            >
              {busy === 'leave' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="h-4 w-4" aria-hidden="true" />
              )}
              Yes, leave the group
            </button>
            <button type="button" onClick={() => setConfirmLeave(false)} className={SMALL_GHOST}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-3.5 py-2 text-body font-semibold text-ink-700 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Leave group
          </button>
        )}
      </section>
    </>
  );
}

/* --------------------------------------------------------------- pieces -- */

function initialsOf(name) {
  return (
    (name || '?')
      .replace(/[^\p{L}\s,]/gu, '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || '?'
  );
}

const INPUT =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';

const PRIMARY =
  'mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-brand-600 active:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60';

const SMALL_PRIMARY =
  'rounded-lg bg-brand-700 px-3 py-2 text-[13px] font-semibold text-white transition hover:bg-brand-600';

const SMALL_GHOST =
  'rounded-lg border border-ink-200 px-3 py-2 text-[13px] font-semibold text-ink-700 transition hover:border-ink-300 hover:bg-ink-50';
