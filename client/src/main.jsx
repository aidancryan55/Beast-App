import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { api } from './api'

// Catches errors outside React's render cycle (async code, event handlers,
// promise rejections) — the ErrorBoundary below only catches render errors.
window.addEventListener('error', (e) => {
  api.reportClientError(e.message, e.error?.stack, window.location.href);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  api.reportClientError(reason?.message || String(reason), reason?.stack, window.location.href);
});

// 100dvh is unreliable inside Capacitor's WKWebView (it can under/over-report
// the real visible height, which is what caused stray scroll/overlap on
// device even though the same CSS renders correctly in a browser). Track the
// actual viewport height in JS instead and expose it as a custom property.
function setAppVh() {
  document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`);
}
setAppVh();
window.addEventListener('resize', setAppVh);
window.addEventListener('orientationchange', setAppVh);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
