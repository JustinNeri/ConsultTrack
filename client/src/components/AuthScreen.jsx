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
} from 'lucide-react';
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-6 sm:px-6 lg:py-10">
      <div className={`w-full transition-all duration-300 ${wide ? 'max-w-6xl' : 'max-w-5xl'}`}>
        <div className="overflow-hidden rounded-3xl bg-white shadow-lift ring-1 ring-slate-900/5">
          <div className="grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
            <BrandPanel view={view} />

            {/* ------------------------------------------------- form column */}
            <div className="scrollbar-slim flex max-h-[calc(100vh-3rem)] flex-col justify-center overflow-y-auto p-6 sm:p-10">
              <MobileBrandBar />

              {view !== 'login' ? <Steps view={view} /> : null}

              {/* ------------------------------------------------------ login */}
              {view === 'login' ? (
                <form onSubmit={handleLogin} noValidate>
                  <FormHeading
                    eyebrow="Welcome back"
                    title="Sign in to ConsultTrack"
                    subtitle="Use the HAU email and password you registered with."
                  />

                  <Field label="Email address" htmlFor="login-email" icon={Mail} className="mt-7">
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

                  <Divider />

                  <p className="text-center text-sm text-slate-500">
                    No account yet?{' '}
                    <button type="button" onClick={() => switchView('email')} className={LINK}>
                      Create one
                    </button>
                  </p>
                </form>
              ) : null}

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
                        className={`mt-2 flex items-start gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold ${
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
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                        <ShieldCheck
                          className="mt-px h-3.5 w-3.5 shrink-0 text-brand-600"
                          aria-hidden="true"
                        />
                        {HAU_EMAIL_HINT}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-slate-400">
                      Students use @student.hau.edu.ph; advisers use their @hau.edu.ph faculty
                      address.
                    </p>
                  </Field>

                  {error ? <ErrorNote message={error} /> : null}

                  <SubmitButton busy={busy} label="Send access code" busyLabel="Sending code..." />

                  <Divider />

                  <p className="text-center text-sm text-slate-500">
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
                  <p className="mt-2 text-sm text-slate-500">
                    Sent to <span className="font-semibold text-slate-800">{email}</span>. The code
                    expires in 10 minutes.
                  </p>

                  <div
                    className="mt-7 flex justify-between gap-2 sm:gap-3"
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
                        className={`h-16 w-full rounded-2xl border-2 text-center text-2xl font-bold text-slate-900 transition focus:border-brand-600 focus:bg-white focus:outline-none disabled:opacity-60 ${
                          digit ? 'border-brand-500 bg-white' : 'border-slate-200 bg-slate-50'
                        }`}
                      />
                    ))}
                  </div>

                  {error ? <ErrorNote message={error} /> : null}
                  {!error && notice ? (
                    <p className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 px-3.5 py-3 text-sm font-medium text-emerald-700">
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
                      <>
                        Verify and continue
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      </>
                    )}
                  </button>

                  <Divider />

                  <p className="text-center text-sm text-slate-500">
                    Did not get it?{' '}
                    {cooldown > 0 ? (
                      <span className="font-semibold text-slate-400">Resend in {cooldown}s</span>
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
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      {email} verified
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${
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
                            className={`${INPUT} disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
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
                      <p className="mt-1.5 text-xs text-slate-400">
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
          <p className="mt-5 text-center text-xs text-slate-400">
            Check your spam folder if the code does not arrive within a minute.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ brand panel -- */

const HIGHLIGHTS = [
  {
    icon: CalendarCheck,
    title: 'Book in seconds',
    body: 'Request a slot with your adviser and see it confirmed on your dashboard.',
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

function BrandPanel({ view }) {
  return (
    <div className="relative hidden overflow-hidden bg-gradient-to-br from-brand-800 via-brand-700 to-brand-950 p-10 lg:flex lg:flex-col">
      {/* Decorative wash - purely presentational. */}
      <div
        className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-brand-400/30 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-amber-400/20 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)',
          backgroundSize: '36px 36px',
        }}
        aria-hidden="true"
      />

      <div className="relative">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
            <GraduationCap className="h-6 w-6 text-white" aria-hidden="true" />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-tight text-white">ConsultTrack</p>
            <p className="text-xs font-medium text-brand-200">Holy Angel University</p>
          </div>
        </div>

        <h2 className="mt-12 text-4xl font-extrabold leading-tight tracking-tight text-white">
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
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-brand-100/90">
          Consultation scheduling built for HAU thesis groups - one place for sessions, advisers and
          the tasks that come out of them.
        </p>
      </div>

      <ul className="relative mt-10 space-y-4">
        {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/15 backdrop-blur-sm"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-bold text-white">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-brand-100/80">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="relative mt-auto pt-10 text-xs text-brand-200/70">
        Built for the Holy Angel University capstone program.
      </p>
    </div>
  );
}

function MobileBrandBar() {
  return (
    <div className="mb-8 flex items-center gap-3 lg:hidden">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-700 to-brand-900 shadow-md shadow-brand-900/20">
        <GraduationCap className="h-6 w-6 text-white" aria-hidden="true" />
      </div>
      <div>
        <p className="font-extrabold tracking-tight text-slate-900">ConsultTrack</p>
        <p className="text-xs font-medium text-slate-500">Holy Angel University</p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- small pieces -- */

const INPUT =
  'w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-4 focus:ring-brand-500/10';

const BUTTON =
  'mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-700 to-brand-600 px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-brand-900/20 transition hover:from-brand-800 hover:to-brand-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none';

const LINK = 'font-bold text-brand-700 underline-offset-2 hover:underline disabled:opacity-60';

const STEP_LABELS = [
  ['email', 'Email'],
  ['verify', 'Verify'],
  ['details', 'Details'],
];

function Steps({ view }) {
  const current = STEP_LABELS.findIndex(([key]) => key === view);
  return (
    <ol className="mb-8 flex items-center gap-2 text-xs">
      {STEP_LABELS.map(([key, label], index) => (
        <li key={key} className="flex flex-1 items-center gap-2">
          <span
            className={
              index <= current
                ? 'flex items-center gap-2 font-bold text-brand-700'
                : 'flex items-center gap-2 font-medium text-slate-400'
            }
          >
            <StepBullet state={index < current ? 'done' : index === current ? 'current' : 'todo'}>
              {index + 1}
            </StepBullet>
            <span className="hidden sm:inline">{label}</span>
          </span>
          {index < STEP_LABELS.length - 1 ? (
            <span
              className={`h-0.5 flex-1 rounded-full ${index < current ? 'bg-brand-700' : 'bg-slate-200'}`}
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
          ? 'flex h-6 w-6 items-center justify-center rounded-full bg-brand-700 text-[10px] font-bold text-white ring-4 ring-brand-100'
          : 'flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-400'
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
        <p className="text-xs font-bold uppercase tracking-widest text-brand-600">{eyebrow}</p>
      ) : null}
      <h2 className="mt-1.5 text-2xl font-extrabold tracking-tight text-slate-900">{title}</h2>
      {subtitle ? <p className="mt-2 text-sm leading-relaxed text-slate-500">{subtitle}</p> : null}
    </div>
  );
}

function Divider() {
  return <div className="my-6 h-px w-full bg-slate-100" />;
}

function BackLink({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-6 inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-slate-500 transition hover:text-brand-700"
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
        className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-600"
      >
        {Icon ? <Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" /> : null}
        {label}
        {optional ? (
          <span className="font-medium normal-case text-slate-400">(optional)</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function Legend({ children }) {
  return (
    <div className="mb-4 mt-8 flex items-center gap-3">
      <p className="text-xs font-bold uppercase tracking-widest text-slate-400">{children}</p>
      <span className="h-px flex-1 bg-slate-100" />
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
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md text-slate-400 transition hover:text-slate-700"
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
      className="mt-4 flex items-start gap-2 rounded-xl border border-rose-100 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
