import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Building2,
  CalendarRange,
  Eye,
  EyeOff,
  GraduationCap,
  IdCard,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { DEPARTMENTS, DEPARTMENT_NAMES, YEAR_LEVELS } from '../lib/hau.js';

const RESEND_SECONDS = 60;
const CODE_LENGTH = 6;
const MIN_PASSWORD = 8;

/**
 * Four views:
 *   login   email + password
 *   email   step 1 of sign-up  - address only
 *   verify  step 2             - 6-digit code
 *   details step 3             - name, student ID, department, year, course, password
 */
export default function AuthScreen({ onAuthenticated }) {
  const [view, setView] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState(() => Array(CODE_LENGTH).fill(''));
  const [pendingSession, setPendingSession] = useState(null);
  const [details, setDetails] = useState({
    lastName: '',
    firstName: '',
    middleInitial: '',
    studentId: '',
    department: '',
    yearLevel: '',
    course: '',
    password: '',
    confirmPassword: '',
  });

  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);

  const inputsRef = useRef([]);
  const attemptedCodeRef = useRef('');
  const code = digits.join('');
  const busy = status !== 'idle';

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (view === 'verify') inputsRef.current[0]?.focus();
  }, [view]);

  function switchView(next) {
    setView(next);
    setError('');
    setNotice('');
  }

  function updateDetail(field, value) {
    setDetails((prev) =>
      // A new department invalidates the course chosen under the old one.
      field === 'department' ? { ...prev, department: value, course: '' } : { ...prev, [field]: value },
    );
  }

  /* ------------------------------------------------------------- 0. login - */
  async function handleLogin(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setStatus('working');
    try {
      const result = await api('/auth/login', {
        method: 'POST',
        body: { email: email.trim().toLowerCase(), password },
      });
      onAuthenticated({ ...result.session, profile: result.profile });
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus('idle');
    }
  }

  /* ---------------------------------------------------- 1. email -> code -- */
  async function handleStart(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setStatus('working');
    try {
      const result = await api('/auth/start', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      });
      setDigits(Array(CODE_LENGTH).fill(''));
      attemptedCodeRef.current = '';
      setNotice(result.message ?? 'Access code sent.');
      setCooldown(RESEND_SECONDS);
      setView('verify');
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus('idle');
    }
  }

  /* ------------------------------------------------- 2. code -> session --- */
  const verifyCode = useCallback(
    async (value) => {
      if (busy || value.length !== CODE_LENGTH) return;
      attemptedCodeRef.current = value;
      setError('');
      setStatus('working');
      try {
        const result = await api('/auth/verify-code', {
          method: 'POST',
          body: { email: email.trim().toLowerCase(), code: value },
        });

        // Someone who already finished sign-up goes straight in.
        if (result.profileComplete) {
          onAuthenticated({ ...result.session, profile: result.profile });
          return;
        }
        setPendingSession(result.session);
        setNotice('');
        setView('details');
      } catch (err) {
        setError(err.message);
        setDigits(Array(CODE_LENGTH).fill(''));
        inputsRef.current[0]?.focus();
      } finally {
        setStatus('idle');
      }
    },
    [busy, email, onAuthenticated],
  );

  useEffect(() => {
    if (code.length === CODE_LENGTH && attemptedCodeRef.current !== code) verifyCode(code);
  }, [code, verifyCode]);

  async function resendCode() {
    if (busy || cooldown > 0) return;
    setError('');
    setStatus('working');
    try {
      const result = await api('/auth/send-code', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      });
      setNotice(result.message ?? 'Access code sent.');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus('idle');
    }
  }

  /* ------------------------------------------------- 3. details + password */
  async function handleDetails(event) {
    event.preventDefault();
    if (busy) return;
    setError('');

    if (details.password !== details.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (details.password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }

    setStatus('working');
    try {
      const result = await api('/auth/complete-profile', {
        method: 'POST',
        token: pendingSession?.access_token,
        body: {
          lastName: details.lastName.trim(),
          firstName: details.firstName.trim(),
          middleInitial: details.middleInitial.trim(),
          studentId: details.studentId.trim(),
          department: details.department,
          course: details.course,
          yearLevel: details.yearLevel,
          password: details.password,
          refresh_token: pendingSession?.refresh_token,
        },
      });
      onAuthenticated({ ...result.session, profile: result.profile });
    } catch (err) {
      setError(err.message);
      if (err.status === 401) setView('email');
    } finally {
      setStatus('idle');
    }
  }

  /* ---------------------------------------------------------- code inputs - */
  function handleDigitChange(index, value) {
    const digit = value.replace(/\D/g, '').slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (digit && index < CODE_LENGTH - 1) inputsRef.current[index + 1]?.focus();
  }

  function handleDigitKeyDown(index, event) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      event.preventDefault();
      inputsRef.current[index - 1]?.focus();
      setDigits((prev) => {
        const next = [...prev];
        next[index - 1] = '';
        return next;
      });
    }
    if (event.key === 'ArrowLeft' && index > 0) inputsRef.current[index - 1]?.focus();
    if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) inputsRef.current[index + 1]?.focus();
  }

  function handlePaste(event) {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
    if (!pasted) return;
    event.preventDefault();
    const next = Array(CODE_LENGTH).fill('');
    pasted.split('').forEach((char, i) => {
      next[i] = char;
    });
    setDigits(next);
    inputsRef.current[Math.min(pasted.length, CODE_LENGTH - 1)]?.focus();
  }

  const courses = details.department ? DEPARTMENTS[details.department] ?? [] : [];
  const wide = view === 'details';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className={wide ? 'w-full max-w-2xl' : 'w-full max-w-md'}>
        <header className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-800 shadow-lg shadow-rose-800/20">
            <GraduationCap className="h-7 w-7 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">ConsultTrack</h1>
          <p className="mt-1 text-sm font-medium text-slate-500">Holy Angel University</p>
          <p className="text-sm text-slate-400">
            Academic consultation scheduling for thesis groups
          </p>
        </header>

        {view !== 'login' ? <Steps view={view} /> : null}

        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {/* ---------------------------------------------------------- login */}
          {view === 'login' ? (
            <form onSubmit={handleLogin} noValidate>
              <h2 className="text-lg font-semibold text-slate-900">Sign in</h2>
              <p className="mt-1 text-sm text-slate-500">
                Use the email and password you registered with.
              </p>

              <Field label="Email address" htmlFor="login-email" icon={Mail} className="mt-6">
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="juan.delacruz@gmail.com"
                  className={INPUT}
                />
              </Field>

              <Field label="Password" htmlFor="login-password" icon={Lock} className="mt-4">
                <PasswordInput
                  id="login-password"
                  autoComplete="current-password"
                  value={password}
                  onChange={setPassword}
                  visible={showPassword}
                  onToggle={() => setShowPassword((v) => !v)}
                />
              </Field>

              {error ? <ErrorNote message={error} /> : null}

              <SubmitButton busy={busy} label="Sign in" busyLabel="Signing in..." />

              <p className="mt-4 text-center text-sm text-slate-500">
                No account yet?{' '}
                <button
                  type="button"
                  onClick={() => switchView('email')}
                  className={LINK}
                >
                  Create one
                </button>
              </p>
            </form>
          ) : null}

          {/* ------------------------------------------------- step 1: email */}
          {view === 'email' ? (
            <form onSubmit={handleStart} noValidate>
              <BackLink onClick={() => switchView('login')}>Back to sign in</BackLink>

              <h2 className="text-lg font-semibold text-slate-900">Create your account</h2>
              <p className="mt-1 text-sm text-slate-500">
                Start with your email. We will send a 6-digit code to confirm it is yours.
              </p>

              <Field label="Email address" htmlFor="signup-email" icon={Mail} className="mt-6">
                <input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="juan.delacruz@gmail.com"
                  className={INPUT}
                />
              </Field>

              {error ? <ErrorNote message={error} /> : null}

              <SubmitButton busy={busy} label="Send access code" busyLabel="Sending code..." />
            </form>
          ) : null}

          {/* ------------------------------------------------ step 2: verify */}
          {view === 'verify' ? (
            <div>
              <BackLink onClick={() => switchView('email')}>Use a different email</BackLink>

              <h2 className="text-lg font-semibold text-slate-900">Enter your access code</h2>
              <p className="mt-1 text-sm text-slate-500">
                Sent to <span className="font-medium text-slate-700">{email}</span>. The code
                expires in 10 minutes.
              </p>

              <div
                className="mt-6 flex justify-between gap-2"
                onPaste={handlePaste}
                role="group"
                aria-label="6-digit access code"
              >
                {digits.map((digit, index) => (
                  <input
                    key={index}
                    ref={(element) => {
                      inputsRef.current[index] = element;
                    }}
                    type="text"
                    inputMode="numeric"
                    autoComplete={index === 0 ? 'one-time-code' : 'off'}
                    maxLength={1}
                    value={digit}
                    disabled={busy}
                    aria-label={`Digit ${index + 1}`}
                    onChange={(event) => handleDigitChange(index, event.target.value)}
                    onKeyDown={(event) => handleDigitKeyDown(index, event)}
                    onFocus={(event) => event.target.select()}
                    className="h-14 w-full rounded-xl border border-slate-300 bg-white text-center text-xl font-semibold text-slate-900 focus:border-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-800/20 disabled:bg-slate-50"
                  />
                ))}
              </div>

              {error ? <ErrorNote message={error} /> : null}
              {!error && notice ? (
                <p className="mt-4 flex items-start gap-2 text-sm text-emerald-700">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {notice}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => verifyCode(code)}
                disabled={busy || code.length !== CODE_LENGTH}
                className={BUTTON}
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Verifying...
                  </>
                ) : (
                  'Verify and continue'
                )}
              </button>

              <p className="mt-4 text-center text-sm text-slate-500">
                Did not get it?{' '}
                {cooldown > 0 ? (
                  <span className="text-slate-400">Resend in {cooldown}s</span>
                ) : (
                  <button type="button" onClick={resendCode} disabled={busy} className={LINK}>
                    Resend code
                  </button>
                )}
              </p>
            </div>
          ) : null}

          {/* ----------------------------------------------- step 3: details */}
          {view === 'details' ? (
            <form onSubmit={handleDetails} noValidate>
              <h2 className="text-lg font-semibold text-slate-900">Complete your profile</h2>
              <p className="mt-1 text-sm text-slate-500">
                <span className="font-medium text-emerald-700">{email} verified.</span> Tell us who
                you are and set a password.
              </p>

              <Legend>Student details</Legend>

              <div className="grid gap-4 sm:grid-cols-[2fr_2fr_1fr]">
                <Field label="Last name" htmlFor="last-name" icon={User}>
                  <input
                    id="last-name"
                    required
                    value={details.lastName}
                    onChange={(event) => updateDetail('lastName', event.target.value)}
                    placeholder="Dela Cruz"
                    className={INPUT}
                  />
                </Field>
                <Field label="First name" htmlFor="first-name">
                  <input
                    id="first-name"
                    required
                    value={details.firstName}
                    onChange={(event) => updateDetail('firstName', event.target.value)}
                    placeholder="Juan"
                    className={INPUT}
                  />
                </Field>
                <Field label="M.I." htmlFor="middle-initial" optional>
                  <input
                    id="middle-initial"
                    maxLength={1}
                    value={details.middleInitial}
                    onChange={(event) => updateDetail('middleInitial', event.target.value)}
                    placeholder="S"
                    className={`${INPUT} text-center uppercase`}
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Student ID" htmlFor="student-id" icon={IdCard}>
                  <input
                    id="student-id"
                    required
                    inputMode="numeric"
                    value={details.studentId}
                    onChange={(event) => updateDetail('studentId', event.target.value)}
                    placeholder="21-1234-567"
                    className={INPUT}
                  />
                </Field>

                <Field label="Year level" htmlFor="year-level" icon={CalendarRange}>
                  <select
                    id="year-level"
                    required
                    value={details.yearLevel}
                    onChange={(event) => updateDetail('yearLevel', event.target.value)}
                    className={INPUT}
                  >
                    <option value="">Select year level</option>
                    {YEAR_LEVELS.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Department" htmlFor="department" icon={Building2}>
                  <select
                    id="department"
                    required
                    value={details.department}
                    onChange={(event) => updateDetail('department', event.target.value)}
                    className={INPUT}
                  >
                    <option value="">Select department</option>
                    {DEPARTMENT_NAMES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Course" htmlFor="course" icon={BookOpen}>
                  <select
                    id="course"
                    required
                    disabled={!details.department}
                    value={details.course}
                    onChange={(event) => updateDetail('course', event.target.value)}
                    className={`${INPUT} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400`}
                  >
                    <option value="">
                      {details.department ? 'Select course' : 'Pick a department first'}
                    </option>
                    {courses.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Legend>Password</Legend>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Password" htmlFor="new-password" icon={Lock}>
                  <PasswordInput
                    id="new-password"
                    autoComplete="new-password"
                    value={details.password}
                    onChange={(value) => updateDetail('password', value)}
                    visible={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    At least {MIN_PASSWORD} characters.
                  </p>
                </Field>

                <Field label="Confirm password" htmlFor="confirm-password">
                  <PasswordInput
                    id="confirm-password"
                    autoComplete="new-password"
                    value={details.confirmPassword}
                    onChange={(value) => updateDetail('confirmPassword', value)}
                    visible={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                </Field>
              </div>

              {error ? <ErrorNote message={error} /> : null}

              <SubmitButton busy={busy} label="Finish sign-up" busyLabel="Saving..." />
            </form>
          ) : null}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Check your spam folder if the code does not arrive within a minute.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- small pieces -- */

const INPUT =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 placeholder:text-slate-400 focus:border-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-800/20';

const BUTTON =
  'mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-800 px-4 py-3 font-medium text-white transition hover:bg-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-800/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const LINK =
  'font-medium text-rose-800 underline-offset-2 hover:underline disabled:opacity-60';

const STEP_LABELS = [
  ['email', 'Email'],
  ['verify', 'Verify'],
  ['details', 'Details'],
];

function Steps({ view }) {
  const current = STEP_LABELS.findIndex(([key]) => key === view);
  return (
    <ol className="mb-4 flex items-center justify-center gap-2 text-xs">
      {STEP_LABELS.map(([key, label], index) => (
        <li key={key} className="flex items-center gap-2">
          <span
            className={
              index <= current
                ? 'flex items-center gap-1.5 font-medium text-rose-800'
                : 'flex items-center gap-1.5 text-slate-400'
            }
          >
            <span
              className={
                index <= current
                  ? 'flex h-5 w-5 items-center justify-center rounded-full bg-rose-800 text-[10px] font-semibold text-white'
                  : 'flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-500'
              }
            >
              {index + 1}
            </span>
            {label}
          </span>
          {index < STEP_LABELS.length - 1 ? (
            <span className={index < current ? 'h-px w-6 bg-rose-800' : 'h-px w-6 bg-slate-200'} />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function BackLink({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-rose-800"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {children}
    </button>
  );
}

function Field({ label, htmlFor, icon: Icon, optional = false, className = '', children }) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-slate-700"
      >
        {Icon ? <Icon className="h-4 w-4 text-slate-400" aria-hidden="true" /> : null}
        {label}
        {optional ? <span className="font-normal text-slate-400">(optional)</span> : null}
      </label>
      {children}
    </div>
  );
}

function Legend({ children }) {
  return (
    <p className="mb-3 mt-6 border-b border-slate-100 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
      {children}
    </p>
  );
}

function PasswordInput({ id, value, onChange, visible, onToggle, autoComplete }) {
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${INPUT} pr-11`}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-label={visible ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function SubmitButton({ busy, label, busyLabel }) {
  return (
    <button type="submit" disabled={busy} className={BUTTON}>
      {busy ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {busyLabel}
        </>
      ) : (
        <>
          {label}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </>
      )}
    </button>
  );
}

function ErrorNote({ message }) {
  return (
    <p
      role="alert"
      className="mt-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
