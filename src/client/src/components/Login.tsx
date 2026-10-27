import React, { useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import {
  Sparkles,
  Mail,
  Lock,
  AlertCircle,
  Loader2,
  ShieldCheck,
  ArrowRight,
} from 'lucide-react';
import { auth } from '../firebase';

export interface LoginProps {
  onLoginSuccess?: () => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Please enter both your email address and password.');
      return;
    }

    setIsLoading(true);
    try {
      await signInWithEmailAndPassword(auth, trimmedEmail, password);
      onLoginSuccess?.();
    } catch (err: any) {
      const code = err?.code as string | undefined;
      if (
        code === 'auth/invalid-credential' ||
        code === 'auth/wrong-password' ||
        code === 'auth/user-not-found'
      ) {
        setError('Invalid email or password. Please verify your credentials and try again.');
      } else if (code === 'auth/invalid-email') {
        setError('Please enter a valid email address.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many failed sign-in attempts. Please wait a moment and try again.');
      } else {
        setError(err?.message || 'Authentication failed. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center items-center p-4 font-sans selection:bg-cyan-500 selection:text-white">
      <div className="w-full max-w-md bg-slate-900/90 backdrop-blur-md border border-slate-800 rounded-2xl p-8 shadow-2xl shadow-black/60 space-y-6">
        {/* Brand Header */}
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-cyan-600 via-indigo-600 to-emerald-500 p-0.5 shadow-lg shadow-cyan-500/20">
            <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-cyan-400 animate-pulse" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-center gap-2">
              <h1 className="font-bold text-2xl tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 via-indigo-300 to-emerald-400 font-mono">
                SAIL
              </h1>
              <span className="text-[11px] uppercase tracking-widest text-slate-400 bg-slate-800/80 border border-slate-700 px-2 py-0.5 rounded-md font-semibold">
                v1.0 HITL
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Substance AI Lab Automation • Operator Sign-In
            </p>
          </div>
        </div>

        {/* Inline Error Alert */}
        {error && (
          <div
            role="alert"
            className="bg-rose-950/80 border border-rose-500/50 text-rose-200 px-4 py-3 rounded-xl text-xs flex items-start gap-2.5 animate-in fade-in duration-150"
          >
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Sign-In Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="sail-login-email"
              className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5"
            >
              <Mail className="w-3.5 h-3.5 text-cyan-400" />
              <span>Operator Email</span>
            </label>
            <input
              id="sail-login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              disabled={isLoading}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operator@substance-ai.lab"
              className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 disabled:opacity-60 transition-colors"
            />
          </div>

          <div>
            <label
              htmlFor="sail-login-password"
              className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center gap-1.5"
            >
              <Lock className="w-3.5 h-3.5 text-cyan-400" />
              <span>Password</span>
            </label>
            <input
              id="sail-login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={isLoading}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-cyan-500/40 disabled:opacity-60 transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 text-white font-semibold text-sm py-2.5 px-4 rounded-xl shadow-lg shadow-cyan-500/20 active:scale-[0.99] transition-all cursor-pointer disabled:cursor-not-allowed mt-2"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <>
                <span>Sign In to SAIL</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        {/* Compliance Footer */}
        <div className="pt-4 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 font-mono">
          <span className="flex items-center gap-1.5 text-emerald-400/90">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Firebase Auth • sail-platform-prod</span>
          </span>
          <span>ISO-9001 HITL</span>
        </div>
      </div>
    </div>
  );
};

export default Login;
