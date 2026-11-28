import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

// Register & check PWA updates after initial boot so SW precaching never stalls first render
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  const initServiceWorker = () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadedForUpdate = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloadedForUpdate) {
        reloadedForUpdate = true;
        window.location.reload();
      }
    });

    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;

        const checkForUpdate = () => {
          if (navigator.onLine) {
            void registration.update().catch(() => {});
          }
        };

        // Check when returning to the installed iOS/Android PWA from background
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            checkForUpdate();
          }
        });
        window.addEventListener('pageshow', checkForUpdate);
        window.addEventListener('online', checkForUpdate);
        window.setInterval(checkForUpdate, 5 * 60 * 1000);
      },
    });
  };

  if (document.readyState === 'complete') {
    window.setTimeout(initServiceWorker, 1200);
  } else {
    window.addEventListener(
      'load',
      () => {
        window.setTimeout(initServiceWorker, 1200);
      },
      { once: true }
    );
  }
}
