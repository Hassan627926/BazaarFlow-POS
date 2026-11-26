import React, { useMemo, useState } from 'react';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  inMemoryPersistence,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  Barcode,
  BarChart3,
  ExternalLink,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Monitor,
  Moon,
  Palette,
  Receipt,
  Smartphone,
  Store,
  Sun,
  User as UserIcon,
  UtensilsCrossed,
} from 'lucide-react';
import { auth, googleProvider } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthScreenProps {
  darkMode?: boolean;
  onToggleDarkMode?: () => void;
  onSignedIn?: (user: User, mode: 'owner' | 'waiter') => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  darkMode = false,
  onToggleDarkMode,
  onSignedIn,
}) => {
  const [signingIn, setSigningIn] = useState(false);
  const [emailSigningIn, setEmailSigningIn] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [authAction, setAuthAction] = useState<'signin' | 'signup'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginMode, setLoginMode] = useState<'owner' | 'waiter'>(() => {
    if (typeof window === 'undefined') return 'owner';
    if (new URLSearchParams(window.location.search).get('mode') === 'waiter') return 'waiter';
    return window.sessionStorage.getItem('bazaarflow_login_mode') === 'waiter' ? 'waiter' : 'owner';
  });

  const handleSelectLoginMode = (mode: 'owner' | 'waiter') => {
    setLoginMode(mode);
    if (mode === 'waiter') {
      setAuthAction('signin');
    }
    setError(null);
    setErrorCode(null);
    setNotice(null);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('bazaarflow_login_mode', mode);
    }
  };

  const handleSelectAuthAction = (action: 'signin' | 'signup') => {
    setAuthAction(action);
    setError(null);
    setErrorCode(null);
    setNotice(null);
  };

  const firebaseAuthConsoleUrl = `https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/providers`;

  const isInIframe = useMemo(() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  }, []);

  const ensurePersistence = async () => {
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch {
      try {
        await setPersistence(auth, browserSessionPersistence);
      } catch {
        await setPersistence(auth, inMemoryPersistence);
      }
    }
  };

  const extractFirebaseCode = (err: unknown): string => {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return String((err as { code?: unknown }).code ?? '');
    }
    return '';
  };

  const mapAuthError = (
    err: unknown,
    context: 'signin' | 'signup' | 'reset' | 'google'
  ): { code: string | null; message: string } => {
    const code = extractFirebaseCode(err);

    if (code === 'auth/email-already-in-use') {
      return {
        code,
        message:
          'An account with this email already exists. Switch to Sign In or use Forgot password.',
      };
    }
    if (code === 'auth/invalid-email') {
      return { code, message: 'Please enter a valid email address.' };
    }
    if (code === 'auth/weak-password') {
      return {
        code,
        message: 'Please choose a stronger password (at least 6 characters).',
      };
    }
    if (code === 'auth/operation-not-allowed') {
      return {
        code,
        message:
          'Email/Password sign-in is not enabled yet in Firebase Console. Sign in with Google or enable Email/Password under Authentication → Sign-in method.',
      };
    }
    if (
      code === 'auth/invalid-credential' ||
      code === 'auth/wrong-password' ||
      code === 'auth/user-not-found'
    ) {
      if (context === 'reset') {
        return {
          code,
          message:
            'No account found with this email address. Check the email or switch to Create Account.',
        };
      }
      return {
        code,
        message:
          loginMode === 'waiter'
            ? 'Incorrect waiter email or password. Confirm your credentials with your restaurant owner.'
            : 'Incorrect email or password. If you do not have an account yet, switch to Create Account or use Google Sign-In.',
      };
    }
    if (code === 'auth/too-many-requests') {
      return {
        code,
        message: 'Too many failed attempts. Please wait a minute or use Forgot password.',
      };
    }
    if (code === 'auth/network-request-failed') {
      return {
        code,
        message: 'Network error. Please check your internet connection and try again.',
      };
    }
    if (code === 'auth/popup-blocked') {
      return {
        code,
        message:
          'Browser blocked the Google Sign-In popup. Please allow popups for this site or open the app in a full browser tab.',
      };
    }
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return {
        code,
        message:
          'Google Sign-In popup closed before completing login. You can also sign in or create an account with Email & Password.',
      };
    }
    if (code === 'auth/unauthorized-domain') {
      return {
        code,
        message: `This domain (${window.location.hostname}) is not authorized for Google Sign-In in Firebase Auth. Use Email & Password above, or add this domain in Firebase Console → Authentication → Settings → Authorized domains.`,
      };
    }

    const fallback =
      context === 'signup'
        ? 'Unable to create your account right now. Please try again.'
        : context === 'reset'
          ? 'Could not send password reset email right now. Please try again.'
          : context === 'google'
            ? 'Google Sign-In failed. Please try again.'
            : 'Unable to sign in right now. Please try again.';

    return {
      code: code || null,
      message: fallback,
    };
  };

  const handleEmailAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const isSignup = loginMode === 'owner' && authAction === 'signup';
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();

    if (isSignup && cleanName.length < 2) {
      setError('Please enter your full name (at least 2 characters).');
      return;
    }
    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    if (isSignup && password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }
    if (isSignup && password !== confirmPassword) {
      setError('Passwords do not match. Please check and try again.');
      return;
    }

    setEmailSigningIn(true);
    setError(null);
    setErrorCode(null);
    setNotice(null);

    try {
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bazaarflow_login_mode', loginMode);
      }
      await ensurePersistence();

      if (isSignup) {
        const credential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        try {
          await updateProfile(credential.user, { displayName: cleanName });
          await credential.user.reload();
        } catch {
          // Display name update is non-blocking
        }
        if (credential?.user && onSignedIn) {
          onSignedIn(credential.user, 'owner');
        }
      } else {
        const credential = await signInWithEmailAndPassword(auth, cleanEmail, password);
        if (credential?.user && onSignedIn) {
          onSignedIn(credential.user, loginMode);
        }
      }
    } catch (err: unknown) {
      const mapped = mapAuthError(err, isSignup ? 'signup' : 'signin');
      setErrorCode(mapped.code);
      setError(mapped.message);
    } finally {
      setEmailSigningIn(false);
    }
  };

  const handleForgotPassword = async () => {
    const cleanEmail = email.trim().toLowerCase();
    setError(null);
    setErrorCode(null);
    setNotice(null);

    if (!cleanEmail || !cleanEmail.includes('@')) {
      setError('Enter your account email above first, then click Forgot password.');
      return;
    }

    setResettingPassword(true);
    try {
      await sendPasswordResetEmail(auth, cleanEmail);
      setNotice(`Password reset link sent to ${cleanEmail}. Check your inbox or spam folder.`);
    } catch (err: unknown) {
      const mapped = mapAuthError(err, 'reset');
      setErrorCode(mapped.code);
      setError(mapped.message);
    } finally {
      setResettingPassword(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    setError(null);
    setErrorCode(null);
    setNotice(null);

    try {
      if (typeof window !== 'undefined') {
        window.sessionStorage.setItem('bazaarflow_login_mode', loginMode);
      }
      await ensurePersistence();
      const credential = await signInWithPopup(auth, googleProvider);
      if (credential?.user && onSignedIn) {
        onSignedIn(credential.user, loginMode);
      }
    } catch (err: unknown) {
      const mapped = mapAuthError(err, 'google');
      setErrorCode(mapped.code);
      setError(mapped.message);
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto max-w-6xl flex items-center justify-between gap-4 sm:gap-8 px-4 sm:px-6 py-3.5 sm:py-4">
          <div className="text-base sm:text-lg font-bold tracking-tight font-display text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            BazaarFlow POS
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
            <a href="#retail-restaurant" className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0">
              Retail & Dining
            </a>
            <a href="#platforms" className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0">
              Windows & Android
            </a>
            <a href="#analytics" className="hover:text-slate-900 dark:hover:text-slate-100 whitespace-nowrap shrink-0">
              Owner Analytics
            </a>
          </nav>
          <div className="flex items-center gap-2 shrink-0">
            {onToggleDarkMode && (
              <button
                type="button"
                onClick={onToggleDarkMode}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{darkMode ? 'Light' : 'Dark'}</span>
              </button>
            )}
            <PWAInstallButton compact />
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl w-full px-4 sm:px-6 py-5 sm:py-10 lg:py-14 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-center">
        <div className="lg:col-span-7 space-y-6">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
            Multi-Brand SaaS Point of Sale · Windows · Android · iOS Ready
          </p>
          <h1
            className="text-3xl sm:text-4xl lg:text-5xl font-bold font-display tracking-tight text-slate-900 dark:text-slate-100 leading-[1.12]"
            style={{ textWrap: 'balance' }}
          >
            Inventory, billing, and owner reports tailored to every brand.
          </h1>
          <p className="text-base text-slate-600 dark:text-slate-400 max-w-xl leading-relaxed">
            Run retail shops with built-in barcode generation and label printing, or manage restaurants with table orders, mobile waiter ordering, and kitchen tickets—each with its own logo, colors, currency, and cloud-synced stock ledger.
          </p>

          <div
            id="retail-restaurant"
            className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2"
          >
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Store className="w-4 h-4 text-teal-700 dark:text-teal-400" />
                <span>Retail & Shop Mode</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Auto-generate EAN-13 barcodes, print sticker sheets, scan items directly into bills, and monitor low-stock alerts.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <UtensilsCrossed className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                <span>Restaurant & Waiter Mobile</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Live table floor, mobile waiter ordering & KOT printing straight from phones, and instant sync to the counter cashier.
              </p>
            </div>
          </div>

          <div
            id="platforms"
            className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400"
          >
            <div className="flex items-center gap-2 pt-3">
              <Palette className="w-4 h-4 text-slate-500 shrink-0" />
              <span>Custom Brand Themes</span>
            </div>
            <div className="flex items-center gap-2 pt-3">
              <Receipt className="w-4 h-4 text-slate-500 shrink-0" />
              <span>58mm / 80mm Printing</span>
            </div>
            <div className="flex items-center gap-2 pt-3" id="analytics">
              <BarChart3 className="w-4 h-4 text-slate-500 shrink-0" />
              <span>Daily CSV & Z-Reports</span>
            </div>
            <div className="flex items-center gap-2 pt-3">
              <Barcode className="w-4 h-4 text-slate-500 shrink-0" />
              <span>Shop-Only Barcodes</span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 order-first lg:order-last">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-7">
            {/* Owner vs Waiter Login Mode Switch */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800 mb-5">
              <button
                type="button"
                onClick={() => handleSelectLoginMode('owner')}
                className={`flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold transition-colors cursor-pointer ${
                  loginMode === 'owner'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Store className="w-3.5 h-3.5" />
                <span>Owner / Counter</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectLoginMode('waiter')}
                className={`flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold transition-colors cursor-pointer ${
                  loginMode === 'waiter'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Waiter Mobile</span>
              </button>
            </div>

            <h2 className="text-xl font-bold font-display text-slate-900 dark:text-slate-100">
              {loginMode === 'waiter'
                ? 'Waiter Mobile App Sign-In'
                : authAction === 'signup'
                  ? 'Create Owner Account'
                  : 'Sign in to Owner Console'}
            </h2>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {loginMode === 'waiter'
                ? 'Sign in with the Email & Password created by your restaurant owner (under Employees / Staff). Your restaurant tables & menu will open directly.'
                : authAction === 'signup'
                  ? 'Create your BazaarFlow POS owner account with email & password, then set up your shop or restaurant in seconds.'
                  : 'Sign in with your email & password, create a new account, or continue with Google.'}
            </p>

            {/* Sign In vs Create Account Toggle (Owner mode only) */}
            {loginMode === 'owner' && (
              <div className="mt-4 flex items-center gap-4 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => handleSelectAuthAction('signin')}
                  className={`pb-2 border-b-2 transition-colors cursor-pointer ${
                    authAction === 'signin'
                      ? 'border-slate-900 dark:border-slate-100 text-slate-900 dark:text-slate-100'
                      : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectAuthAction('signup')}
                  className={`pb-2 border-b-2 transition-colors cursor-pointer ${
                    authAction === 'signup'
                      ? 'border-slate-900 dark:border-slate-100 text-slate-900 dark:text-slate-100'
                      : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  Create Account
                </button>
              </div>
            )}

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-3 text-xs text-red-700 dark:text-red-300 space-y-1.5">
                <p className="font-medium leading-relaxed">{error}</p>
                {errorCode === 'auth/operation-not-allowed' && (
                  <a
                    href={firebaseAuthConsoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold underline text-red-800 dark:text-red-200"
                  >
                    <span>Enable Email/Password in Firebase Console</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {errorCode && (
                  <p className="font-mono text-[11px] opacity-80">Code: {errorCode}</p>
                )}
              </div>
            )}

            {notice && (
              <div className="mt-4 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 px-3.5 py-2.5 text-xs font-medium text-emerald-800 dark:text-emerald-300">
                {notice}
              </div>
            )}

            {/* Email & Password Sign-In / Sign-Up Form */}
            <form onSubmit={(e) => void handleEmailAuthSubmit(e)} className="mt-4 space-y-3">
              {loginMode === 'owner' && authAction === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-fullname"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Your Full Name
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-fullname"
                      type="text"
                      required
                      autoComplete="name"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="e.g., Hassan Ashfaq"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2.5 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-email"
                  className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                >
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@gmail.com"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2.5 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="auth-password"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300"
                  >
                    Password
                  </label>
                  {authAction === 'signin' && (
                    <button
                      type="button"
                      disabled={resettingPassword}
                      onClick={() => void handleForgotPassword()}
                      className="text-[11px] font-medium text-teal-700 dark:text-teal-400 hover:underline cursor-pointer disabled:opacity-50"
                    >
                      {resettingPassword ? 'Sending...' : 'Forgot password?'}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={authAction === 'signup' ? 6 : undefined}
                    autoComplete={authAction === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      authAction === 'signup' ? 'At least 6 characters' : 'Enter your password'
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-10 py-2.5 text-sm text-slate-900 dark:text-slate-100"
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

              {loginMode === 'owner' && authAction === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-confirm-password"
                    className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-confirm-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your password"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-9 pr-3 py-2.5 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={emailSigningIn || signingIn}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-slate-900 dark:bg-slate-100 px-5 py-2.5 text-sm font-semibold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-60 transition-opacity cursor-pointer"
              >
                <span>
                  {emailSigningIn
                    ? loginMode === 'owner' && authAction === 'signup'
                      ? 'Creating Account...'
                      : 'Signing in...'
                    : loginMode === 'waiter'
                      ? 'Waiter Sign In with Email'
                      : authAction === 'signup'
                        ? 'Create Account & Continue'
                        : 'Sign In with Email'}
                </span>
              </button>
            </form>

            {/* Divider */}
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200 dark:border-slate-800" />
              </div>
              <div className="relative flex justify-center text-[11px]">
                <span className="bg-white dark:bg-slate-900 px-2.5 text-slate-400">
                  {loginMode === 'waiter'
                    ? 'or if your owner invited your Gmail'
                    : 'or continue with Google'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={signingIn || emailSigningIn}
              className="w-full flex items-center justify-center gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-5 py-2.5 text-sm font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M21.35 11.1h-9.18v2.92h5.27c-.23 1.24-.92 2.29-1.96 3v2.49h3.17c1.86-1.71 2.93-4.23 2.93-7.21 0-.41-.04-.81-.1-1.2z"
                />
                <path
                  fill="currentColor"
                  d="M12.17 21c2.65 0 4.87-.88 6.49-2.38l-3.17-2.49c-.88.59-2 .94-3.32.94-2.55 0-4.72-1.72-5.49-4.04H3.4v2.57A9.8 9.8 0 0 0 12.17 21z"
                />
                <path
                  fill="currentColor"
                  d="M6.68 13.03a5.88 5.88 0 0 1 0-3.77V6.69H3.4a9.81 9.81 0 0 0 0 8.91l3.28-2.57z"
                />
                <path
                  fill="currentColor"
                  d="M12.17 5.22c1.44 0 2.73.5 3.75 1.47l2.81-2.81C17.03 2.3 14.82 1.4 12.17 1.4A9.8 9.8 0 0 0 3.4 6.69l3.28 2.57c.77-2.32 2.94-4.04 5.49-4.04z"
                />
              </svg>
              <span>
                {signingIn
                  ? 'Waiting for Google Sign-In...'
                  : loginMode === 'waiter'
                    ? 'Sign in as Waiter with Google'
                    : 'Continue with Google'}
              </span>
            </button>

            {isInIframe && (
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                <span>Open POS in Full Browser Tab (Recommended for Google Sign-In)</span>
              </a>
            )}

            <div className="mt-5 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-500 dark:text-slate-400">
              {loginMode === 'waiter' ? (
                <>
                  <div className="flex items-center gap-2">
                    <UtensilsCrossed className="w-3.5 h-3.5 shrink-0" />
                    <span>Direct Table Orders, Add-On Items & Kitchen KOT Print</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-3.5 h-3.5 shrink-0" />
                    <span>Instant Real-Time Sync with Counter Cashier POS</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Monitor className="w-3.5 h-3.5 shrink-0" />
                    <span>Windows Desktop Counter Ready (Chrome / Edge PWA)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Smartphone className="w-3.5 h-3.5 shrink-0" />
                    <span>Android Tablet & Mobile Ready (Offline Cache Enabled)</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
