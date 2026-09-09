import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Briefcase,
  Building2,
  CalendarCheck,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Eye,
  EyeOff,
  GraduationCap,
  IdCard,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
  User,
  Users,
} from 'lucide-react';
import Logo from './Logo.jsx';
import { api } from '../lib/api.js';
import {
  DEPARTMENTS,
  DEPARTMENT_NAMES,
  FACULTY_POSITIONS,
  YEAR_LEVELS,
  roleForEmail,
} from '../lib/hau.js';

const RESEND_SECONDS = 60;
// Mirrors HAU_DOMAINS in the API. Shown as guidance only -- the server is what
// actually enforces the rule, and it can allowlist test addresses.
const HAU_EMAIL_HINT = 'Only HAU accounts (@student.hau.edu.ph or @hau.edu.ph) can register.';
const CODE_LENGTH = 6;
const MIN_PASSWORD = 8;
/*
 * Campus photograph behind the sign-in screen. It lives in client/public, so
 * the path is site-absolute. A missing file just leaves flat maroon.
 */
const AUTH_BACKDROP = '/campus.jpg';

/*
 * The three views that stand alone on the photograph rather than inside the
 * sign-up card: sign in, and the two halves of a password reset. They share a
 * shape -- headline, one card, one link underneath -- so they share a table
 * rather than three near-identical blocks of JSX.
 */
const SOLO = {
  login: {
    title: 'Welcome back',
    subtitle: 'Sign in to book and track your consultations.',
    label: 'Sign in',
    busyLabel: 'Signing in...',
  },
  forgot: {
    title: 'Reset your password',
    subtitle: 'We will email you a 6-digit code to confirm the account is yours.',
    label: 'Send reset code',
    busyLabel: 'Sending code...',
  },
  reset: {
    title: 'Choose a new password',
    subtitle: 'Enter the code from your email, then pick the password you will use from now on.',
    label: 'Update password',
    busyLabel: 'Updating...',
  },
};

/**
 * Four views:
 *   login   email + password
 *   email   step 1 of sign-up  - address only
 *   verify  step 2             - 6-digit code
 *   details step 3             - name, student ID, department, year, course,
 *                                 section, password
 */
export default function AuthScreen({ onAuthenticated }) {
  const [view, setView] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [digits, setDigits] = useState(() => Array(CODE_LENGTH).fill(''));
  const [pendingSession, setPendingSession] = useState(null);
  // Which form step 3 shows. The server decides this from the verified address;
  // the local guess only pre-labels the email step.
  const [pendingRole, setPendingRole] = useState('student');
  const [details, setDetails] = useState({
    lastName: '',
    firstName: '',
    middleInitial: '',
    studentId: '',
    department: '',
    yearLevel: '',
    course: '',
    section: '',
    employeeId: '',
    facultyPosition: '',
    password: '',
    confirmPassword: '',
  });

  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  // The reset flow's own password pair. Kept apart from `details.password` so a
  // half-typed sign-up and a half-typed reset can never bleed into each other.
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

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
    if (view === 'verify' || view === 'reset') inputsRef.current[0]?.focus();
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

  /* -------------------------------------------------- forgot password ----- */
  async function handleForgot(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setStatus('working');
    try {
      const result = await api('/auth/forgot-password', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      });
      setDigits(Array(CODE_LENGTH).fill(''));
      attemptedCodeRef.current = '';
      setNewPassword('');
      setNewPassword2('');
      setNotice(result.message ?? 'If that address has an account, a reset code is on its way.');
      setCooldown(RESEND_SECONDS);
      setView('reset');
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus('idle');
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    if (busy) return;
    setError('');

    if (code.length !== CODE_LENGTH) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    if (newPassword !== newPassword2) {
      setError('Passwords do not match.');
      return;
    }
    if (newPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }

    setStatus('working');
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: { email: email.trim().toLowerCase(), code, password: newPassword },
      });
      // Land back on sign-in rather than straight into the app: typing the new
      // password once is what proves it is the one they meant.
      setPassword('');
      setNewPassword('');
      setNewPassword2('');
      setDigits(Array(CODE_LENGTH).fill(''));
      attemptedCodeRef.current = '';
      setView('login');
      setNotice('Password updated. Sign in with your new password.');
    } catch (err) {
      setError(err.message);
      setDigits(Array(CODE_LENGTH).fill(''));
      inputsRef.current[0]?.focus();
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
        setPendingRole(result.profile?.role ?? roleForEmail(email) ?? 'student');
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
    // Only the sign-up step submits itself the moment the code is complete. The
    // reset form has a password beside the digits, so it waits to be submitted.
    if (view !== 'verify') return;
    if (code.length === CODE_LENGTH && attemptedCodeRef.current !== code) verifyCode(code);
  }, [view, code, verifyCode]);

  async function resendCode() {
    if (busy || cooldown > 0) return;
    setError('');
    setStatus('working');
    try {
      // Same six digits, different door: /auth/send-code only resends for a
      // sign-up that has not finished, which is exactly what a reset is not.
      const path = view === 'reset' ? '/auth/forgot-password' : '/auth/send-code';
      const result = await api(path, {
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
          department: details.department,
          password: details.password,
          refresh_token: pendingSession?.refresh_token,
          ...(pendingRole === 'adviser'
            ? {
                employeeId: details.employeeId.trim(),
                facultyPosition: details.facultyPosition,
              }
            : {
                studentId: details.studentId.trim(),
                course: details.course,
                yearLevel: details.yearLevel,
                section: details.section.trim().toUpperCase(),
              }),
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
  const isAdviser = pendingRole === 'adviser';
  const typedRole = roleForEmail(email);

  /*
   * Sign-in gets the full-bleed treatment: a campus photograph under a maroon
   * wash, the wordmark and headline set directly on it, and the form alone in a
   * card floating above. Sign-up keeps the two-column card -- three steps of
   * fields need the room -- but stands on the same backdrop, so the two screens
   * read as one place rather than two products.
   */
  if (SOLO[view]) {
    const copy = SOLO[view];
    const onSubmit =
      view === 'login' ? handleLogin : view === 'forgot' ? handleForgot : handleReset;

    return (
      <AuthShell>
        <div className="animate-rise w-full max-w-[420px] [text-shadow:0_1px_14px_rgba(20,4,10,0.55)]">
          <div className="flex items-center gap-2.5">
            <Logo className="h-10 w-10 shrink-0 drop-shadow-[0_2px_10px_rgba(20,4,10,0.45)]" />
            <span className="leading-tight">
              <span className="block text-[17px] font-semibold tracking-tight text-white">
                ConsultTrack
              </span>
              <span className="block text-[11px] text-brand-100/70">Holy Angel University</span>
            </span>
          </div>

          <h1 className="mt-9 text-[38px] font-bold leading-[1.05] tracking-[-0.03em] text-white drop-shadow-[0_2px_18px_rgba(20,4,10,0.5)] sm:text-[42px]">
            {copy.title}
          </h1>
          <p className="mt-2.5 text-[14px] text-brand-100/85">{copy.subtitle}</p>

          <form
            onSubmit={onSubmit}
            noValidate
            /* text-shadow inherits: the glow is for type on the photograph, not
               for dark text on a white card, where it only reads as blur. */
            className="mt-7 rounded-2xl bg-white p-6 shadow-[0_28px_70px_-24px_rgba(20,4,10,0.75)] [text-shadow:none] sm:p-7"
          >
            {view === 'login' ? (
              <>
                <Field label="Email address" htmlFor="login-email" icon={Mail}>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="juan.delacruz@student.hau.edu.ph"
                    className={INPUT}
                  />
                </Field>

                <Field
                  label="Password"
                  htmlFor="login-password"
                  icon={Lock}
                  className="mt-4"
                  action={
                    <button type="button" onClick={() => switchView('forgot')} className={LINK}>
                      Forgot password?
                    </button>
                  }
                >
                  <PasswordInput
                    id="login-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={setPassword}
                    visible={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                </Field>
              </>
            ) : null}

            {view === 'forgot' ? (
              <Field label="Email address" htmlFor="forgot-email" icon={Mail}>
                <input
                  id="forgot-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="juan.delacruz@student.hau.edu.ph"
                  className={INPUT}
                />
                <p className="mt-2 text-xs text-ink-500">
                  Use the HAU address you registered with. The code expires in 10 minutes.
                </p>
              </Field>
            ) : null}

            {view === 'reset' ? (
              <>
                <p className="text-[12px] font-medium text-ink-700">
                  Reset code{' '}
                  <span className="font-normal text-ink-500">
                    &mdash; sent to <span className="font-semibold text-ink-800">{email}</span>
                  </span>
                </p>
                <CodeInputs
                  digits={digits}
                  busy={busy}
                  inputsRef={inputsRef}
                  onChange={handleDigitChange}
                  onKeyDown={handleDigitKeyDown}
                  onPaste={handlePaste}
                  label="6-digit reset code"
                  className="mt-2.5"
                />

                <Field label="New password" htmlFor="reset-password" icon={Lock} className="mt-5">
                  <PasswordInput
                    id="reset-password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={setNewPassword}
                    visible={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                  <p className="mt-1.5 text-xs text-ink-500">At least {MIN_PASSWORD} characters.</p>
                </Field>

                <Field
                  label="Confirm new password"
                  htmlFor="reset-confirm"
                  icon={Lock}
                  className="mt-4"
                >
                  <PasswordInput
                    id="reset-confirm"
                    autoComplete="new-password"
                    value={newPassword2}
                    onChange={setNewPassword2}
                    visible={showPassword}
                    onToggle={() => setShowPassword((v) => !v)}
                  />
                </Field>
              </>
            ) : null}

            {error ? <ErrorNote message={error} /> : null}
            {!error && notice ? <NoticeNote message={notice} /> : null}

            <SubmitButton busy={busy} label={copy.label} busyLabel={copy.busyLabel} />

            {view === 'reset' ? (
              <p className="mt-4 text-center text-sm text-ink-500">
                Did not get it?{' '}
                {cooldown > 0 ? (
                  <span className="font-semibold text-ink-400">Resend in {cooldown}s</span>
                ) : (
                  <button type="button" onClick={resendCode} disabled={busy} className={LINK}>
                    Resend code
                  </button>
                )}
              </p>
            ) : null}
          </form>

          <p className="mt-6 text-center text-[13px] text-brand-100/90">
            {view === 'login' ? (
              <>
                First time here?{' '}
                <button
                  type="button"
                  onClick={() => switchView('email')}
                  className="font-semibold text-white underline underline-offset-4 transition hover:text-brand-100"
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Remembered it?{' '}
                <button
                  type="button"
                  onClick={() => switchView('login')}
                  className="font-semibold text-white underline underline-offset-4 transition hover:text-brand-100"
                >
                  Back to sign in
                </button>
              </>
            )}
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className={`w-full transition-all duration-300 ${wide ? 'max-w-6xl' : 'max-w-5xl'}`}>
        <div className="animate-rise overflow-hidden rounded-2xl border border-white/10 bg-white shadow-[0_28px_70px_-24px_rgba(20,4,10,0.75)]">
          <div className="grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
            <BrandPanel view={view} />

            {/* ------------------------------------------------- form column */}
            <div className="scrollbar-slim flex max-h-[calc(100vh-3rem)] flex-col justify-center overflow-y-auto p-6 sm:p-10">
              <MobileBrandBar />

              <Steps view={view} />

              {/* --------------------------------------------- step 1: email */}
              {view === 'email' ? (
                <form onSubmit={handleStart} noValidate>
                  <BackLink onClick={() => switchView('login')}>Back to sign in</BackLink>

                  <FormHeading
                    eyebrow="Step 1 of 3"
                    title="Create your account"
                    subtitle="Start with your HAU email. We will send a 6-digit code to confirm it is yours."
                  />

                  <Field label="Email address" htmlFor="signup-email" icon={Mail} className="mt-7">
                    <input
                      id="signup-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="juan.delacruz@student.hau.edu.ph"
                      className={INPUT}
                    />
                    {typedRole ? (
                      <p
                        className={`mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${
                          typedRole === 'adviser'
                            ? 'bg-indigo-50 text-indigo-700'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {typedRole === 'adviser' ? (
                          <Briefcase className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        ) : (
                          <GraduationCap className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        )}
                        {typedRole === 'adviser'
                          ? 'Faculty address - this creates an adviser account.'
                          : 'Student address - this creates a student account.'}
                      </p>
                    ) : (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-500">
                        <ShieldCheck
                          className="mt-px h-3.5 w-3.5 shrink-0 text-brand-600"
                          aria-hidden="true"
                        />
                        {HAU_EMAIL_HINT}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-ink-400">
                      Students use @student.hau.edu.ph; advisers use their @hau.edu.ph faculty
                      address.
                    </p>
                  </Field>

                  {error ? <ErrorNote message={error} /> : null}

                  <SubmitButton busy={busy} label="Send access code" busyLabel="Sending code..." />

                  <Divider />

                  <p className="text-center text-sm text-ink-500">
                    Already registered?{' '}
                    <button type="button" onClick={() => switchView('login')} className={LINK}>
                      Sign in
                    </button>
                  </p>
                </form>
              ) : null}

              {/* -------------------------------------------- step 2: verify */}
              {view === 'verify' ? (
                <div>
                  <BackLink onClick={() => switchView('email')}>Use a different email</BackLink>

                  <FormHeading eyebrow="Step 2 of 3" title="Enter your access code" />
                  <p className="mt-2 text-sm text-ink-500">
                    Sent to <span className="font-semibold text-ink-800">{email}</span>. The code
                    expires in 10 minutes.
                  </p>

                  <CodeInputs
                    digits={digits}
                    busy={busy}
                    inputsRef={inputsRef}
                    onChange={handleDigitChange}
                    onKeyDown={handleDigitKeyDown}
                    onPaste={handlePaste}
                    label="6-digit access code"
                    className="mt-7"
                  />

                  {error ? <ErrorNote message={error} /> : null}
                  {!error && notice ? <NoticeNote message={notice} /> : null}

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
                      <>
                        Verify and continue
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </>
                    )}
                  </button>

                  <Divider />

                  <p className="text-center text-sm text-ink-500">
                    Did not get it?{' '}
                    {cooldown > 0 ? (
                      <span className="font-semibold text-ink-400">Resend in {cooldown}s</span>
                    ) : (
                      <button type="button" onClick={resendCode} disabled={busy} className={LINK}>
                        Resend code
                      </button>
                    )}
                  </p>
                </div>
              ) : null}

              {/* ------------------------------------------- step 3: details */}
              {view === 'details' ? (
                <form onSubmit={handleDetails} noValidate>
                  <FormHeading eyebrow="Step 3 of 3" title="Complete your profile" />
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-500">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {email} verified
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        isAdviser ? 'bg-indigo-50 text-indigo-700' : 'bg-brand-50 text-brand-700'
                      }`}
                    >
                      {isAdviser ? (
                        <Briefcase className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {isAdviser ? 'Adviser account' : 'Student account'}
                    </span>
                    Tell us who you are and set a password.
                  </div>

                  <Legend>{isAdviser ? 'Faculty details' : 'Student details'}</Legend>

                  <div className="grid gap-4 sm:grid-cols-[2fr_2fr_1fr]">
                    <Field label="Last name" htmlFor="last-name" icon={User}>
                      <input
                        id="last-name"
                        required
                        value={details.lastName}
                        onChange={(event) => updateDetail('lastName', event.target.value)}
                        placeholder={isAdviser ? 'Santos' : 'Dela Cruz'}
                        className={INPUT}
                      />
                    </Field>
                    <Field label="First name" htmlFor="first-name">
                      <input
                        id="first-name"
                        required
                        value={details.firstName}
                        onChange={(event) => updateDetail('firstName', event.target.value)}
                        placeholder={isAdviser ? 'Maria' : 'Juan'}
                        className={INPUT}
                      />
                    </Field>
                    <Field label="M.I." htmlFor="middle-initial" optional>
                      <input
                        id="middle-initial"
                        maxLength={1}
                        value={details.middleInitial}
                        onChange={(event) => updateDetail('middleInitial', event.target.value)}
                        placeholder={isAdviser ? 'L' : 'S'}
                        className={`${INPUT} text-center uppercase`}
                      />
                    </Field>
                  </div>

                  {isAdviser ? (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Faculty ID" htmlFor="employee-id" icon={IdCard}>
                          <input
                            id="employee-id"
                            required
                            value={details.employeeId}
                            onChange={(event) => updateDetail('employeeId', event.target.value)}
                            placeholder="FAC-10234"
                            className={INPUT}
                          />
                        </Field>

                        <Field
                          label="Academic position"
                          htmlFor="faculty-position"
                          icon={Briefcase}
                          optional
                        >
                          <select
                            id="faculty-position"
                            value={details.facultyPosition}
                            onChange={(event) =>
                              updateDetail('facultyPosition', event.target.value)
                            }
                            className={INPUT}
                          >
                            <option value="">Select position</option>
                            {FACULTY_POSITIONS.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>

                      <Field
                        label="Department"
                        htmlFor="department"
                        icon={Building2}
                        className="mt-4"
                      >
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
                    </>
                  ) : (
                    <>
                      <div className="grid gap-4 sm:grid-cols-2">
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

                      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

                        <Field label="Section" htmlFor="section" icon={Users}>
                          <input
                            id="section"
                            required
                            maxLength={20}
                            value={details.section}
                            onChange={(event) =>
                              updateDetail('section', event.target.value.toUpperCase())
                            }
                            placeholder="CS-401"
                            className={`${INPUT} uppercase`}
                          />
                          <p className="mt-1.5 text-[12px] text-ink-500">
                            Your class section. Thesis group names are unique within it.
                          </p>
                        </Field>

                        <Field label="Course" htmlFor="course" icon={BookOpen}>
                          <select
                            id="course"
                            required
                            disabled={!details.department}
                            value={details.course}
                            onChange={(event) => updateDetail('course', event.target.value)}
                            className={`${INPUT} disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-400`}
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
                    </>
                  )}

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
                      <p className="mt-1.5 text-xs text-ink-400">
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
          </div>
        </div>

        {view === 'email' || view === 'verify' ? (
          <p className="mt-5 text-center text-xs text-brand-100/80 [text-shadow:0_1px_10px_rgba(20,4,10,0.6)]">
            Check your spam folder if the code does not arrive within a minute.
          </p>
        ) : null}
      </div>
    </AuthShell>
  );
}

/* ------------------------------------------------------------- auth shell -- */

/*
 * Both auth screens stand on the same ground: the campus photograph under a
 * maroon wash. The wash is deliberately uneven -- a light flat tint everywhere
 * so the whole frame reads maroon, then the real darkening pooled behind the
 * column of type and falling off toward the edges. Spreading the same density
 * over the entire frame is what buries the photograph; concentrating it buys
 * the contrast the white type needs and leaves the campus visible around it.
 */
function AuthShell({ children }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div aria-hidden="true" className="absolute inset-0">
        {/* What shows if the photograph is missing: flat maroon, still on-brand. */}
        <div className="absolute inset-0 bg-brand-950" />
        <div
          className="absolute inset-0 bg-cover bg-center saturate-[0.85]"
          style={{ backgroundImage: `url('${AUTH_BACKDROP}')` }}
        />
        {/* One light pass so no corner of the photo escapes the brand colour. */}
        <div className="absolute inset-0 bg-brand-950/25" />
        {/* The scrim that actually earns the contrast, centred on the type. */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_65%_60%_at_50%_44%,rgba(42,9,18,0.74),rgba(42,9,18,0.12)_78%)]" />
        {/* Top and bottom falloff, so the frame is anchored rather than floating. */}
        <div className="absolute inset-0 bg-gradient-to-b from-brand-950/70 via-transparent to-brand-950/35" />
      </div>

      <div className="relative flex w-full flex-col items-center">{children}</div>

      <p className="relative mt-10 text-center text-[11px] text-white/55 [text-shadow:0_1px_10px_rgba(20,4,10,0.6)]">
        Holy Angel University &middot; ConsultTrack
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ brand panel -- */

const HIGHLIGHTS = [
  {
    icon: CalendarCheck,
    title: 'Book an open slot',
    body: 'Advisers publish their consultation hours; you pick a time that already works.',
  },
  {
    icon: ClipboardList,
    title: 'Never lose an action item',
    body: 'Every task raised during a consultation is tracked until you tick it off.',
  },
  {
    icon: Sparkles,
    title: 'Watch the capstone move',
    body: 'Milestones from title proposal to final defense, in one progress bar.',
  },
];

/*
 * The sign-in panel is the first thing anyone sees of ConsultTrack, so it
 * carries the institution: near-black ground, crimson mark, and three lines
 * about what the product does. The blurred blobs and grid overlay it replaces
 * were decoration standing where the proposition should be.
 */
function BrandPanel({ view }) {
  return (
    <div className="relative hidden bg-gradient-to-b from-brand-900 to-brand-950 p-10 lg:flex lg:flex-col">
      <div className="flex items-center gap-2.5">
        <Logo className="h-9 w-9 shrink-0" />
        <span className="leading-tight">
          <span className="block text-[15px] font-semibold tracking-tight text-white">
            ConsultTrack
          </span>
          <span className="block text-[11px] text-brand-200/80">Holy Angel University</span>
        </span>
      </div>

      <h2 className="mt-14 text-[32px] font-semibold leading-[1.15] tracking-[-0.025em] text-white">
        {view === 'login' ? (
          <>
            Your capstone,
            <br />
            on schedule.
          </>
        ) : (
          <>
            Three quick steps
            <br />
            to get started.
          </>
        )}
      </h2>
      <p className="mt-4 max-w-sm text-[13px] leading-relaxed text-brand-100/75">
        Consultation scheduling built for HAU thesis groups &mdash; one place for sessions,
        advisers and the tasks that come out of them.
      </p>

      <ul className="mt-12 space-y-6">
        {HIGHLIGHTS.map(({ icon: Icon, title, body }, index) => (
          <li
            key={title}
            style={{ '--delay': `${140 + index * 80}ms` }}
            className="animate-rise flex gap-3.5"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-brand-200 ring-1 ring-white/15">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-white">{title}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-brand-100/70">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-auto border-t border-white/[0.12] pt-6 text-[11px] text-brand-200/60">
        Built for the Holy Angel University capstone program.
      </p>
    </div>
  );
}

function MobileBrandBar() {
  return (
    <div className="mb-8 flex items-center gap-2.5 lg:hidden">
      <Logo className="h-9 w-9 shrink-0" />
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-tight text-ink-900">
          ConsultTrack
        </span>
        <span className="block text-[11px] text-ink-500">Holy Angel University</span>
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- small pieces -- */

const INPUT =
  'w-full rounded-lg border border-ink-200 bg-white px-3.5 py-2.5 text-[14px] text-ink-900 transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15';

const BUTTON =
  'mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-4 py-2.5 text-[14px] font-semibold text-white transition hover:bg-brand-600 active:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-60';

const LINK = 'font-semibold text-brand-700 underline-offset-2 hover:underline disabled:opacity-60';

const STEP_LABELS = [
  ['email', 'Email'],
  ['verify', 'Verify'],
  ['details', 'Details'],
];

function Steps({ view }) {
  const current = STEP_LABELS.findIndex(([key]) => key === view);
  return (
    <ol className="mb-8 flex items-center gap-2 text-[12px]">
      {STEP_LABELS.map(([key, label], index) => (
        <li key={key} className="flex flex-1 items-center gap-2">
          <span
            className={
              index <= current
                ? 'flex items-center gap-2 font-bold text-brand-700'
                : 'flex items-center gap-2 font-medium text-ink-400'
            }
          >
            <StepBullet state={index < current ? 'done' : index === current ? 'current' : 'todo'}>
              {index + 1}
            </StepBullet>
            <span className="hidden sm:inline">{label}</span>
          </span>
          {index < STEP_LABELS.length - 1 ? (
            <span
              className={`h-0.5 flex-1 rounded-full ${index < current ? 'bg-brand-700' : 'bg-ink-200'}`}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function StepBullet({ state, children }) {
  if (state === 'done') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-700 text-white">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      className={
        state === 'current'
          ? 'flex h-6 w-6 items-center justify-center rounded-full bg-brand-700 text-[10px] font-semibold text-white ring-4 ring-brand-100'
          : 'flex h-6 w-6 items-center justify-center rounded-full border border-ink-200 bg-white text-[10px] font-semibold text-ink-400'
      }
    >
      {children}
    </span>
  );
}

function FormHeading({ eyebrow, title, subtitle }) {
  return (
    <div>
      {eyebrow ? (
        <p className="text-[12px] font-medium text-brand-700">{eyebrow}</p>
      ) : null}
      <h2 className="mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink-900">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">{subtitle}</p>
      ) : null}
    </div>
  );
}

function Divider() {
  return <div className="my-6 h-px w-full bg-ink-100" />;
}

function BackLink({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-6 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-ink-500 transition hover:text-brand-700"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {children}
    </button>
  );
}

/*
 * `action` puts a control on the label's own line, right-aligned -- where a
 * "Forgot password?" belongs. Below the field it reads as a footnote to the
 * whole form; beside the label it reads as being about this field.
 */
function Field({
  label,
  htmlFor,
  icon: Icon,
  optional = false,
  action = null,
  className = '',
  children,
}) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
        >
          {Icon ? <Icon className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" /> : null}
          {label}
          {optional ? (
            <span className="font-medium normal-case text-ink-400">(optional)</span>
          ) : null}
        </label>
        {action ? <span className="text-[12px] leading-none">{action}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The green counterpart to ErrorNote: something went right. */
function NoticeNote({ message }) {
  return (
    <p className="mt-4 flex items-start gap-2 rounded-lg bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-700">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

/*
 * The six boxes. Both flows that mail a code render them, and neither should be
 * the one that owns the keyboard handling.
 */
function CodeInputs({ digits, busy, inputsRef, onChange, onKeyDown, onPaste, label, className = '' }) {
  return (
    <div
      className={`flex justify-between gap-2 sm:gap-3 ${className}`}
      onPaste={onPaste}
      role="group"
      aria-label={label}
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
          onChange={(event) => onChange(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onFocus={(event) => event.target.select()}
          className={`tnum h-14 w-full rounded-lg border text-center text-[22px] font-semibold text-ink-900 transition focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-700/15 disabled:opacity-60 ${
            digit ? 'border-brand-600 bg-white' : 'border-ink-200 bg-white'
          }`}
        />
      ))}
    </div>
  );
}

function Legend({ children }) {
  return (
    <div className="mb-4 mt-8 flex items-center gap-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{children}</p>
      <span className="h-px flex-1 bg-ink-100" />
    </div>
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
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md text-ink-400 transition hover:text-ink-700"
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
      className="mt-4 flex items-start gap-2 rounded-lg border border-rose-100 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
