import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { Barcode, BarChart3, Monitor, Palette, Receipt, Smartphone, Store, UtensilsCrossed } from 'lucide-react';
import { auth, googleProvider } from '../firebase';
import { PWAInstallButton } from './PWAInstallButton';

export const AuthScreen: React.FC = () => {
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
      if (!msg.includes('popup-closed-by-user')) {
        setError(msg);
      }
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <header className="w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="mx-auto max-w-6xl flex items-center justify-between gap-8 px-6 py-4">
          <div className="text-lg font-bold tracking-tight font-display text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
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
          <div className="shrink-0">
            <PWAInstallButton compact />
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto max-w-6xl w-full px-6 py-12 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
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
            Run retail shops with built-in barcode generation and label printing, or manage restaurants with table orders and kitchen tickets—each with its own logo, colors, currency, and cloud-synced stock ledger.
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
                <span>Restaurant & Cafe Mode</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Clean menu grid without barcode clutter, Dine-In / Takeaway / Delivery billing, table numbers, and Kitchen Order Tickets.
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

        <div className="lg:col-span-5">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-7 sm:p-8">
            <h2 className="text-xl font-bold font-display text-slate-900 dark:text-slate-100">
              Sign in to Owner Console
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Access your stores, sync inventory across Windows PCs and Android devices, and export daily summaries.
            </p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={signingIn}
              className="mt-6 w-full flex items-center justify-center gap-3 rounded-lg bg-slate-900 dark:bg-slate-100 px-5 py-3 text-sm font-semibold text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-60 transition-opacity cursor-pointer"
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
              <span>{signingIn ? 'Signing in...' : 'Continue with Google'}</span>
            </button>

            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 space-y-2.5 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <Monitor className="w-3.5 h-3.5 shrink-0" />
                <span>Windows Desktop Counter Ready (Chrome / Edge PWA)</span>
              </div>
              <div className="flex items-center gap-2">
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>Android Tablet & Mobile Ready (Offline Cache Enabled)</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
