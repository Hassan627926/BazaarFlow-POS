import React, { useState } from 'react';
import { Download, Monitor, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuide(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
          compact ? 'px-3 py-2 text-xs font-medium' : 'px-4 py-2.5 text-sm font-medium'
        }`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>{isIOS ? 'Install on iOS' : 'Install App'}</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-guide-title"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3
                  id="pwa-guide-title"
                  className="text-lg font-semibold text-slate-900 dark:text-slate-100"
                >
                  Install BazaarFlow POS
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Run fullscreen with offline billing on Windows and Android without an app store.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                aria-label="Close install guide"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-5 space-y-4 text-sm text-slate-700 dark:text-slate-300">
              {isIOS ? (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
                  <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                    <Smartphone className="w-4 h-4" />
                    <span>iPhone & iPad (Safari)</span>
                  </div>
                  <ol className="mt-2 space-y-1.5 list-decimal list-inside text-slate-600 dark:text-slate-400">
                    <li>Tap the Share icon in the Safari toolbar.</li>
                    <li>Scroll down and tap Add to Home Screen.</li>
                    <li>Tap Add to launch BazaarFlow POS standalone.</li>
                  </ol>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
                    <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                      <Monitor className="w-4 h-4" />
                      <span>Windows Counter PC (Chrome / Edge)</span>
                    </div>
                    <ol className="mt-2 space-y-1.5 list-decimal list-inside text-slate-600 dark:text-slate-400">
                      <li>Open this POS link in Chrome or Microsoft Edge.</li>
                      <li>Click the Install icon in the right side of the address bar.</li>
                      <li>Pin to Taskbar for instant counter checkout & thermal printing.</li>
                    </ol>
                  </div>

                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4">
                    <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                      <Smartphone className="w-4 h-4" />
                      <span>Android Phone & Tablet (Chrome)</span>
                    </div>
                    <ol className="mt-2 space-y-1.5 list-decimal list-inside text-slate-600 dark:text-slate-400">
                      <li>Open the app URL in Google Chrome on Android.</li>
                      <li>Tap the three-dot menu and choose Install App.</li>
                      <li>Launches like a native POS app with offline inventory cache.</li>
                    </ol>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full rounded-lg brand-bg px-4 py-2.5 text-sm font-medium text-white transition-opacity cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
};
