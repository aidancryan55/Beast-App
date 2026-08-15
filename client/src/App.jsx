import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import './App.css';

// Plain line icons (no emoji) for nav chrome — matches the reference app's
// minimal SF-Symbol-style iconography instead of colorful emoji glyphs.
const iconProps = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
function IconHome(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}
function IconUsers(props) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20.5v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
      <path d="M16.5 4.5a3.5 3.5 0 0 1 0 6.8" />
      <path d="M20 20.5v-1a5 5 0 0 0-3.2-4.7" />
    </svg>
  );
}
function IconUserPlus(props) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20.5v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
      <path d="M18.5 8v6" />
      <path d="M21.5 11h-6" />
    </svg>
  );
}
function IconTrophy(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M8 21h8" />
      <path d="M12 17.5v3.5" />
      <path d="M7 4h10v4.5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 5H4.5a2 2 0 0 0 0 4H7" />
      <path d="M17 5h2.5a2 2 0 0 1 0 4H17" />
    </svg>
  );
}
function IconUser(props) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5" />
    </svg>
  );
}
function IconCamera(props) {
  return (
    <svg {...iconProps} {...props}>
      <path d="M4 8a2 2 0 0 1 2-2h1.2l1.3-2h6.5l1.3 2H17a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
      <circle cx="12" cy="13" r="3.3" />
    </svg>
  );
}
function IconSettings(props) {
  return (
    <svg {...iconProps} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.65 1.65 0 0 0-1.8-.3 1.65 1.65 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.65 1.65 0 0 0-1-1.5 1.65 1.65 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.65 1.65 0 0 0 .3-1.8 1.65 1.65 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.65 1.65 0 0 0 1.5-1 1.65 1.65 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.65 1.65 0 0 0 1.8.3H9a1.65 1.65 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.65 1.65 0 0 0 1 1.5 1.65 1.65 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.65 1.65 0 0 0-.3 1.8V9a1.65 1.65 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.65 1.65 0 0 0-1.5 1Z" />
    </svg>
  );
}

function LoginScreen({ onLogin, onSignupStart, onSignupResendCode, onSignupVerifyCode, onSignupFinish }) {
  // 'landing' | 'signup-realname' | 'signup-username' | 'signup-avatar' | 'signup-email' | 'signup-code' | 'signup-password' | 'login'
  const [screen, setScreen] = useState('landing');
  const [realName, setRealName] = useState('');
  const [username, setUsername] = useState('');
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const avatarInputRef = useRef(null);

  function pickAvatarFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  useEffect(() => {
    const t = setInterval(() => setResendCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, []);

  async function submitLogin(e) {
    e.preventDefault();
    setError('');
    setErrorCode('');
    setLoading(true);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err.message);
      setErrorCode(err.code || '');
    } finally {
      setLoading(false);
    }
  }

  async function submitEmail(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSignupStart(realName.trim(), username.trim(), email.trim());
      setResendCooldown(60);
      setScreen('signup-code');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    if (resendCooldown > 0) return;
    setError('');
    try {
      await onSignupResendCode(email.trim());
      setResendCooldown(60);
    } catch (err) {
      setError(err.message);
    }
  }

  async function submitCode(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSignupVerifyCode(email.trim(), code.trim());
      setScreen('signup-password');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function finishSignup(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSignupFinish(email.trim(), password, avatarFile);
      // Success logs you straight in — the parent swaps this screen out.
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (screen === 'signup-realname') {
    return (
      <div className="onboard-screen">
        <button type="button" className="onboard-back" onClick={() => setScreen('landing')} aria-label="Back">‹</button>
        <form className="onboard-body" onSubmit={(e) => { e.preventDefault(); if (realName.trim()) setScreen('signup-username'); }}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">Let's get started — what's your name?</h1>
          <input
            className="onboard-input"
            autoFocus
            placeholder="Your name"
            value={realName}
            maxLength={60}
            onChange={(e) => setRealName(e.target.value)}
          />
          <p className="onboard-hint">Just for us — this isn't shown to anyone else.</p>
          <button type="submit" className="onboard-continue" disabled={!realName.trim()}>Continue</button>
        </form>
      </div>
    );
  }

  if (screen === 'signup-username') {
    return (
      <div className="onboard-screen">
        <button type="button" className="onboard-back" onClick={() => setScreen('signup-realname')} aria-label="Back">‹</button>
        <form className="onboard-body" onSubmit={(e) => { e.preventDefault(); if (username.trim()) setScreen('signup-avatar'); }}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">Next, create your username</h1>
          <input
            className="onboard-input"
            autoFocus
            placeholder="Username"
            value={username}
            maxLength={30}
            onChange={(e) => setUsername(e.target.value)}
          />
          <p className="onboard-hint">Shown publicly on the leaderboard and on posts — you can't change this later, so pick something you'll want to keep.</p>
          <button type="submit" className="onboard-continue" disabled={!username.trim()}>Continue</button>
        </form>
      </div>
    );
  }

  if (screen === 'signup-avatar') {
    return (
      <div className="onboard-screen">
        <button type="button" className="onboard-back" onClick={() => setScreen('signup-username')} aria-label="Back">‹</button>
        <form className="onboard-body" onSubmit={(e) => { e.preventDefault(); setScreen('signup-email'); }}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">Add a profile picture</h1>
          <button type="button" className="onboard-avatar-btn" onClick={() => avatarInputRef.current?.click()}>
            {avatarPreview ? <img src={avatarPreview} alt="" /> : <span className="onboard-avatar-placeholder">+</span>}
          </button>
          <input ref={avatarInputRef} type="file" accept="image/*" hidden onChange={pickAvatarFile} />
          <p className="onboard-hint">Shown next to your name on posts and the leaderboard.</p>
          <button type="submit" className="onboard-continue">{avatarFile ? 'Continue' : 'Skip for now'}</button>
        </form>
      </div>
    );
  }

  if (screen === 'signup-email') {
    return (
      <div className="onboard-screen">
        <button type="button" className="onboard-back" onClick={() => setScreen('signup-avatar')} aria-label="Back">‹</button>
        <form className="onboard-body" onSubmit={submitEmail}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">What's your email?</h1>
          <input
            className="onboard-input"
            autoFocus
            type="email"
            placeholder="you@school.edu"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="onboard-hint">Stays private — only used to sign in and recover your account.</p>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="onboard-continue" disabled={loading || email.trim().length <= 2}>
            {loading ? 'Sending…' : 'Continue'}
          </button>
        </form>
      </div>
    );
  }

  if (screen === 'signup-code') {
    return (
      <div className="onboard-screen">
        <button type="button" className="onboard-back" onClick={() => { setError(''); setScreen('signup-email'); }} aria-label="Back">‹</button>
        <form className="onboard-body" onSubmit={submitCode}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">Enter the code we sent to<br />{email}</h1>
          <input
            className="onboard-input"
            autoFocus
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button type="button" className="link-btn" onClick={() => { setError(''); setScreen('signup-email'); }}>
            Change the email
          </button>
          {error && <p className="error">{error}</p>}
          <button type="submit" className="onboard-continue" disabled={loading || code.trim().length < 6}>
            {loading ? 'Verifying…' : 'Continue'}
          </button>
          <button type="button" className="onboard-resend" onClick={resendCode} disabled={resendCooldown > 0}>
            {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
          </button>
        </form>
      </div>
    );
  }

  if (screen === 'signup-password') {
    return (
      <div className="onboard-screen">
        <form className="onboard-body" onSubmit={finishSignup}>
          <p className="onboard-wordmark">CATCH A BEAST</p>
          <h1 className="onboard-question">Create a password</h1>
          <input
            className="onboard-input"
            autoFocus
            type="password"
            placeholder="Min 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button type="submit" className="onboard-continue" disabled={loading || password.length < 8}>
            {loading ? 'Creating…' : 'Create Account'}
          </button>
        </form>
      </div>
    );
  }

  if (screen === 'login') {
    return (
      <div className="login-screen">
        <div className="login-hero">
          <div className="login-wordmark">CATCH A BEAST</div>
          <h1 className="login-headline">Catch your friends<br />being beasts.</h1>
          <p className="login-subtext">Earn Beast Points. Become a Beast.</p>
        </div>
        <div className="login-card">
          <form onSubmit={submitLogin}>
            <input
              autoFocus
              placeholder="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" disabled={loading || email.trim().length <= 2 || password.length < 8}>
              {loading ? 'Loading…' : 'Log In'}
            </button>
          </form>
          {error && errorCode === 'unverified' && (
            <div className="unverified-block">
              <p>Almost there — verify your email first.</p>
              <p className="fineprint">Check your inbox for the confirmation link we sent when you signed up.</p>
            </div>
          )}
          {error && errorCode !== 'unverified' && <p className="error">{error}</p>}
          <button type="button" onClick={() => { setScreen('landing'); setError(''); }}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <div className="login-hero">
        <div className="login-wordmark">CATCH A BEAST</div>
        <h1 className="login-headline">Catch your friends<br />being beasts.</h1>
        <p className="login-subtext">Earn Beast Points. Become a Beast.</p>
      </div>
      <div className="login-card">
        <div className="auth-toggle">
          <button type="button" onClick={() => { setError(''); setScreen('signup-realname'); }}>Create Account</button>
          <button type="button" className="secondary" onClick={() => { setError(''); setScreen('login'); }}>Log In</button>
        </div>
        <p className="fineprint">Your display name is shown publicly on the leaderboard and on posts anyone can see in Discover — your email stays private and is only used to sign in.</p>
        <p className="fineprint"><a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a></p>
      </div>
    </div>
  );
}

function XpBar({ levelInfo }) {
  const pct = Math.max(0, Math.min(1, levelInfo.progressToNext)) * 100;
  return (
    <div className="xp-panel">
      <div className="xp-panel-top">
        <div>
          <div className="level-title">{levelInfo.title}</div>
          <div className="level-sub">Level {levelInfo.level} · {levelInfo.xp} Beast Points</div>
        </div>
      </div>
      <div className="xp-bar-track">
        <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="xp-bar-caption">
        {levelInfo.nextLevelMinXp
          ? `${levelInfo.nextLevelMinXp - levelInfo.xp} Beast Points to next level`
          : 'Max level reached — you are a certified Ferda Beast'}
      </div>
    </div>
  );
}

function PeriodTotals({ periodTotals }) {
  if (!periodTotals) return null;
  const rows = [
    ['Today', periodTotals.today],
    ['This Week', periodTotals.week],
    ['This Month', periodTotals.month],
    ['This Year', periodTotals.year],
  ];
  return (
    <div className="period-totals">
      {rows.map(([label, value]) => (
        <div key={label} className="period-stat">
          <span className="period-value">{value}</span>
          <span className="period-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

async function getCameraStream(facingMode) {
  const attempts = [
    { video: { facingMode: { exact: facingMode } }, audio: false },
    { video: { facingMode }, audio: false },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function DualCameraCapture({ onCapture, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const shotsRef = useRef({});
  const [phase, setPhase] = useState('back'); // 'back' | 'front' | 'review' | 'composing'
  const [error, setError] = useState('');
  const [reviewUrls, setReviewUrls] = useState(null); // { back, front } data URLs, only set once both shots exist
  const [swapped, setSwapped] = useState(false); // which shot is the big one vs the corner inset

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function startPhase(nextPhase) {
    setError('');
    stopStream();
    try {
      const stream = await getCameraStream(nextPhase === 'back' ? 'environment' : 'user');
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setPhase(nextPhase);
    } catch {
      setError("Couldn't access your camera. You can choose a photo instead.");
    }
  }

  useEffect(() => {
    startPhase('back');
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function grabFrame() {
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    return canvas;
  }

  async function handleShutter() {
    if (phase === 'back') {
      shotsRef.current.back = grabFrame();
      await startPhase('front');
    } else if (phase === 'front') {
      shotsRef.current.front = grabFrame();
      stopStream();
      setReviewUrls({
        back: shotsRef.current.back.toDataURL('image/jpeg', 0.85),
        front: shotsRef.current.front.toDataURL('image/jpeg', 0.85),
      });
      setPhase('review');
    }
  }

  // Both shots get uploaded as separate photos (not flattened into one image)
  // so viewers can tap to swap which one is big/small right in the feed,
  // the same way they can here — see PostCard's post-photo-inset button.
  function handleUsePhoto() {
    setPhase('composing');
    const mainCanvas = shotsRef.current[swapped ? 'front' : 'back'];
    const insetCanvas = shotsRef.current[swapped ? 'back' : 'front'];
    mainCanvas.toBlob((mainBlob) => {
      insetCanvas.toBlob((insetBlob) => {
        if (mainBlob && insetBlob) onCapture({ main: mainBlob, inset: insetBlob });
        else setError('Could not process the photo — try again.');
      }, 'image/jpeg', 0.88);
    }, 'image/jpeg', 0.88);
  }

  function handleCancel() {
    stopStream();
    onCancel();
  }

  if (error) {
    return (
      <div className="dual-capture">
        <p className="error">{error}</p>
        <button type="button" className="secondary-btn" onClick={handleCancel}>Back</button>
      </div>
    );
  }

  if (phase === 'review' || phase === 'composing') {
    const mainUrl = swapped ? reviewUrls.front : reviewUrls.back;
    const insetUrl = swapped ? reviewUrls.back : reviewUrls.front;
    return (
      <div className="dual-capture">
        <div className="dual-review-frame">
          <img src={mainUrl} alt="" className="dual-review-main" />
          <button
            type="button"
            className="dual-review-inset"
            onClick={() => setSwapped((s) => !s)}
            aria-label="Swap which photo is the main one"
          >
            <img src={insetUrl} alt="" />
          </button>
        </div>
        <p className="dual-capture-hint">
          {phase === 'review' ? 'Tap the small photo to flip which one is on top' : 'Preparing your photos…'}
        </p>
        {phase === 'review' && (
          <div className="dual-capture-actions">
            <button type="button" className="secondary-btn" onClick={handleCancel}>Cancel</button>
            <button type="button" className="dual-capture-btn" onClick={handleUsePhoto}>Use Photo</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="dual-capture">
      <video ref={videoRef} className={`dual-capture-video ${phase === 'front' ? 'mirrored' : ''}`} playsInline muted autoPlay />
      <p className="dual-capture-hint">
        {phase === 'back' && "1/2 — Capture what you're looking at"}
        {phase === 'front' && '2/2 — Now capture yourself'}
      </p>
      <div className="dual-capture-actions">
        <button type="button" className="secondary-btn" onClick={handleCancel}>Cancel</button>
        <button type="button" className="shutter-btn" onClick={handleShutter} aria-label="Capture" />
      </div>
    </div>
  );
}

function CreatePostForm({ myGroups, currentUsername, onSubmit, onClose, onSearchUsers, onCreateActivity, fixedGroupId }) {
  const [destination, setDestination] = useState(fixedGroupId ? 'group' : 'public');
  const [groupId, setGroupId] = useState(fixedGroupId || myGroups[0]?.id || '');
  const [subjectUsername, setSubjectUsername] = useState('');
  const [subjectQuery, setSubjectQuery] = useState('');
  const [subjectResults, setSubjectResults] = useState([]);
  const [isStranger, setIsStranger] = useState(false);
  const [strangerName, setStrangerName] = useState('');
  const [customActivity, setCustomActivity] = useState('');
  const [points, setPoints] = useState(10);
  const [caption, setCaption] = useState('');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [insetPhoto, setInsetPhoto] = useState(null);
  const [insetPreview, setInsetPreview] = useState('');
  const [dualCaptureOpen, setDualCaptureOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedGroup = myGroups.find((g) => g.id === Number(groupId));
  const groupMembers = (selectedGroup?.members || []).filter((m) => m.toLowerCase() !== currentUsername.toLowerCase());
  const isSelfPost = destination === 'group' && !!subjectUsername && subjectUsername.toLowerCase() === currentUsername.toLowerCase();

  async function runSubjectSearch(q) {
    setSubjectQuery(q);
    setSubjectUsername('');
    if (q.trim().length < 1) {
      setSubjectResults([]);
      return;
    }
    setSubjectResults(await onSearchUsers(q.trim()));
  }

  function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
    setInsetPhoto(null);
    setInsetPreview('');
  }

  function handleDualCapture({ main, inset }) {
    setPhoto(main);
    setPreview(URL.createObjectURL(main));
    setInsetPhoto(inset);
    setInsetPreview(URL.createObjectURL(inset));
    setDualCaptureOpen(false);
  }

  function retakePhoto() {
    setPhoto(null);
    setPreview('');
    setInsetPhoto(null);
    setInsetPreview('');
  }

  async function submit(e) {
    e.preventDefault();
    if (!photo) return setError('Add a photo first');
    if (isStranger) {
      if (!strangerName.trim()) return setError('Give them a name or description');
    } else {
      if (!subjectUsername) return setError(destination === 'group' ? 'Pick who to credit' : 'Search for who to credit');
    }
    if (destination === 'group' && !groupId) return setError('Pick a group');
    let pointsNum = 0;
    if (!isStranger) {
      pointsNum = Number(points);
      if (!Number.isInteger(pointsNum) || pointsNum < 1 || pointsNum > 100) {
        return setError('Beast Points must be between 1 and 100');
      }
    }
    setError('');
    setSubmitting(true);
    try {
      let finalActivityKey = null;
      if (customActivity.trim()) {
        const created = await onCreateActivity(customActivity.trim());
        finalActivityKey = created.key;
      }
      await onSubmit({
        subjectUsername: isStranger ? '' : subjectUsername,
        subjectDisplayName: isStranger ? strangerName.trim() : '',
        activityKey: finalActivityKey,
        caption,
        photo,
        insetPhoto,
        points: pointsNum,
        visibility: destination,
        groupId: destination === 'group' ? groupId : null,
        isAnonymous: destination === 'public' && isAnonymous,
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="credit-modal-backdrop" onClick={onClose}>
      <form className="credit-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Catch a Beast</h2>

        {!fixedGroupId && (
          <div className="destination-toggle">
            <button type="button" className={destination === 'public' ? 'active' : ''} onClick={() => setDestination('public')}>Post publicly</button>
            <button type="button" className={destination === 'group' ? 'active' : ''} onClick={() => setDestination('group')} disabled={!myGroups.length}>Post to a group</button>
          </div>
        )}
        {destination === 'group' && !myGroups.length && (
          <p className="fineprint">Join or create a group first to post there.</p>
        )}

        {dualCaptureOpen ? (
          <DualCameraCapture onCapture={handleDualCapture} onCancel={() => setDualCaptureOpen(false)} />
        ) : preview ? (
          <div className="photo-picker has-preview">
            <img src={preview} alt="" className="photo-preview" />
            {insetPreview && <img src={insetPreview} alt="" className="photo-preview-inset" />}
            <button type="button" className="secondary-btn retake-btn" onClick={retakePhoto}>Retake</button>
          </div>
        ) : (
          <div className="photo-capture-options">
            <button type="button" className="dual-capture-btn" onClick={() => setDualCaptureOpen(true)}>Dual Capture</button>
            <label className="photo-picker-fallback">
              Or choose a single photo
              <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden />
            </label>
          </div>
        )}

        {destination === 'group' ? (
          <>
            {!fixedGroupId && (
              <label>
                Which group?
                <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setSubjectUsername(''); }}>
                  {myGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </label>
            )}
            <label>
              Who's the beast?
              <div className="subject-row">
                <select value={subjectUsername} onChange={(e) => setSubjectUsername(e.target.value)}>
                  <option value="">Pick a member</option>
                  <option value={currentUsername}>Yourself</option>
                  {groupMembers.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              {isSelfPost && (
                <p className="fineprint">Posting about yourself — the points you set below just show on the card, they don't count toward your real total. Only points other members give you for real do.</p>
              )}
            </label>
          </>
        ) : isStranger ? (
          <label>
            Who's the beast?
            <input
              type="text"
              maxLength={60}
              placeholder="e.g. guy in the red hat"
              value={strangerName}
              onChange={(e) => setStrangerName(e.target.value)}
              autoFocus
            />
            <button type="button" className="link-btn" onClick={() => { setIsStranger(false); setStrangerName(''); }}>
              Actually, I know their username
            </button>
          </label>
        ) : (
          <label>
            Who's the beast?
            <div className="subject-row">
              <input
                type="text"
                placeholder="Search any nickname"
                value={subjectUsername || subjectQuery}
                onChange={(e) => runSubjectSearch(e.target.value)}
              />
            </div>
            {subjectResults.length > 0 && !subjectUsername && (
              <div className="subject-results">
                {subjectResults.map((name) => (
                  <button type="button" key={name} className="subject-result" onClick={() => { setSubjectUsername(name); setSubjectResults([]); }}>
                    {name}
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="link-btn" onClick={() => { setIsStranger(true); setSubjectUsername(''); setSubjectQuery(''); setSubjectResults([]); }}>
              I don't know if they have the app
            </button>
          </label>
        )}

        <label>
          What'd they do? (optional)
          <input
            type="text"
            maxLength={40}
            placeholder="e.g. Fell asleep in the library"
            value={customActivity}
            onChange={(e) => setCustomActivity(e.target.value)}
          />
        </label>

        {!isStranger && (
          <>
            <label>
              Beast Points to give (1-100)
              <input
                type="number"
                min="1"
                max="100"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
            </label>
            <p className="fineprint">Everyone else who sees the post can chip in more on top of this.</p>
          </>
        )}
        {isStranger && (
          <p className="fineprint">No account, no points — this is just for the feed. Others can still throw points at the post for fun, but they won't count toward anyone's real score.</p>
        )}

        <label>
          Caption (optional)
          <input type="text" maxLength={140} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="caught him in the wild..." />
        </label>

        {destination === 'public' && (
          <label className="anon-toggle">
            <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
            Post anonymously — hide that it was you who posted this
          </label>
        )}

        {error && <p className="error">{error}</p>}

        <div className="credit-modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={submitting}>{submitting ? 'Posting…' : 'Post it'}</button>
        </div>
      </form>
    </div>
  );
}

const REACTION_EMOJIS = ['🔥', '😂', '💀', '👑', '🐐'];

// TEMP: 4 selectable variants for A/B testing the crediting UX, picked via
// the temporary credit-style bar in the header (see App). Remove the
// branching (and 3 of the 4 variant components) once one is chosen.
function CreditFormPresets({ post, submit, close, error, submitting }) {
  const [showCustom, setShowCustom] = useState(false);
  const [customAmount, setCustomAmount] = useState(Math.min(10, post.maxCredit));
  const presets = [5, 10, 25, 50].filter((p) => p <= post.maxCredit);

  if (showCustom) {
    return (
      <form className="give-credit-form" onSubmit={(e) => { e.preventDefault(); submit(Number(customAmount)); }}>
        <input type="number" min="1" max={post.maxCredit} value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} autoFocus />
        <button type="submit" disabled={submitting}>Give</button>
        <button type="button" className="secondary-btn" onClick={close}>×</button>
        {error && <span className="error">{error}</span>}
      </form>
    );
  }
  return (
    <div className="give-credit-form give-credit-presets">
      {presets.map((p) => (
        <button key={p} type="button" className="preset-btn" onClick={() => submit(p)} disabled={submitting}>+{p}</button>
      ))}
      {post.maxCredit > (presets[presets.length - 1] || 0) && (
        <button type="button" className="preset-btn" onClick={() => submit(post.maxCredit)} disabled={submitting}>Max</button>
      )}
      <button type="button" className="secondary-btn" onClick={() => setShowCustom(true)}>Custom</button>
      <button type="button" className="secondary-btn" onClick={close}>×</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function CreditFormHold({ post, submit, close, error, submitting }) {
  const [amount, setAmount] = useState(0);
  const [holding, setHolding] = useState(false);
  const intervalRef = useRef(null);
  const startRef = useRef(0);

  function startHold() {
    if (submitting) return;
    setHolding(true);
    setAmount(1);
    startRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      const pct = Math.min(1, elapsed / 2200);
      setAmount(Math.max(1, Math.min(post.maxCredit, Math.round(pct * pct * post.maxCredit))));
    }, 40);
  }
  function endHold() {
    setHolding(false);
    clearInterval(intervalRef.current);
  }
  function release() {
    if (!holding) return;
    endHold();
    if (amount > 0) submit(amount);
  }

  useEffect(() => () => clearInterval(intervalRef.current), []);

  return (
    <div className="give-credit-form give-credit-hold">
      <div className="hold-amount">{amount > 0 ? `${amount} BP` : 'Hold below'}</div>
      <button
        type="button"
        className={`hold-btn ${holding ? 'holding' : ''}`}
        onPointerDown={startHold}
        onPointerUp={release}
        onPointerLeave={() => holding && release()}
        disabled={submitting}
      >
        {holding ? 'Keep holding…' : 'Hold to pump'}
      </button>
      <button type="button" className="secondary-btn" onClick={close}>×</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function CreditFormSlider({ post, submit, close, error, submitting }) {
  const [amount, setAmount] = useState(Math.min(10, post.maxCredit));
  return (
    <div className="give-credit-form give-credit-slider">
      <input type="range" min="1" max={post.maxCredit} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      <div className="slider-amount">{amount} BP</div>
      <button type="button" onClick={() => submit(amount)} disabled={submitting}>Give</button>
      <button type="button" className="secondary-btn" onClick={close}>×</button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function CreditFormPunchy({ post, submit, close, error, submitting }) {
  const [amount, setAmount] = useState(Math.min(10, post.maxCredit));
  return (
    <form className="give-credit-form give-credit-punchy" onSubmit={(e) => { e.preventDefault(); submit(Number(amount)); }}>
      <input type="number" min="1" max={post.maxCredit} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <button type="submit" className="punchy-give-btn" disabled={submitting}>Give</button>
      <button type="button" className="secondary-btn" onClick={close}>×</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function GiveCredit({ post, onCredit }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const creditStyle = (typeof window !== 'undefined' && localStorage.getItem('creditStyle')) || 'presets';

  async function submit(amount) {
    setError('');
    setSubmitting(true);
    try {
      await onCredit(post.id, Number(amount));
      setOpen(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="give-credit-btn" onClick={() => setOpen(true)}>
        {post.myCredit ? `You gave ${post.myCredit} BP` : 'Give points'}
      </button>
    );
  }
  const props = { post, submit, close: () => setOpen(false), error, submitting };
  if (creditStyle === 'hold') return <CreditFormHold {...props} />;
  if (creditStyle === 'slider') return <CreditFormSlider {...props} />;
  if (creditStyle === 'punchy') return <CreditFormPunchy {...props} />;
  return <CreditFormPresets {...props} />;
}

function ReportButton({ post, onReport }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await onReport(post.id, reason.trim());
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError(err.message);
    }
  }

  if (done) return <span className="flag-done">Reported ✓</span>;
  if (!open) {
    return <button type="button" className="flag-btn" onClick={() => setOpen(true)}>Report</button>;
  }
  return (
    <form className="report-form" onSubmit={submit}>
      <input
        autoFocus
        placeholder="What's wrong with this post?"
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" disabled={!reason.trim()}>Send</button>
      <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>×</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function CustomReaction({ post, onReact }) {
  const [open, setOpen] = useState(false);
  const [emoji, setEmoji] = useState('');

  async function submit(e) {
    e.preventDefault();
    const value = emoji.trim();
    if (!value) return;
    await onReact(post.id, value);
    setEmoji('');
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="photo-reaction-btn custom-reaction-btn" onClick={() => setOpen(true)}>
        ＋
      </button>
    );
  }
  return (
    <form className="custom-reaction-form" onSubmit={submit}>
      <input type="text" maxLength={16} placeholder="🫡" value={emoji} onChange={(e) => setEmoji(e.target.value)} autoFocus />
      <button type="submit">React</button>
      <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>×</button>
    </form>
  );
}

function CommentsSection({ post, onComment }) {
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setError('');
    setSubmitting(true);
    try {
      await onComment(post.id, body.trim());
      setBody('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="comments-section">
      {post.comments.length > 0 && (
        <ul className="comments-list">
          {post.comments.map((c) => (
            <li key={c.id} className="comment-item"><strong>{c.username}</strong> {c.body}</li>
          ))}
        </ul>
      )}
      <form className="comment-form" onSubmit={submit}>
        <input type="text" maxLength={300} placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button type="submit" disabled={submitting || !body.trim()}>Post</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PostCard({ post, currentUsername, onReact, onComment, onSave, onCredit, onReport, onBlock }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [swapped, setSwapped] = useState(false); // tap-to-swap which shot is on top, purely local to this viewer
  const isSubject = post.subjectUsername.toLowerCase() === currentUsername.toLowerCase();
  const isPoster = post.creditedByUsername.toLowerCase() === currentUsername.toLowerCase();
  const hoursLeft = post.saved ? null : Math.max(0, Math.ceil((Date.parse(post.expiresAt) - Date.now()) / 3600000));
  const posterName = post.isAnonymous ? 'Anonymous' : post.creditedByUsername;
  const posterInitial = post.isAnonymous ? '🕵️' : posterName.charAt(0).toUpperCase();

  return (
    <div className="post-card">
      <div className="post-card-head">
        <div className={`post-avatar ${post.isAnonymous ? 'anon' : ''}`}>
          {post.creditedByAvatarUrl ? <img src={post.creditedByAvatarUrl} alt="" /> : posterInitial}
        </div>
        <div className="post-head-text">
          <div className="post-head-line">
            <strong className={post.isAnonymous ? 'anon-name' : ''}>{posterName}</strong>
            <span className="post-head-arrow">caught</span>
            <strong>{post.subjectDisplayName || post.subjectUsername}</strong>
          </div>
          <div className="post-head-meta">
            {post.visibility === 'group' ? post.groupName : 'Public'}
            {post.activityName && <> · {post.activityIcon} {post.activityName}</>}
            {' · '}{post.saved ? 'saved' : `${hoursLeft}h left`}
          </div>
        </div>
        <button type="button" className="post-menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="More options">⋯</button>
        {menuOpen && (
          <div className="post-menu-dropdown">
            <ReportButton post={post} onReport={onReport} />
            {!isPoster && !post.isAnonymous && (
              <button type="button" className="flag-btn" onClick={() => onBlock(post.creditedByUsername)}>
                Block {post.creditedByUsername}
              </button>
            )}
          </div>
        )}
      </div>

      {post.caption && <p className="post-card-caption">{post.caption}</p>}

      <div className="post-photo-wrap">
        <img className="post-photo-full" src={swapped && post.insetPhotoUrl ? post.insetPhotoUrl : post.photoUrl} alt="" />
        {post.insetPhotoUrl && (
          <button
            type="button"
            className="post-photo-inset"
            onClick={() => setSwapped((s) => !s)}
            aria-label="Swap which photo is on top"
          >
            <img src={swapped ? post.photoUrl : post.insetPhotoUrl} alt="" />
          </button>
        )}
        <div className="post-points-badge">+{post.points} BP</div>
        <div className="post-photo-actions">
          {[...REACTION_EMOJIS, ...post.reactions.map((r) => r.emoji).filter((e) => !REACTION_EMOJIS.includes(e))].map((emoji) => {
            const count = post.reactions.find((r) => r.emoji === emoji)?.count || 0;
            const mine = post.myReaction === emoji;
            return (
              <button
                key={emoji}
                className={`photo-reaction-btn ${mine ? 'mine' : ''}`}
                onClick={() => onReact(post.id, emoji)}
              >
                {emoji}
                {count > 0 && <span className="photo-reaction-count">{count}</span>}
              </button>
            );
          })}
          <CustomReaction post={post} onReact={onReact} />
        </div>
      </div>

      <div className="post-card-footer">
        {post.creditorCount > 1 && <span className="post-creditors">{post.creditorCount} chipped in</span>}
        {!isSubject && <GiveCredit post={post} onCredit={onCredit} />}
        {isSubject && (
          <button className="save-btn" onClick={() => onSave(post.id)}>
            {post.saved ? 'Unsave' : 'Keep forever'}
          </button>
        )}
      </div>

      <CommentsSection post={post} onComment={onComment} />
    </div>
  );
}

function PostList({ posts, currentUsername, onReact, onComment, onSave, onCredit, onReport, onBlock, emptyText }) {
  if (!posts.length) return <div className="empty-state">{emptyText}</div>;
  return (
    <div className="post-list">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} currentUsername={currentUsername} onReact={onReact} onComment={onComment} onSave={onSave} onCredit={onCredit} onReport={onReport} onBlock={onBlock} />
      ))}
    </div>
  );
}

function DiscoverView({ discoverFeed, myGroups, currentUsername, onSubmitPost, onReact, onComment, onSave, onCredit, onSearchUsers, onCreateActivity, onReport, onBlock, showComposer, onCloseComposer }) {
  return (
    <div className="feed-view">
      {showComposer && (
        <CreatePostForm
          myGroups={myGroups}
          currentUsername={currentUsername}
          onSubmit={onSubmitPost}
          onClose={onCloseComposer}
          onSearchUsers={onSearchUsers}
          onCreateActivity={onCreateActivity}
        />
      )}
      <PostList
        posts={discoverFeed}
        currentUsername={currentUsername}
        onReact={onReact}
        onComment={onComment}
        onSave={onSave}
        onCredit={onCredit}
        onReport={onReport}
        onBlock={onBlock}
        emptyText="No public posts yet — be the first to catch someone being a beast."
      />
    </div>
  );
}

function CreateGroupForm({ onCreate, onClose }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('public');
  const [gateType, setGateType] = useState('approval'); // 'approval' | 'password' — only matters when private
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const pw = visibility === 'private' && gateType === 'password' ? password.trim() : '';
      await onCreate(name.trim(), description.trim(), visibility, pw);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const passwordInvalid = visibility === 'private' && gateType === 'password' && password.trim().length > 0 && password.trim().length < 4;

  return (
    <div className="credit-modal-backdrop" onClick={onClose}>
      <form className="credit-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Create a group</h2>
        <label>
          Group name
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sig Ep Squad" autoFocus />
        </label>
        <label>
          Description (optional)
          <input value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} placeholder="What's this group about?" />
        </label>

        <div className="destination-toggle">
          <button type="button" className={visibility === 'public' ? 'active' : ''} onClick={() => setVisibility('public')}>Public</button>
          <button type="button" className={visibility === 'private' ? 'active' : ''} onClick={() => setVisibility('private')}>Private</button>
        </div>
        {visibility === 'public' && <p className="fineprint">Anyone can join instantly — no approval needed.</p>}

        {visibility === 'private' && (
          <>
            <div className="destination-toggle">
              <button type="button" className={gateType === 'approval' ? 'active' : ''} onClick={() => setGateType('approval')}>You approve members</button>
              <button type="button" className={gateType === 'password' ? 'active' : ''} onClick={() => setGateType('password')}>Set a password</button>
            </div>
            {gateType === 'approval' && <p className="fineprint">People can request to join — you decide who gets in.</p>}
            {gateType === 'password' && (
              <label>
                Group password
                <input
                  type="text"
                  maxLength={40}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 4 characters"
                />
              </label>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}
        <div className="credit-modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            disabled={submitting || name.trim().length < 1 || passwordInvalid || (visibility === 'private' && gateType === 'password' && password.trim().length < 4)}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

function GroupRequestsSection({ groupId, onApprovedOrDeclined }) {
  const [requests, setRequests] = useState(null); // null = still loading

  async function refresh() {
    setRequests(await api.getGroupRequests(groupId));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  async function respond(userId, action) {
    await api.respondToGroupRequest(groupId, userId, action);
    await refresh();
    if (action === 'approve') await onApprovedOrDeclined();
  }

  if (!requests || requests.length === 0) return null;

  return (
    <section className="friend-section">
      <h2>Requests to join ({requests.length})</h2>
      {requests.map((r) => (
        <div key={r.userId} className="friend-row">
          <span>{r.username}</span>
          <div className="friend-row-actions">
            <button className="friend-action" onClick={() => respond(r.userId, 'approve')}>Approve</button>
            <button className="friend-action remove" onClick={() => respond(r.userId, 'decline')}>Decline</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function GroupDetail({ group, groupFeed, currentUsername, onBack, onLeave, onSubmitPost, onReact, onComment, onSave, onCredit, onCreateActivity, onReport, onBlock, onRefreshGroup }) {
  const [showForm, setShowForm] = useState(false);
  return (
    <div className="group-detail">
      <button className="back-btn" onClick={onBack}>← All groups</button>
      <div className="group-detail-header">
        <h2>{group.name} {group.visibility === 'private' && <span className="friend-status">private</span>}</h2>
        {group.description && <p className="group-description">{group.description}</p>}
        <p className="group-member-count">{group.memberCount}/{group.maxMembers} members</p>
        <div className="group-members-list">{group.members.join(', ')}</div>
        <button className="friend-action remove" onClick={() => onLeave(group.id)}>Leave group</button>
      </div>

      {group.isModerator && group.visibility === 'private' && !group.hasPassword && (
        <GroupRequestsSection groupId={group.id} onApprovedOrDeclined={onRefreshGroup} />
      )}

      <button className="credit-friend-btn" onClick={() => setShowForm(true)}>Post to {group.name}</button>
      {showForm && (
        <CreatePostForm
          myGroups={[group]}
          fixedGroupId={group.id}
          currentUsername={currentUsername}
          onSubmit={onSubmitPost}
          onClose={() => setShowForm(false)}
          onCreateActivity={onCreateActivity}
        />
      )}

      <PostList
        posts={groupFeed}
        currentUsername={currentUsername}
        onReact={onReact}
        onComment={onComment}
        onSave={onSave}
        onCredit={onCredit}
        onReport={onReport}
        onBlock={onBlock}
        emptyText="No posts in this group yet."
      />
    </div>
  );
}

function DiscoverGroupRow({ group, onJoin, onCancelRequest }) {
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const full = group.memberCount >= group.maxMembers;

  async function submitPassword(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await onJoin(group.id, password);
      setShowPasswordInput(false);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function requestOrJoin() {
    if (group.visibility === 'private' && group.hasPassword) {
      setShowPasswordInput(true);
      return;
    }
    setError('');
    try {
      await onJoin(group.id);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="friend-row">
      <span>
        {group.name} {group.visibility === 'private' && <span className="friend-status">private</span>}{' '}
        <span className="friend-status">{group.memberCount}/{group.maxMembers}</span>
      </span>

      {group.hasPendingRequest ? (
        <button className="friend-action" onClick={() => onCancelRequest(group.id)}>Cancel request</button>
      ) : showPasswordInput ? (
        <form className="dare-form" onSubmit={submitPassword}>
          <input
            type="text"
            placeholder="Group password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={submitting || !password.trim()}>Join</button>
        </form>
      ) : (
        <button className="friend-action" onClick={requestOrJoin} disabled={full}>
          {full ? 'Full' : group.visibility === 'private' && !group.hasPassword ? 'Request to join' : 'Join'}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function GroupsView({ myGroups, discoverGroups, onSearchGroups, onCreateGroup, onJoinGroup, onCancelGroupRequest, onOpenGroup }) {
  const [showCreate, setShowCreate] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <div className="groups-view">
      <button className="credit-friend-btn" onClick={() => setShowCreate(true)}>+ Create a group</button>
      {showCreate && <CreateGroupForm onCreate={onCreateGroup} onClose={() => setShowCreate(false)} />}

      <section className="friend-section">
        <h2>My Groups ({myGroups.length})</h2>
        {myGroups.length === 0 && <div className="empty-state">You're not in any groups yet.</div>}
        {myGroups.map((g) => (
          <button key={g.id} className="group-row" onClick={() => onOpenGroup(g.id)}>
            <span className="group-row-name">{g.name} {g.visibility === 'private' && <span className="friend-status">private</span>}</span>
            <span className="group-row-meta">{g.memberCount}/{g.maxMembers} members</span>
          </button>
        ))}
      </section>

      <section className="friend-section">
        <h2>Discover Groups</h2>
        <input
          className="friend-search-input"
          placeholder="Search groups by name"
          value={query}
          onChange={(e) => { setQuery(e.target.value); onSearchGroups(e.target.value); }}
        />
        {discoverGroups.map((g) => (
          <DiscoverGroupRow key={g.id} group={g} onJoin={onJoinGroup} onCancelRequest={onCancelGroupRequest} />
        ))}
      </section>
    </div>
  );
}

const WEEKDAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function MemoriesView({ memories, onBack }) {
  // Group into { "YYYY-MM": { dayNumber: memory } } — first post wins per day.
  const byMonth = {};
  for (const m of memories) {
    const [year, month, day] = m.date.split('-');
    const key = `${year}-${month}`;
    if (!byMonth[key]) byMonth[key] = {};
    const dayNum = Number(day);
    if (!byMonth[key][dayNum]) byMonth[key][dayNum] = m;
  }
  const monthKeys = Object.keys(byMonth).sort().reverse();

  return (
    <div className="memories-view">
      <div className="memories-header">
        <button type="button" className="memories-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Memories</h2>
      </div>
      {monthKeys.length === 0 && (
        <div className="empty-state">No memories yet — post a beast to start your history.</div>
      )}
      {monthKeys.map((key) => {
        const [year, month] = key.split('-').map(Number);
        const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long' });
        const daysInMonth = new Date(year, month, 0).getDate();
        const firstWeekday = new Date(year, month - 1, 1).getDay();
        const days = byMonth[key];
        const cells = [];
        for (let i = 0; i < firstWeekday; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) cells.push(d);

        return (
          <div key={key} className="memories-month">
            <h3 className="memories-month-title">{monthName} {year}</h3>
            <div className="memories-weekdays">
              {WEEKDAY_LABELS.map((w) => <span key={w}>{w}</span>)}
            </div>
            <div className="memories-grid">
              {cells.map((d, i) => {
                if (d === null) return <div key={`blank-${i}`} className="memories-cell blank" />;
                const memory = days[d];
                return (
                  <div key={d} className={`memories-cell ${memory ? 'has-photo' : ''}`}>
                    {memory && <img src={memory.photoUrl} alt="" className="memories-thumb" />}
                    <span className="memories-day-num">{d}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BadgesView({ badges }) {
  if (!badges.length) {
    return <div className="empty-state">No badges yet — catch a beast or get caught being one.</div>;
  }
  return (
    <div className="badges-grid">
      {badges.map((b) => (
        <div key={b.key} className="badge-card">
          <div className="badge-icon">{b.icon}</div>
          <div className="badge-name">{b.name}</div>
          <div className="badge-desc">{b.desc}</div>
        </div>
      ))}
    </div>
  );
}

function LeaderboardView({ leaderboard, currentUsername }) {
  return (
    <div className="leaderboard">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Level</th>
            <th>BP</th>
            <th>Posts</th>
            <th>Badges</th>
          </tr>
        </thead>
        <tbody>
          {leaderboard.map((row, i) => (
            <tr key={row.username} className={row.username.toLowerCase() === currentUsername.toLowerCase() ? 'me' : ''}>
              <td>{i + 1}</td>
              <td>
                <span className="leaderboard-player">
                  <span className="leaderboard-avatar">
                    {row.avatarUrl ? <img src={row.avatarUrl} alt="" /> : row.username.charAt(0).toUpperCase()}
                  </span>
                  {row.username}
                </span>
              </td>
              <td>{row.title} <span className="lvl-num">(Lv {row.level})</span></td>
              <td>{row.totalXp}</td>
              <td>{row.creditedPostCount}</td>
              <td>{row.badgeCount}</td>
            </tr>
          ))}
          {leaderboard.length === 0 && (
            <tr><td colSpan={6} className="empty-state">No players yet — be the first!</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DaresSection({ onSearchUsers }) {
  const [dares, setDares] = useState(null); // null = still loading
  const [targetQuery, setTargetQuery] = useState('');
  const [targetUsername, setTargetUsername] = useState('');
  const [targetResults, setTargetResults] = useState([]);
  const [description, setDescription] = useState('');
  const [wager, setWager] = useState(10);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setDares(await api.getDares());
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTargetSearch(q) {
    setTargetQuery(q);
    setTargetUsername('');
    if (q.trim().length < 1) return setTargetResults([]);
    setTargetResults(await onSearchUsers(q.trim()));
  }

  async function submit(e) {
    e.preventDefault();
    if (!targetUsername) return setError('Search for who to dare');
    const wagerNum = Number(wager);
    if (!Number.isInteger(wagerNum) || wagerNum < 1 || wagerNum > 100) {
      return setError('Wager must be between 1 and 100');
    }
    setError('');
    setSubmitting(true);
    try {
      await api.issueDare(targetUsername, description.trim(), wagerNum);
      setTargetUsername('');
      setTargetQuery('');
      setDescription('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (dares === null) return null;
  const pendingForMe = dares.filter((d) => !d.isIssuedByMe && d.status === 'pending');
  const issuedByMe = dares.filter((d) => d.isIssuedByMe);

  return (
    <section className="friend-section">
      <h2>Dares</h2>
      <p className="fineprint">Dare someone to do something and stake a wager — whoever posts a photo fulfilling it wins your wagered points.</p>

      {pendingForMe.length > 0 && (
        <div className="dares-list">
          <h3 className="dares-sublabel">Dares waiting on you</h3>
          {pendingForMe.map((d) => (
            <div key={d.id} className="friend-row">
              <span>{d.issuerUsername} dared you: "{d.description}" — {d.wagerPoints} BP if you do it</span>
            </div>
          ))}
        </div>
      )}

      {issuedByMe.length > 0 && (
        <div className="dares-list">
          <h3 className="dares-sublabel">Dares you've issued</h3>
          {issuedByMe.map((d) => (
            <div key={d.id} className="friend-row">
              <span>{d.targetUsername}: "{d.description}" — {d.wagerPoints} BP <span className="friend-status">{d.status}</span></span>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="dare-form">
        <input
          type="text"
          placeholder="Search who to dare"
          value={targetUsername || targetQuery}
          onChange={(e) => runTargetSearch(e.target.value)}
        />
        {targetResults.length > 0 && !targetUsername && (
          <div className="subject-results">
            {targetResults.map((name) => (
              <button type="button" key={name} className="subject-result" onClick={() => { setTargetUsername(name); setTargetResults([]); }}>
                {name}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          maxLength={200}
          placeholder="What's the dare?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          type="number"
          min="1"
          max="100"
          placeholder="Wager (1-100 BP)"
          value={wager}
          onChange={(e) => setWager(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting || !targetUsername || !description.trim()}>
          {submitting ? 'Sending…' : 'Issue dare'}
        </button>
      </form>
    </section>
  );
}

function FriendsView({ onBack, onSearchUsers }) {
  const [friends, setFriends] = useState(null); // null = still loading
  const [requests, setRequests] = useState({ incoming: [], outgoing: [] });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');

  async function refresh() {
    const [friendList, requestData] = await Promise.all([api.getFriends(), api.getFriendRequests()]);
    setFriends(friendList);
    setRequests(requestData);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(q) {
    setQuery(q);
    if (q.trim().length < 1) return setResults([]);
    setResults(await onSearchUsers(q.trim()));
  }

  async function sendRequest(username) {
    setError('');
    try {
      await api.sendFriendRequest(username);
      setQuery('');
      setResults([]);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function respond(id, action) {
    await api.respondToFriendRequest(id, action);
    await refresh();
  }

  async function cancel(id) {
    await api.cancelFriendRequest(id);
    await refresh();
  }

  async function remove(username) {
    await api.removeFriend(username);
    await refresh();
  }

  if (friends === null) return null;

  const friendUsernames = new Set(friends.map((f) => f.username.toLowerCase()));
  const pendingUsernames = new Set([...requests.incoming, ...requests.outgoing].map((r) => r.username.toLowerCase()));

  return (
    <div className="memories-view">
      <div className="memories-header">
        <button type="button" className="memories-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Friends</h2>
      </div>

      <form className="dare-form" onSubmit={(e) => e.preventDefault()}>
        <input
          type="text"
          placeholder="Search by username"
          value={query}
          onChange={(e) => runSearch(e.target.value)}
        />
        {results.length > 0 && (
          <div className="subject-results">
            {results.map((name) => {
              const already = friendUsernames.has(name.toLowerCase()) || pendingUsernames.has(name.toLowerCase());
              return (
                <button
                  type="button"
                  key={name}
                  className="subject-result"
                  disabled={already}
                  onClick={() => sendRequest(name)}
                >
                  {name} {already ? '✓' : ''}
                </button>
              );
            })}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </form>

      {requests.incoming.length > 0 && (
        <section className="friend-section">
          <h2>Requests</h2>
          {requests.incoming.map((r) => (
            <div key={r.id} className="friend-row">
              <span>{r.username}</span>
              <div className="friend-row-actions">
                <button className="friend-action" onClick={() => respond(r.id, 'accept')}>Accept</button>
                <button className="friend-action remove" onClick={() => respond(r.id, 'decline')}>Decline</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {requests.outgoing.length > 0 && (
        <section className="friend-section">
          <h2>Sent</h2>
          {requests.outgoing.map((r) => (
            <div key={r.id} className="friend-row">
              <span>{r.username} <span className="friend-status">pending</span></span>
              <button className="friend-action" onClick={() => cancel(r.id)}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section className="friend-section">
        <h2>Friends {friends.length ? `(${friends.length})` : ''}</h2>
        {friends.length === 0 && <div className="empty-state">No friends yet — search above to add some.</div>}
        {friends.map((f) => (
          <div key={f.username} className="friend-row">
            <span>{f.username}</span>
            <button className="friend-action remove" onClick={() => remove(f.username)}>Remove</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function ProfileView({ displayName, avatarUrl, friendCount, onOpenFriends, onOpenSettings }) {
  return (
    <div className="profile-view">
      <div className="profile-view-header">
        <button type="button" className="profile-icon-btn" onClick={onOpenFriends} aria-label="Friends"><IconUserPlus /></button>
        <button type="button" className="profile-icon-btn" onClick={onOpenSettings} aria-label="Settings"><IconSettings /></button>
      </div>
      <div className="profile-view-avatar">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{displayName.charAt(0).toUpperCase()}</span>}
      </div>
      <h1 className="profile-view-name">{displayName}</h1>
      <p className="profile-view-friends">{friendCount} friend{friendCount === 1 ? '' : 's'}</p>
    </div>
  );
}

function EditProfileSection({ avatarUrl, onAvatarUpdated }) {
  const [realName, setRealName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [nameStatus, setNameStatus] = useState('');
  const [nameError, setNameError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    api.getMe().then((me) => {
      setRealName(me.realName || '');
      setSavedName(me.realName || '');
    }).catch(() => {});
  }, []);

  async function handleAvatarFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarError('');
    setUploading(true);
    try {
      const { avatarUrl: newUrl } = await api.uploadAvatar(file);
      onAvatarUpdated(newUrl);
    } catch (err) {
      setAvatarError(err.message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function submitName(e) {
    e.preventDefault();
    setNameError('');
    setNameStatus('');
    try {
      await api.updateProfile(realName.trim());
      setSavedName(realName.trim());
      setNameStatus('Saved ✓');
    } catch (err) {
      setNameError(err.message);
    }
  }

  async function submitPassword(e) {
    e.preventDefault();
    setPasswordError('');
    setPasswordStatus('');
    setChangingPassword(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setPasswordStatus('Password updated ✓');
    } catch (err) {
      setPasswordError(err.message);
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <section className="friend-section">
      <h2>Edit Profile</h2>

      <div className="avatar-edit-row">
        <button type="button" className="avatar-edit-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <span className="avatar-edit-placeholder">+</span>}
        </button>
        <div>
          <button type="button" className="link-btn" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Change profile picture'}
          </button>
          {avatarError && <p className="error">{avatarError}</p>}
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={handleAvatarFile} />
      </div>

      <form onSubmit={submitName} className="inline-edit-form">
        <label>
          <span>Name <span className="fineprint">(private — not shown to other users)</span></span>
          <input
            type="text"
            maxLength={60}
            value={realName}
            onChange={(e) => { setRealName(e.target.value); setNameStatus(''); }}
          />
        </label>
        {nameError && <p className="error">{nameError}</p>}
        <button type="submit" disabled={!realName.trim() || realName.trim() === savedName}>
          {nameStatus || 'Save name'}
        </button>
      </form>

      <form onSubmit={submitPassword} className="inline-edit-form">
        <label>
          Current password
          <input type="password" value={currentPassword} onChange={(e) => { setCurrentPassword(e.target.value); setPasswordStatus(''); }} />
        </label>
        <label>
          New password
          <input type="password" placeholder="Min 8 characters" value={newPassword} onChange={(e) => { setNewPassword(e.target.value); setPasswordStatus(''); }} />
        </label>
        {passwordError && <p className="error">{passwordError}</p>}
        <button type="submit" disabled={changingPassword || !currentPassword || newPassword.length < 8}>
          {changingPassword ? 'Updating…' : (passwordStatus || 'Change password')}
        </button>
      </form>
    </section>
  );
}

function SettingsView({ streak, badges, isAdmin, adminReportCount, onOpenAdmin, onOpenMemories, onSearchUsers, blockedUsers, onUnblock, onDeleteAccount, avatarUrl, onAvatarUpdated, onBack }) {
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function submitDelete(e) {
    e.preventDefault();
    setError('');
    setDeleting(true);
    try {
      await onDeleteAccount(password);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  }

  return (
    <div className="settings-view">
      <div className="memories-header">
        <button type="button" className="memories-back" onClick={onBack} aria-label="Back">←</button>
        <h2>Settings</h2>
      </div>

      <EditProfileSection avatarUrl={avatarUrl} onAvatarUpdated={onAvatarUpdated} />

      <section className="friend-section">
        <h2>Beast Streak</h2>
        <div className="streak-summary">
          <span className="streak-summary-current">{streak.current} day{streak.current === 1 ? '' : 's'}</span>
          <span className="fineprint">Longest: {streak.longest} day{streak.longest === 1 ? '' : 's'}</span>
        </div>
        {streak.atRisk && <p className="fineprint">Your bender ends tonight if you don't post today.</p>}
      </section>

      <section className="friend-section">
        <h2>Memories</h2>
        <p className="fineprint">A private history of every beast you've photographed, past the normal 24h.</p>
        <button type="button" className="friend-action" onClick={onOpenMemories}>Open Memories</button>
      </section>

      <DaresSection onSearchUsers={onSearchUsers} />

      <section className="friend-section">
        <h2>Badges {badges.length ? `(${badges.length})` : ''}</h2>
        <BadgesView badges={badges} />
      </section>

      {isAdmin && (
        <section className="friend-section">
          <h2>Admin</h2>
          <button type="button" className="friend-action" onClick={onOpenAdmin}>
            Open moderation queue {adminReportCount ? `(${adminReportCount})` : ''}
          </button>
        </section>
      )}

      <section className="friend-section">
        <h2>Blocked users</h2>
        {blockedUsers.length === 0 && <div className="empty-state">You haven't blocked anyone.</div>}
        {blockedUsers.map((u) => (
          <div key={u} className="friend-row">
            <span>{u}</span>
            <button className="friend-action" onClick={() => onUnblock(u)}>Unblock</button>
          </div>
        ))}
      </section>

      <section className="friend-section">
        <h2>Legal</h2>
        <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>
      </section>

      <section className="friend-section danger-zone">
        <h2>Delete account</h2>
        <p className="fineprint">This permanently deletes your account, posts, and photos. This can't be undone.</p>
        {!confirming ? (
          <button type="button" className="friend-action remove" onClick={() => setConfirming(true)}>Delete my account</button>
        ) : (
          <form onSubmit={submitDelete}>
            <input
              type="password"
              placeholder="Confirm your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            {error && <p className="error">{error}</p>}
            <div className="credit-modal-actions">
              <button type="button" className="secondary-btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button type="submit" disabled={deleting || !password}>{deleting ? 'Deleting…' : 'Permanently delete'}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function AdminView({ reports, onResolve }) {
  if (!reports.length) return <div className="empty-state">No pending reports.</div>;
  return (
    <div className="admin-view">
      {reports.map((r) => (
        <div key={r.id} className="admin-report-card">
          <img className="post-photo" src={r.photoUrl} alt="" />
          <p><strong>{r.subjectDisplayName || r.subjectUsername}</strong> caught by <strong>{r.creditedByUsername}</strong> <span className={`post-visibility ${r.visibility}`}>{r.visibility}</span></p>
          {r.caption && <p className="post-caption">{r.caption}</p>}
          <p className="fineprint">Reported by {r.reporterUsername}: "{r.reason}"</p>
          <div className="credit-modal-actions">
            <button type="button" className="secondary-btn" onClick={() => onResolve(r.id, 'dismiss')}>Dismiss</button>
            <button type="button" className="friend-action remove" onClick={() => onResolve(r.id, 'remove')}>Remove post</button>
            <button type="button" className="friend-action remove" onClick={() => onResolve(r.id, 'ban')}>Remove & ban poster</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function loadStoredAuth() {
  try {
    const raw = localStorage.getItem('ccq_auth');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const [auth, setAuth] = useState(() => {
    const stored = loadStoredAuth();
    if (stored?.token) api.setToken(stored.token);
    return stored;
  });
  const displayName = auth?.displayName || '';
  const isAdmin = !!auth?.isAdmin;
  const [progress, setProgress] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [discoverFeed, setDiscoverFeed] = useState([]);
  const [groups, setGroups] = useState([]);
  const [discoverGroupsList, setDiscoverGroupsList] = useState([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [groupFeed, setGroupFeed] = useState([]);
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [adminReports, setAdminReports] = useState([]);
  const [memories, setMemories] = useState([]);
  const [tab, setTab] = useState('discover');
  const [showComposer, setShowComposer] = useState(false);
  const [transitionStyle, setTransitionStyle] = useState('t-fadeup'); // TEMP: transition A/B test, remove after picking one
  const [creditStyle, setCreditStyleState] = useState(() => (typeof window !== 'undefined' && localStorage.getItem('creditStyle')) || 'presets'); // TEMP: crediting UX A/B test, remove after picking one
  function setCreditStyle(v) {
    localStorage.setItem('creditStyle', v);
    setCreditStyleState(v);
  }
  const [loadError, setLoadError] = useState('');

  function openComposer() {
    setTab('discover');
    setActiveGroupId(null);
    setShowComposer(true);
  }

  async function handleLogin(email, password) {
    const result = await api.login(email, password);
    api.setToken(result.token);
    const authData = { displayName: result.displayName, token: result.token, isAdmin: !!result.isAdmin, avatarUrl: result.avatarUrl || null };
    localStorage.setItem('ccq_auth', JSON.stringify(authData));
    setAuth(authData);
  }

  async function handleSignupStart(realName, username, email) {
    return api.signupStart(realName, username, email);
  }

  async function handleSignupResendCode(email) {
    return api.signupResendCode(email);
  }

  async function handleSignupVerifyCode(email, code) {
    return api.signupVerifyCode(email, code);
  }

  function handleAvatarUpdated(avatarUrl) {
    setAuth((prev) => {
      if (!prev) return prev;
      const next = { ...prev, avatarUrl };
      localStorage.setItem('ccq_auth', JSON.stringify(next));
      return next;
    });
  }

  async function handleSignupFinish(email, password, avatarFile) {
    const result = await api.signupFinish(email, password);
    api.setToken(result.token);
    const authData = { displayName: result.displayName, token: result.token, isAdmin: !!result.isAdmin, avatarUrl: result.avatarUrl || null };
    localStorage.setItem('ccq_auth', JSON.stringify(authData));
    setAuth(authData);

    if (avatarFile) {
      // Best-effort — the account is already created at this point, so a
      // failed upload here shouldn't block login. They can retry from Profile.
      try {
        const { avatarUrl } = await api.uploadAvatar(avatarFile);
        handleAvatarUpdated(avatarUrl);
      } catch {
        // ignore
      }
    }
  }

  async function logout() {
    try {
      await api.logout();
    } catch {
      // best-effort — clear local state regardless
    }
    localStorage.removeItem('ccq_auth');
    api.setToken(null);
    setAuth(null);
    setProgress(null);
    setDiscoverGroupsList([]);
    setGroupSearchQuery('');
  }

  async function withAuthGuard(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.message === 'Please log in again') logout();
      throw err;
    }
  }

  async function refreshAll() {
    try {
      const [prog, board, discoverRes, groupsRes] = await Promise.all([
        api.getProgress(displayName),
        api.getLeaderboard(),
        api.getDiscover(displayName),
        api.getGroups(displayName),
      ]);
      setProgress(prog);
      setLeaderboard(board);
      setDiscoverFeed(discoverRes);
      setGroups(groupsRes);
    } catch (err) {
      if (err.message === 'User not found') {
        logout();
        return;
      }
      setLoadError(err.message);
    }
  }

  async function refreshDiscover() {
    setDiscoverFeed(await api.getDiscover(displayName));
  }

  async function refreshGroups() {
    setGroups(await api.getGroups(displayName));
  }

  async function refreshGroupFeed(groupId) {
    setGroupFeed(await api.getGroupFeed(groupId));
  }

  useEffect(() => {
    if (displayName) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName]);

  async function refreshVisibleFeeds() {
    const jobs = [refreshDiscover()];
    if (activeGroupId) jobs.push(refreshGroupFeed(activeGroupId));
    await Promise.all(jobs);
  }

  async function handleSubmitPost({ subjectUsername, subjectDisplayName, activityKey, caption, photo, insetPhoto, points, visibility, groupId, isAnonymous }) {
    await withAuthGuard(async () => {
      await api.createPost({ subjectUsername, subjectDisplayName, activityKey, caption, photo, insetPhoto, points, visibility, groupId, isAnonymous });
      await refreshVisibleFeeds();
      const [prog, board] = await Promise.all([api.getProgress(displayName), api.getLeaderboard()]);
      setProgress(prog);
      setLeaderboard(board);
    });
  }

  async function handleReact(postId, emoji) {
    await withAuthGuard(async () => {
      await api.reactToPost(postId, emoji);
      await refreshVisibleFeeds();
    });
  }

  async function handleComment(postId, body) {
    await withAuthGuard(async () => {
      await api.commentOnPost(postId, body);
      await refreshVisibleFeeds();
    });
  }

  async function handleSavePost(postId) {
    await withAuthGuard(async () => {
      await api.savePost(postId);
      await refreshVisibleFeeds();
    });
  }

  async function handleCreditPost(postId, points) {
    await withAuthGuard(async () => {
      await api.creditPost(postId, points);
      await refreshVisibleFeeds();
      const [prog, board] = await Promise.all([api.getProgress(displayName), api.getLeaderboard()]);
      setProgress(prog);
      setLeaderboard(board);
    });
  }

  async function handleSearchUsers(q) {
    return api.searchUsers(displayName, q);
  }

  async function handleCreateActivity(name) {
    return withAuthGuard(() => api.createActivity(name));
  }

  async function handleCreateGroup(name, description, visibility, password) {
    await withAuthGuard(async () => {
      await api.createGroup(name, description, visibility, password);
      await refreshGroups();
    });
  }

  async function handleJoinGroup(groupId, password) {
    await withAuthGuard(async () => {
      await api.joinGroup(groupId, password);
      await refreshGroups();
      await refreshDiscoverGroups(groupSearchQuery);
    });
  }

  async function handleCancelGroupRequest(groupId) {
    await withAuthGuard(async () => {
      await api.cancelGroupRequest(groupId);
      await refreshDiscoverGroups(groupSearchQuery);
    });
  }

  async function handleLeaveGroup(groupId) {
    await withAuthGuard(async () => {
      await api.leaveGroup(groupId);
      await refreshGroups();
      setActiveGroupId(null);
    });
  }

  async function refreshDiscoverGroups(q) {
    setGroupSearchQuery(q);
    setDiscoverGroupsList(await api.discoverGroups(displayName, q));
  }

  async function handleOpenGroup(groupId) {
    setActiveGroupId(groupId);
    await refreshGroupFeed(groupId);
  }

  async function handleReportPost(postId, reason) {
    await withAuthGuard(() => api.reportPost(postId, reason));
  }

  async function refreshBlockedUsers() {
    setBlockedUsers(await api.getBlockedUsers());
  }

  async function handleBlockUser(targetUsername) {
    await withAuthGuard(async () => {
      await api.blockUser(targetUsername);
      await refreshVisibleFeeds();
      await refreshBlockedUsers();
    });
  }

  async function handleUnblockUser(targetUsername) {
    await withAuthGuard(async () => {
      await api.unblockUser(targetUsername);
      await refreshBlockedUsers();
    });
  }

  async function handleDeleteAccount(password) {
    await api.deleteAccount(password);
    localStorage.removeItem('ccq_auth');
    api.setToken(null);
    setAuth(null);
    setProgress(null);
    setDiscoverGroupsList([]);
    setGroupSearchQuery('');
  }

  async function refreshAdminReports() {
    setAdminReports(await api.getAdminReports());
  }

  async function handleResolveReport(reportId, action) {
    await withAuthGuard(async () => {
      await api.resolveReport(reportId, action);
      await refreshAdminReports();
      await refreshVisibleFeeds();
    });
  }

  async function refreshMemories() {
    setMemories(await api.getMemories());
  }

  useEffect(() => {
    if (tab === 'settings') refreshBlockedUsers();
    if ((tab === 'admin' || tab === 'settings') && isAdmin) refreshAdminReports();
    if (tab === 'memories') refreshMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (!displayName) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        onSignupStart={handleSignupStart}
        onSignupResendCode={handleSignupResendCode}
        onSignupVerifyCode={handleSignupVerifyCode}
        onSignupFinish={handleSignupFinish}
      />
    );
  }

  if (!progress) {
    return <div className="loading-screen">{loadError ? `Error: ${loadError}` : 'Loading your quest…'}</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">Catch a Beast</div>
        <div className="app-user">
          {progress.streak.current > 0 && (
            <span className="streak-badge" title={`Longest: ${progress.streak.longest} days`}>
              {progress.streak.current}d
            </span>
          )}
          <span className="app-user-avatar">
            {auth.avatarUrl ? <img src={auth.avatarUrl} alt="" /> : displayName.charAt(0).toUpperCase()}
          </span>
          <span>{displayName}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {progress.streak.atRisk && (
        <div className="streak-risk-banner">
          Your bender ends tonight — post to keep it alive
        </div>
      )}

      <div className="transition-picker">
        {['t-fadeup', 't-crossfade', 't-slideright', 't-scale'].map((t) => (
          <button key={t} type="button" className={transitionStyle === t ? 'active' : ''} onClick={() => setTransitionStyle(t)}>
            {t.replace('t-', '')}
          </button>
        ))}
      </div>
      <div className="transition-picker">
        {['presets', 'hold', 'slider', 'punchy'].map((c) => (
          <button key={c} type="button" className={creditStyle === c ? 'active' : ''} onClick={() => setCreditStyle(c)}>
            {c}
          </button>
        ))}
      </div>

      <main className="app-main">
        <div key={tab === 'groups' ? `groups-${activeGroupId || 'list'}` : tab} className={`app-main-content ${transitionStyle}`}>
        {tab === 'discover' && (
          <DiscoverView
            discoverFeed={discoverFeed}
            myGroups={groups}
            currentUsername={displayName}
            onSubmitPost={handleSubmitPost}
            onReact={handleReact}
            onComment={handleComment}
            onSave={handleSavePost}
            onCredit={handleCreditPost}
            onSearchUsers={handleSearchUsers}
            onCreateActivity={handleCreateActivity}
            onReport={handleReportPost}
            onBlock={handleBlockUser}
            showComposer={showComposer}
            onCloseComposer={() => setShowComposer(false)}
          />
        )}
        {tab === 'groups' && !activeGroupId && (
          <GroupsView
            myGroups={groups}
            discoverGroups={discoverGroupsList}
            onSearchGroups={refreshDiscoverGroups}
            onCreateGroup={handleCreateGroup}
            onJoinGroup={handleJoinGroup}
            onCancelGroupRequest={handleCancelGroupRequest}
            onOpenGroup={handleOpenGroup}
          />
        )}
        {tab === 'groups' && activeGroupId && groups.find((g) => g.id === activeGroupId) && (
          <GroupDetail
            group={groups.find((g) => g.id === activeGroupId)}
            groupFeed={groupFeed}
            currentUsername={displayName}
            onBack={() => setActiveGroupId(null)}
            onLeave={handleLeaveGroup}
            onSubmitPost={handleSubmitPost}
            onReact={handleReact}
            onComment={handleComment}
            onSave={handleSavePost}
            onCredit={handleCreditPost}
            onCreateActivity={handleCreateActivity}
            onReport={handleReportPost}
            onBlock={handleBlockUser}
            onRefreshGroup={refreshGroups}
          />
        )}
        {tab === 'leaderboard' && (
          <>
            <XpBar levelInfo={progress.levelInfo} />
            <PeriodTotals periodTotals={progress.periodTotals} />
            <LeaderboardView leaderboard={leaderboard} currentUsername={displayName} />
          </>
        )}
        {tab === 'profile' && (
          <ProfileView
            displayName={displayName}
            avatarUrl={auth.avatarUrl}
            friendCount={progress.friendCount || 0}
            onOpenFriends={() => setTab('friends')}
            onOpenSettings={() => setTab('settings')}
          />
        )}
        {tab === 'friends' && <FriendsView onBack={() => setTab('profile')} onSearchUsers={handleSearchUsers} />}
        {tab === 'settings' && (
          <SettingsView
            streak={progress.streak}
            badges={progress.badges}
            isAdmin={isAdmin}
            adminReportCount={adminReports.length}
            onOpenAdmin={() => setTab('admin')}
            onOpenMemories={() => setTab('memories')}
            onSearchUsers={handleSearchUsers}
            blockedUsers={blockedUsers}
            onUnblock={handleUnblockUser}
            onDeleteAccount={handleDeleteAccount}
            avatarUrl={auth.avatarUrl}
            onAvatarUpdated={handleAvatarUpdated}
            onBack={() => setTab('profile')}
          />
        )}
        {tab === 'admin' && isAdmin && <AdminView reports={adminReports} onResolve={handleResolveReport} />}
        {tab === 'memories' && <MemoriesView memories={memories} onBack={() => setTab('settings')} />}
        </div>

        <footer className="app-footer">
          Everything here is for laughs. Nothing in this app encourages alcohol use — party-related activities are about the memory, not the drink, and any references are intended for those of legal drinking age only.
        </footer>
      </main>

      <nav className="bottom-nav">
        <button className={`bottom-nav-btn ${tab === 'discover' ? 'active' : ''}`} onClick={() => setTab('discover')}>
          <span className="bottom-nav-icon"><IconHome /></span>
          <span className="bottom-nav-label">Discover</span>
        </button>
        <button className={`bottom-nav-btn ${tab === 'groups' ? 'active' : ''}`} onClick={() => { setTab('groups'); setActiveGroupId(null); }}>
          <span className="bottom-nav-icon"><IconUsers /></span>
          <span className="bottom-nav-label">Groups</span>
        </button>
        <button type="button" className="bottom-nav-camera" onClick={openComposer} aria-label="Post a beast">
          <IconCamera width={24} height={24} />
        </button>
        <button className={`bottom-nav-btn ${tab === 'leaderboard' ? 'active' : ''}`} onClick={() => setTab('leaderboard')}>
          <span className="bottom-nav-icon"><IconTrophy /></span>
          <span className="bottom-nav-label">Ranks</span>
        </button>
        <button className={`bottom-nav-btn ${['profile', 'friends', 'settings'].includes(tab) ? 'active' : ''}`} onClick={() => setTab('profile')}>
          <span className="bottom-nav-icon"><IconUser /></span>
          <span className="bottom-nav-label">Profile</span>
        </button>
      </nav>
    </div>
  );
}
