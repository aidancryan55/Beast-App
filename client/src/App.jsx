import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import './App.css';

function LoginScreen({ onLogin, onSignup }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setErrorCode('');
    setLoading(true);
    try {
      if (mode === 'signup') {
        await onSignup(email.trim(), password, displayName.trim());
        setCheckEmail(email.trim());
      } else {
        await onLogin(email.trim(), password);
      }
    } catch (err) {
      setError(err.message);
      setErrorCode(err.code || '');
    } finally {
      setLoading(false);
    }
  }

  if (checkEmail) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <h1>Check your email</h1>
          <p className="tagline">We sent a confirmation link to <strong>{checkEmail}</strong>. Tap it to verify your account, then come back and log in.</p>
          <button type="button" onClick={() => { setCheckEmail(''); setMode('login'); }}>Back to log in</button>
        </div>
      </div>
    );
  }

  const canSubmit = mode === 'login'
    ? email.trim().length > 2 && password.length >= 8
    : email.trim().length > 2 && password.length >= 8 && displayName.trim().length > 0;

  return (
    <div className="login-screen">
      <div className="login-hero">
        <div className="login-wordmark">THE BEAST GAME</div>
        <h1 className="login-headline">Catch your friends<br />being beasts.</h1>
        <p className="login-subtext">Earn Beast Points. Become a Beast.</p>
      </div>

      <div className="login-card">
        <div className="auth-toggle">
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); }}>Create Account</button>
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Log In</button>
        </div>
        <form onSubmit={submit}>
          <input
            autoFocus
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {mode === 'signup' && (
            <input
              placeholder="Display name (shown publicly)"
              value={displayName}
              maxLength={30}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
          <input
            placeholder="Password (min 8 characters)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={loading || !canSubmit}>
            {loading ? 'Loading…' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>
        {error && errorCode === 'unverified' && (
          <div className="unverified-block">
            <p>Almost there — verify your email first.</p>
            <p className="fineprint">Check your inbox for the confirmation link we sent when you signed up.</p>
          </div>
        )}
        {error && errorCode !== 'unverified' && <p className="error">{error}</p>}
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

  async function pickRandomBeast() {
    if (destination === 'group') {
      if (!groupMembers.length) return;
      const pick = groupMembers[Math.floor(Math.random() * groupMembers.length)];
      setSubjectUsername(pick);
      return;
    }
    setError('');
    try {
      const { username } = await api.getRandomBeast();
      setSubjectUsername(username);
      setSubjectQuery('');
      setSubjectResults([]);
    } catch (err) {
      setError(err.message);
    }
  }

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
        <h2>📸 Catch a Beast</h2>

        {!fixedGroupId && (
          <div className="destination-toggle">
            <button type="button" className={destination === 'public' ? 'active' : ''} onClick={() => setDestination('public')}>🌎 Post publicly</button>
            <button type="button" className={destination === 'group' ? 'active' : ''} onClick={() => setDestination('group')} disabled={!myGroups.length}>👥 Post to a group</button>
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
            <button type="button" className="dual-capture-btn" onClick={() => setDualCaptureOpen(true)}>📸📸 Dual Capture</button>
            <label className="photo-picker-fallback">
              🖼️ Or choose a single photo
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
                  {groupMembers.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button type="button" className="random-beast-btn" onClick={pickRandomBeast} disabled={!groupMembers.length}>🎲 Random</button>
              </div>
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
              <button type="button" className="random-beast-btn" onClick={pickRandomBeast}>🎲 Random</button>
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
              🕵️ I don't know if they have the app
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
            🕵️ Post anonymously — hide that it was you who posted this
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

function GiveCredit({ post, onCredit }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(post.myCredit || Math.min(10, post.maxCredit));
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await onCredit(post.id, Number(amount));
      setOpen(false);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!open) {
    return (
      <button type="button" className="give-credit-btn" onClick={() => setOpen(true)}>
        {post.myCredit ? `🎁 You gave ${post.myCredit} BP` : '🎁 Give points'}
      </button>
    );
  }
  return (
    <form className="give-credit-form" onSubmit={submit}>
      <input type="number" min="1" max={post.maxCredit} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      <button type="submit">Give</button>
      <button type="button" className="secondary-btn" onClick={() => setOpen(false)}>×</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
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
    return <button type="button" className="flag-btn" onClick={() => setOpen(true)}>⚠️ Report</button>;
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
        <div className={`post-avatar ${post.isAnonymous ? 'anon' : ''}`}>{posterInitial}</div>
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
                🚫 Block {post.creditedByUsername}
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await onCreate(name.trim(), description.trim());
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
        <h2>👥 Create a group</h2>
        <label>
          Group name
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sig Ep Squad" autoFocus />
        </label>
        <label>
          Description (optional)
          <input value={description} maxLength={140} onChange={(e) => setDescription(e.target.value)} placeholder="What's this group about?" />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="credit-modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={submitting || name.trim().length < 1}>{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  );
}

function GroupDetail({ group, groupFeed, currentUsername, onBack, onLeave, onSubmitPost, onReact, onComment, onSave, onCredit, onCreateActivity, onReport, onBlock }) {
  const [showForm, setShowForm] = useState(false);
  return (
    <div className="group-detail">
      <button className="back-btn" onClick={onBack}>← All groups</button>
      <div className="group-detail-header">
        <h2>{group.name}</h2>
        {group.description && <p className="group-description">{group.description}</p>}
        <p className="group-member-count">{group.memberCount}/{group.maxMembers} members</p>
        <div className="group-members-list">{group.members.join(', ')}</div>
        <button className="friend-action remove" onClick={() => onLeave(group.id)}>Leave group</button>
      </div>

      <button className="credit-friend-btn" onClick={() => setShowForm(true)}>📸 Post to {group.name}</button>
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

function GroupsView({ myGroups, discoverGroups, onSearchGroups, onCreateGroup, onJoinGroup, onOpenGroup }) {
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
            <span className="group-row-name">{g.name}</span>
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
          <div key={g.id} className="friend-row">
            <span>{g.name} <span className="friend-status">{g.memberCount}/{g.maxMembers}</span></span>
            <button className="friend-action" onClick={() => onJoinGroup(g.id)} disabled={g.memberCount >= g.maxMembers}>
              {g.memberCount >= g.maxMembers ? 'Full' : 'Join'}
            </button>
          </div>
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
              <td>{row.username}</td>
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
              <span>{d.issuerUsername} dared you: "{d.description}" — 🎁 {d.wagerPoints} BP if you do it</span>
            </div>
          ))}
        </div>
      )}

      {issuedByMe.length > 0 && (
        <div className="dares-list">
          <h3 className="dares-sublabel">Dares you've issued</h3>
          {issuedByMe.map((d) => (
            <div key={d.id} className="friend-row">
              <span>{d.targetUsername}: "{d.description}" — 🎁 {d.wagerPoints} BP <span className="friend-status">{d.status}</span></span>
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

function SettingsView({ streak, badges, isAdmin, adminReportCount, onOpenAdmin, onOpenMemories, onSearchUsers, blockedUsers, onUnblock, onDeleteAccount }) {
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
      <section className="friend-section">
        <h2>Beast Streak</h2>
        <div className="streak-summary">
          <span className="streak-summary-current">🔥 {streak.current} day{streak.current === 1 ? '' : 's'}</span>
          <span className="fineprint">Longest: {streak.longest} day{streak.longest === 1 ? '' : 's'}</span>
        </div>
        {streak.atRisk && <p className="fineprint">Your bender ends tonight if you don't post today.</p>}
      </section>

      <section className="friend-section">
        <h2>Memories</h2>
        <p className="fineprint">A private history of every beast you've photographed, past the normal 24h.</p>
        <button type="button" className="friend-action" onClick={onOpenMemories}>📅 Open Memories</button>
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
            🛡️ Open moderation queue {adminReportCount ? `(${adminReportCount})` : ''}
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
  if (!reports.length) return <div className="empty-state">No pending reports. 🎉</div>;
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
  const [loadError, setLoadError] = useState('');

  function openComposer() {
    setTab('discover');
    setActiveGroupId(null);
    setShowComposer(true);
  }

  async function handleLogin(email, password) {
    const result = await api.login(email, password);
    api.setToken(result.token);
    const authData = { displayName: result.displayName, token: result.token, isAdmin: !!result.isAdmin };
    localStorage.setItem('ccq_auth', JSON.stringify(authData));
    setAuth(authData);
  }

  async function handleSignup(email, password, name) {
    await api.signup(email, password, name);
    // Unverified — no session yet. LoginScreen shows a "check your email" state.
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

  async function handleCreateGroup(name, description) {
    await withAuthGuard(async () => {
      await api.createGroup(name, description);
      await refreshGroups();
    });
  }

  async function handleJoinGroup(groupId) {
    await withAuthGuard(async () => {
      await api.joinGroup(groupId);
      await refreshGroups();
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
    return <LoginScreen onLogin={handleLogin} onSignup={handleSignup} />;
  }

  if (!progress) {
    return <div className="loading-screen">{loadError ? `Error: ${loadError}` : 'Loading your quest…'}</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">🎓 The Beast Game</div>
        <div className="app-user">
          {progress.streak.current > 0 && (
            <span className="streak-badge" title={`Longest: ${progress.streak.longest} days`}>
              🔥 {progress.streak.current}
            </span>
          )}
          <span>{displayName}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      {progress.streak.atRisk && (
        <div className="streak-risk-banner">
          🔥 Your bender ends tonight — post to keep it alive
        </div>
      )}

      <XpBar levelInfo={progress.levelInfo} />
      <PeriodTotals periodTotals={progress.periodTotals} />

      <main className="app-main">
        <div key={tab === 'groups' ? `groups-${activeGroupId || 'list'}` : tab} className="app-main-content">
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
          />
        )}
        {tab === 'leaderboard' && <LeaderboardView leaderboard={leaderboard} currentUsername={displayName} />}
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
          />
        )}
        {tab === 'admin' && isAdmin && <AdminView reports={adminReports} onResolve={handleResolveReport} />}
        {tab === 'memories' && <MemoriesView memories={memories} onBack={() => setTab('settings')} />}
        </div>
      </main>

      <footer className="app-footer">
        Everything here is for laughs. Nothing in this app encourages alcohol use — party-related activities are about the memory, not the drink, and any references are intended for those of legal drinking age only.
      </footer>

      <nav className="bottom-nav">
        <button className={`bottom-nav-btn ${tab === 'discover' ? 'active' : ''}`} onClick={() => setTab('discover')}>
          <span className="bottom-nav-icon">🔴</span>
          <span className="bottom-nav-label">BLF</span>
        </button>
        <button className={`bottom-nav-btn ${tab === 'groups' ? 'active' : ''}`} onClick={() => { setTab('groups'); setActiveGroupId(null); }}>
          <span className="bottom-nav-icon">👥</span>
          <span className="bottom-nav-label">Groups</span>
        </button>
        <button type="button" className="bottom-nav-camera" onClick={openComposer} aria-label="Post a beast">
          📸
        </button>
        <button className={`bottom-nav-btn ${tab === 'leaderboard' ? 'active' : ''}`} onClick={() => setTab('leaderboard')}>
          <span className="bottom-nav-icon">🏆</span>
          <span className="bottom-nav-label">Ranks</span>
        </button>
        <button className={`bottom-nav-btn ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          <span className="bottom-nav-icon">⚙️</span>
          <span className="bottom-nav-label">Profile</span>
        </button>
      </nav>
    </div>
  );
}
