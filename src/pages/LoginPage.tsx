import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.tsx';

function formatAuthError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : fallback;
  try {
    const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
    if (parsed && typeof parsed.error === 'string') {
      return parsed.path
        ? `${parsed.error} (${parsed.operationType || 'access'} on ${parsed.path})`
        : parsed.error;
    }
  } catch {
    // Plain error string
  }
  return raw || fallback;
}

export function LoginPage() {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(formatAuthError(err, 'Unable to sign in.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setGoogleSubmitting(true);
    try {
      await loginWithGoogle();
      navigate('/dashboard');
    } catch (err: unknown) {
      const msg = formatAuthError(err, 'Google sign-in failed.');
      if (!msg.includes('popup-closed-by-user')) {
        setError(msg);
      }
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080F1D] text-slate-100 flex flex-col justify-center px-4 py-12">
      <div className="max-w-md w-full mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-lg font-display font-bold text-white mb-8">
          <ShieldCheck className="w-5 h-5 text-[#3B82F6]" />
          <span>AutoPatch</span>
        </Link>

        <div className="p-8 rounded-xl bg-[#111C2D] border border-slate-800">
          <h1 className="text-2xl font-display font-bold text-white">Sign in to AutoPatch</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            Access your multi-user cloud workspace, scan reports, and patch validation runs.
          </p>

          {error && (
            <div className="mt-5 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 break-words">
              {error}
            </div>
          )}

          <div className="mt-6">
            <button
              type="button"
              disabled={googleSubmitting || submitting}
              onClick={handleGoogleSignIn}
              className="w-full py-2.5 px-4 bg-[#080F1D] hover:bg-slate-900 border border-slate-700 hover:border-slate-500 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2.5"
            >
              {googleSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin text-[#3B82F6]" />
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                  />
                </svg>
              )}
              <span>{googleSubmitting ? 'Connecting Google Account...' : 'Continue with Google'}</span>
            </button>
          </div>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-800" />
            <span className="text-[11px] uppercase tracking-wider text-slate-500">or email sign-in</span>
            <div className="h-px flex-1 bg-slate-800" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="developer@company.com"
                className="w-full px-3.5 py-2.5 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="login-password" className="block text-xs font-medium text-slate-300">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setForgotOpen((v) => !v);
                    setForgotSent(false);
                  }}
                  className="text-xs text-[#3B82F6] hover:underline"
                >
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm bg-[#080F1D] border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-[#3B82F6]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || googleSubmitting}
              className="w-full py-2.5 px-4 bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{submitting ? 'Signing In...' : 'Sign In'}</span>
            </button>
          </form>

          {forgotOpen && (
            <div className="mt-5 p-4 rounded-lg bg-[#080F1D] border border-slate-800 space-y-3">
              <p className="text-xs font-medium text-slate-200">Reset Account Password</p>
              {forgotSent ? (
                <p className="text-xs text-emerald-400">
                  If an account matches {forgotEmail}, password recovery instructions have been queued. Contact your workspace administrator for self-hosted instances.
                </p>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    placeholder="Account email"
                    className="flex-1 px-3 py-1.5 text-xs bg-[#111C2D] border border-slate-700 rounded-md text-white"
                  />
                  <button
                    type="button"
                    onClick={() => forgotEmail && setForgotSent(true)}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded-md"
                  >
                    Send
                  </button>
                </div>
              )}
            </div>
          )}

          <p className="mt-6 text-center text-xs text-slate-400">
            New to AutoPatch?{' '}
            <Link to="/register" className="text-[#3B82F6] font-medium hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
