import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  GraduationCap,
  Loader2,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';

const RESEND_SECONDS = 60;
const CODE_LENGTH = 6;

export default function AuthScreen({ onAuthenticated }) {
  const [step, setStep] = useState('email'); // 'email' | 'code'
  const [email, setEmail] = useState('');
  const [digits, setDigits] = useState(() => Array(CODE_LENGTH).fill(''));
  const [status, setStatus] = useState('idle'); // 'idle' | 'sending' | 'verifying'
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);

  const inputsRef = useRef([]);
  const attemptedCodeRef = useRef('');
  const code = digits.join('');

  /* ------------------------------------------------------- resend timer -- */
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') inputsRef.current[0]?.focus();
  }, [step]);

  /* --------------------------------------------------------- step one ---- */
  async function sendCode(event) {
    event?.preventDefault();
    if (status !== 'idle') return;

    setError('');
    setNotice('');
    setStatus('sending');

    try {
      const result = await api('/auth/send-code', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      });
      setNotice(result.message ?? 'Access code sent.');
      setDigits(Array(CODE_LENGTH).fill(''));
      attemptedCodeRef.current = '';
      setCooldown(RESEND_SECONDS);
      setStep('code');
    } catch (err) {
      setError(err.message);
    } finally {
      setStatus('idle');
    }
  }

  /* --------------------------------------------------------- step two ---- */
  const verifyCode = useCallback(
    async (value) => {
      if (status !== 'idle' || value.length !== CODE_LENGTH) return;

      attemptedCodeRef.current = value;
      setError('');
      setStatus('verifying');

      try {
        const result = await api('/auth/verify-code', {
          method: 'POST',
          body: { email: email.trim().toLowerCase(), code: value },
        });
        onAuthenticated({ ...result.session, profile: result.profile });
      } catch (err) {
        setError(err.message);
        setDigits(Array(CODE_LENGTH).fill(''));
        inputsRef.current[0]?.focus();
      } finally {
        setStatus('idle');
      }
    },
    [email, onAuthenticated, status],
  );

  // Verify as soon as the last digit lands, but never re-fire the same code.
  useEffect(() => {
    if (code.length === CODE_LENGTH && attemptedCodeRef.current !== code) {
      verifyCode(code);
    }
  }, [code, verifyCode]);

  /* ------------------------------------------------------- code inputs --- */
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

  function backToEmail() {
    setStep('email');
    setError('');
    setNotice('');
    setDigits(Array(CODE_LENGTH).fill(''));
    attemptedCodeRef.current = '';
  }

  /* ------------------------------------------------------------ render --- */
  const busy = status !== 'idle';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <header className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-800 shadow-lg shadow-rose-800/20">
            <GraduationCap className="h-7 w-7 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">ConsultTrack</h1>
          <p className="mt-1 text-sm text-slate-500">
            Academic consultation scheduling for thesis groups
          </p>
        </header>

        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          {step === 'email' ? (
            <form onSubmit={sendCode} noValidate>
              <h2 className="text-lg font-semibold text-slate-900">Sign in</h2>
              <p className="mt-1 text-sm text-slate-500">
                We will email you a 6-digit access code. No password needed.
              </p>

              <label htmlFor="email" className="mt-6 block text-sm font-medium text-slate-700">
                School or Gmail address
              </label>
              <div className="relative mt-2">
                <Mail
                  className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="juan.delacruz@gmail.com"
                  className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-11 pr-4 text-slate-900 placeholder:text-slate-400 focus:border-rose-800 focus:outline-none focus:ring-2 focus:ring-rose-800/20"
                />
              </div>

              {error ? <ErrorNote message={error} /> : null}

              <button
                type="submit"
                disabled={busy || !email.trim()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-800 px-4 py-3 font-medium text-white transition hover:bg-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-800/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === 'sending' ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Sending code...
                  </>
                ) : (
                  <>
                    Send Access Code
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </>
                )}
              </button>
            </form>
          ) : (
            <div>
              <button
                type="button"
                onClick={backToEmail}
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 transition hover:text-rose-800"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Use a different email
              </button>

              <h2 className="text-lg font-semibold text-slate-900">Enter your access code</h2>
              <p className="mt-1 text-sm text-slate-500">
                Sent to <span className="font-medium text-slate-700">{email}</span>. The code expires
                in 10 minutes.
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
                <p className="mt-4 flex items-center gap-2 text-sm text-emerald-700">
                  <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {notice}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => verifyCode(code)}
                disabled={busy || code.length !== CODE_LENGTH}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-rose-800 px-4 py-3 font-medium text-white transition hover:bg-rose-900 focus:outline-none focus:ring-2 focus:ring-rose-800/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === 'verifying' ? (
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
                  <button
                    type="button"
                    onClick={sendCode}
                    disabled={busy}
                    className="font-medium text-rose-800 underline-offset-2 hover:underline disabled:opacity-60"
                  >
                    Resend code
                  </button>
                )}
              </p>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Check your spam folder if the code does not arrive within a minute.
        </p>
      </div>
    </div>
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
