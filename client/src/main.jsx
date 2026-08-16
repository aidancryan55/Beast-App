import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

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
    <App />
  </StrictMode>,
)
