import React, { useEffect, useState } from 'react';
import {
  EmailAuthProvider,
  linkWithCredential,
  reauthenticateWithPopup,
  updatePassword,
  type User,
} from 'firebase/auth';
import { Check, ExternalLink, Eye, EyeOff, KeyRound, ShieldCheck, X } from 'lucide-react';
import { googleProvider } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';

interface PasswordSetupModalProps {
  user: User;
  isOpen: boolean;
  hasPasswordProvider: boolean;
  onClose: () => void;
  onPasswordSaved: () => void;
}

export const PasswordSetupModal: React.FC<PasswordSetupModalProps> = ({
  user,
  isOpen,
  hasPasswordProvider,
  onClose,
  onPasswordSaved,
}) => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerNotEnabled, setProviderNotEnabled] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const firebaseAuthConsoleUrl = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`;

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setError(null);
      setProviderNotEnabled(false);
      setSavedSuccess(false);
    }
  }, [isOpen]);

  if (!isOpen || !user.email) return null;

  const performSave = async (cleanPassword: string) => {
    if (!user.email) return;
    if (hasPasswordProvider) {
      await updatePassword(user, cleanPassword);
    } else {
      const credential = EmailAuthProvider.credential(user.email, cleanPassword);
      try {
        await linkWithCredential(user, credential);
      } catch (linkErr: unknown) {
        const linkCode =
          typeof linkErr === 'object' && linkErr !== null && 'code' in linkErr
            ? String((linkErr as { code?: unknown }).code ?? '')
            : '';
        if (linkCode === 'auth/provider-already-linked') {
          await updatePassword(user, cleanPassword);
        } else {
          throw linkErr;
        }
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setProviderNotEnabled(false);

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Both passwords do not match. Please check and try again.');
      return;
    }

    setSaving(true);
    try {
      await performSave(password);
      await user.reload();
      setSavedSuccess(true);
      onPasswordSaved();
    } catch (err: unknown) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code ?? '')
          : '';

      if (code === 'auth/requires-recent-login') {
        try {
          await reauthenticateWithPopup(user, googleProvider);
          await performSave(password);
          await user.reload();
          setSavedSuccess(true);
          onPasswordSaved();
          return;
        } catch (reauthErr: unknown) {
          const msg =
            reauthErr instanceof Error
              ? reauthErr.message
              : 'Please sign out and sign in again to update your password.';
          setError(msg);
          return;
        }
      }

      if (code === 'auth/operation-not-allowed') {
        setProviderNotEnabled(true);
        setError(
          'Email/Password sign-in is not enabled yet in Firebase Console. Enable the "Email/Password" provider in Firebase Console first, then click Save Password again.'
        );
      } else if (code === 'auth/weak-password') {
        setError('Please choose a stronger password (at least 6 characters).');
      } else {
        setError(err instanceof Error ? err.message : 'Unable to save password right now.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 overflow-y-auto no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-setup-title"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-2xl my-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg brand-soft-bg brand-text flex items-center justify-center shrink-0 mt-0.5">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h3
                id="password-setup-title"
                className="text-base font-bold font-display text-slate-900 dark:text-slate-100"
              >
                {hasPasswordProvider ? 'Change Account Password' : 'Create a Password'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                {hasPasswordProvider
                  ? 'Update the password you use for direct email & password sign-in.'
                  : 'Set a password now so next time you can sign in directly with your email and password.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {savedSuccess ? (
          <div className="space-y-4 pt-1">
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>Password Saved Successfully</span>
              </div>
              <p className="text-xs text-emerald-700 dark:text-emerald-400 leading-relaxed">
                Next time you sign in, you can log in directly using{' '}
                <span className="font-mono font-semibold">{user.email}</span> and your new password.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg brand-bg px-4 py-2.5 text-xs font-semibold text-white cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>Continue to POS</span>
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3.5">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Account Email
              </label>
              <input
                type="email"
                readOnly
                value={user.email}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-400"
              />
            </div>

            <div>
              <label
                htmlFor="new-account-password"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                New Password *
              </label>
              <div className="relative">
                <input
                  id="new-account-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 pl-3 pr-10 py-2 text-sm text-slate-900 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor="confirm-account-password"
                className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Confirm Password *
              </label>
              <input
                id="confirm-account-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2.5 text-xs text-red-700 dark:text-red-300 space-y-2">
                <p className="leading-relaxed">{error}</p>
                {providerNotEnabled && (
                  <a
                    href={firebaseAuthConsoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-semibold underline text-red-800 dark:text-red-200"
                  >
                    <span>Open Firebase Sign-in Method Settings</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                {hasPasswordProvider ? 'Cancel' : 'Skip for Now'}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg brand-bg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 cursor-pointer"
              >
                {saving
                  ? 'Saving...'
                  : hasPasswordProvider
                    ? 'Update Password'
                    : 'Save Password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
