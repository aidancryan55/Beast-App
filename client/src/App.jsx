import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import './App.css';

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

function LoginScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onAuth(mode, name.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-emoji">🎓🏆🎉</div>
        <h1>The Beast Game</h1>
        <p className="tagline">Live the cliché. Earn Beast Points. Become a Beast.</p>
        <div className="auth-toggle">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log In</button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Sign Up</button>
        </div>
        <form onSubmit={submit}>
          <input
            autoFocus
            placeholder="Nickname"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={loading || name.trim().length < 2 || password.length < 6}>
            {loading ? 'Loading…' : mode === 'login' ? 'Log In' : 'Create Account'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="fineprint">Your progress shows up on the public leaderboard, so don't use your real name if you'd rather stay anonymous.</p>
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

function RarityBadge({ rarity }) {
  return <span className={`rarity rarity-${rarity}`}>{rarity}</span>;
}

function FrequencyBadge({ repeatable }) {
  if (!repeatable) return null;
  return <span className={`frequency frequency-${repeatable}`}>{repeatable}</span>;
}

function StreakBadge({ streak }) {
  if (!streak) return null;
  return <span className="streak-pill">🔥 {streak}</span>;
}

function ActivityCard({ activity, completed, streak, onToggle }) {
  return (
    <button
      className={`activity-card ${completed ? 'completed' : ''}`}
      onClick={() => onToggle(activity.key)}
    >
      <span className="activity-icon">{activity.icon}</span>
      <span className="activity-body">
        <span className="activity-name">{activity.name}</span>
        <span className="activity-meta">
          <RarityBadge rarity={activity.rarity} />
          <FrequencyBadge repeatable={activity.repeatable} />
          <span className="activity-xp">+{activity.xp} BP</span>
          <StreakBadge streak={streak} />
        </span>
      </span>
      <span className="activity-check">{completed ? '✓' : ''}</span>
    </button>
  );
}

function QuickLogBar({ activities, currentPeriodKeys, streaks, onToggle }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const completedSet = new Set(currentPeriodKeys);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return activities
      .filter((a) => a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 6);
  }, [query, activities]);

  function logAndClear(activityKey) {
    onToggle(activityKey);
    setQuery('');
    inputRef.current?.focus();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && matches.length > 0) {
      logAndClear(matches[0].key);
    }
    if (e.key === 'Escape') {
      setQuery('');
    }
  }

  return (
    <div className="quick-log">
      <input
        ref={inputRef}
        className="quick-log-input"
        type="text"
        inputMode="search"
        placeholder="🔍 Type it, tap it, done — e.g. tailgate"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {matches.length > 0 && (
        <div className="quick-log-results">
          {matches.map((a) => {
            const completed = completedSet.has(a.key);
            const streak = streaks?.[a.key];
            return (
              <button
                key={a.key}
                className={`quick-log-result ${completed ? 'completed' : ''}`}
                onClick={() => logAndClear(a.key)}
              >
                <span className="activity-icon">{a.icon}</span>
                <span className="activity-name">{a.name}</span>
                {streak > 0 && <span className="streak-pill">🔥 {streak}</span>}
                <span className="activity-xp">+{a.xp} BP</span>
                <span className="activity-check">{completed ? '✓' : ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivitiesView({ activities, currentPeriodKeys, streaks, onToggle, completedByCategory }) {
  const byCategory = useMemo(() => {
    const map = {};
    for (const a of activities) {
      if (!map[a.category]) map[a.category] = [];
      map[a.category].push(a);
    }
    for (const cat of Object.keys(map)) {
      map[cat].sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
    }
    return map;
  }, [activities]);

  const completedSet = new Set(currentPeriodKeys);

  return (
    <div className="activities-view">
      <QuickLogBar activities={activities} currentPeriodKeys={currentPeriodKeys} streaks={streaks} onToggle={onToggle} />
      {Object.entries(byCategory).map(([category, items]) => {
        const prog = completedByCategory?.[category];
        return (
          <section key={category} className="category-section">
            <div className="category-header">
              <h2>{category}</h2>
              {prog && (
                <span className={`category-progress ${prog.complete ? 'done' : ''}`}>
                  {prog.done}/{prog.total} {prog.complete ? '✓' : ''}
                </span>
              )}
            </div>
            <div className="activity-grid">
              {items.map((a) => (
                <ActivityCard
                  key={a.key}
                  activity={a}
                  completed={completedSet.has(a.key)}
                  streak={streaks?.[a.key]}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StreaksStrip({ streaks, activities }) {
  const entries = Object.entries(streaks || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  const byKey = Object.fromEntries(activities.map((a) => [a.key, a]));
  return (
    <div className="streaks-strip">
      {entries.map(([key, count]) => {
        const a = byKey[key];
        if (!a) return null;
        const unit = a.repeatable === 'daily' ? 'day' : 'week';
        return (
          <span key={key} className="streak-chip">
            🔥 {count} {unit}{count === 1 ? '' : 's'} · {a.name}
          </span>
        );
      })}
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

function FriendsView({ friendsData, onSearch, onRequest, onRespond, onRemove }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);

  async function runSearch(q) {
    setQuery(q);
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    setResults(await onSearch(q.trim()));
  }

  const { friends = [], incomingRequests = [], outgoingRequests = [] } = friendsData || {};
  const pendingSet = new Set([...friends, ...incomingRequests, ...outgoingRequests]);

  return (
    <div className="friends-view">
      <div className="friend-search">
        <input
          placeholder="Search by nickname to add a friend"
          value={query}
          onChange={(e) => runSearch(e.target.value)}
        />
        {results.length > 0 && (
          <div className="friend-search-results">
            {results.map((name) => (
              <div key={name} className="friend-row">
                <span>{name}</span>
                {pendingSet.has(name) ? (
                  <span className="friend-status">pending / friends</span>
                ) : (
                  <button className="friend-action" onClick={() => onRequest(name)}>Add</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {incomingRequests.length > 0 && (
        <section className="friend-section">
          <h2>Requests</h2>
          {incomingRequests.map((name) => (
            <div key={name} className="friend-row">
              <span>{name}</span>
              <div className="friend-row-actions">
                <button className="friend-action accept" onClick={() => onRespond(name, true)}>Accept</button>
                <button className="friend-action decline" onClick={() => onRespond(name, false)}>Decline</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {outgoingRequests.length > 0 && (
        <section className="friend-section">
          <h2>Sent</h2>
          {outgoingRequests.map((name) => (
            <div key={name} className="friend-row">
              <span>{name}</span>
              <span className="friend-status">pending</span>
            </div>
          ))}
        </section>
      )}

      <section className="friend-section">
        <h2>Friends ({friends.length})</h2>
        {friends.length === 0 && <div className="empty-state">No friends yet — search above to add some.</div>}
        {friends.map((name) => (
          <div key={name} className="friend-row">
            <span>{name}</span>
            <button className="friend-action remove" onClick={() => onRemove(name)}>Remove</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function CreditFriendForm({ friends, activities, onSubmit, onClose }) {
  const [subjectUsername, setSubjectUsername] = useState(friends[0] || '');
  const [activityKey, setActivityKey] = useState('');
  const [points, setPoints] = useState(20);
  const [caption, setCaption] = useState('');
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhoto(file);
    setPreview(URL.createObjectURL(file));
  }

  async function submit(e) {
    e.preventDefault();
    if (!photo) {
      setError('Add a photo first');
      return;
    }
    if (!subjectUsername) {
      setError('Pick a friend to credit');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({ subjectUsername, activityKey, points: Number(points), caption, photo });
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
        <h2>📸 Credit a friend</h2>

        <label className="photo-picker">
          {preview ? <img src={preview} alt="" className="photo-preview" /> : <span>Tap to take/choose a photo</span>}
          <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden />
        </label>

        <label>
          Who's the beast?
          <select value={subjectUsername} onChange={(e) => setSubjectUsername(e.target.value)}>
            {friends.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>

        <label>
          What'd they do? (optional)
          <select value={activityKey} onChange={(e) => setActivityKey(e.target.value)}>
            <option value="">Just vibes</option>
            {activities.map((a) => <option key={a.key} value={a.key}>{a.icon} {a.name}</option>)}
          </select>
        </label>

        <label>
          Beast Points to award
          <input type="number" min="1" max="200" value={points} onChange={(e) => setPoints(e.target.value)} />
        </label>

        <label>
          Caption (optional)
          <input type="text" maxLength={140} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="caught him in the wild..." />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="credit-modal-actions">
          <button type="button" className="secondary-btn" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={submitting}>{submitting ? 'Posting…' : 'Award points'}</button>
        </div>
      </form>
    </div>
  );
}

const REACTION_EMOJIS = ['🔥', '😂', '💀', '👑', '🐐'];

function PostCard({ post, currentUsername, onReact, onSave }) {
  const isSubject = post.subjectUsername.toLowerCase() === currentUsername.toLowerCase();
  const hoursLeft = post.saved ? null : Math.max(0, Math.ceil((Date.parse(post.expiresAt) - Date.now()) / 3600000));

  return (
    <div className="post-card">
      <div className="post-header">
        <span className="post-credit-line">
          <strong>{post.creditedByUsername}</strong> caught <strong>{post.subjectUsername}</strong>
          {post.activityName && <> {post.activityIcon} {post.activityName}</>}
        </span>
        <span className="post-points">+{post.points} BP</span>
      </div>
      <img className="post-photo" src={post.photoUrl} alt="" />
      {post.caption && <p className="post-caption">{post.caption}</p>}
      <div className="post-footer">
        <div className="post-reactions">
          {REACTION_EMOJIS.map((emoji) => {
            const count = post.reactions.find((r) => r.emoji === emoji)?.count || 0;
            const mine = post.myReaction === emoji;
            return (
              <button
                key={emoji}
                className={`reaction-btn ${mine ? 'mine' : ''}`}
                onClick={() => onReact(post.id, emoji)}
              >
                {emoji} {count > 0 ? count : ''}
              </button>
            );
          })}
        </div>
        <div className="post-meta">
          {post.saved ? <span className="post-saved">💾 saved</span> : <span className="post-expiry">expires in {hoursLeft}h</span>}
          {isSubject && (
            <button className="save-btn" onClick={() => onSave(post.id)}>
              {post.saved ? 'Unsave' : 'Keep forever'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FeedView({ feed, friends, activities, currentUsername, onSubmitPost, onReact, onSave }) {
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="feed-view">
      <button className="credit-friend-btn" onClick={() => setShowForm(true)} disabled={friends.length === 0}>
        📸 Credit a friend
      </button>
      {friends.length === 0 && <p className="empty-state">Add friends first to start crediting each other.</p>}

      {showForm && (
        <CreditFriendForm
          friends={friends}
          activities={activities}
          onSubmit={onSubmitPost}
          onClose={() => setShowForm(false)}
        />
      )}

      {feed.length === 0 ? (
        <div className="empty-state">No posts yet — be the first to catch a friend doing something beastly.</div>
      ) : (
        <div className="post-list">
          {feed.map((post) => (
            <PostCard key={post.id} post={post} currentUsername={currentUsername} onReact={onReact} onSave={onSave} />
          ))}
        </div>
      )}
    </div>
  );
}

function BadgesView({ badges }) {
  if (!badges.length) {
    return <div className="empty-state">No badges yet — go complete some cliches to earn your first one.</div>;
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
            <th>Activities</th>
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
              <td>{row.activitiesCompleted}</td>
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
  const username = auth?.username || '';
  const [activities, setActivities] = useState([]);
  const [progress, setProgress] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [friendsData, setFriendsData] = useState(null);
  const [feed, setFeed] = useState([]);
  const [tab, setTab] = useState('activities');
  const [loadError, setLoadError] = useState('');

  async function handleAuth(mode, name, password) {
    const result = mode === 'signup' ? await api.signup(name, password) : await api.login(name, password);
    api.setToken(result.token);
    const authData = { username: result.username, token: result.token };
    localStorage.setItem('ccq_auth', JSON.stringify(authData));
    setAuth(authData);
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
      const [acts, prog, board, friendsRes, feedRes] = await Promise.all([
        api.getActivities(),
        api.getProgress(username),
        api.getLeaderboard(),
        api.getFriends(username),
        api.getFeed(username),
      ]);
      setActivities(acts);
      setProgress(prog);
      setLeaderboard(board);
      setFriendsData(friendsRes);
      setFeed(feedRes);
    } catch (err) {
      if (err.message === 'User not found') {
        logout();
        return;
      }
      setLoadError(err.message);
    }
  }

  async function refreshFriends() {
    setFriendsData(await api.getFriends(username));
  }

  async function refreshFeed() {
    setFeed(await api.getFeed(username));
  }

  useEffect(() => {
    if (username) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  async function handleToggle(activityKey) {
    await withAuthGuard(async () => {
      const updated = await api.toggleActivity(username, activityKey);
      setProgress(updated);
      const board = await api.getLeaderboard();
      setLeaderboard(board);
    });
  }

  async function handleFriendSearch(q) {
    return api.searchUsers(username, q);
  }

  async function handleFriendRequest(targetUsername) {
    await withAuthGuard(async () => {
      await api.sendFriendRequest(username, targetUsername);
      await refreshFriends();
    });
  }

  async function handleFriendRespond(requesterUsername, accept) {
    await withAuthGuard(async () => {
      await api.respondFriendRequest(username, requesterUsername, accept);
      await refreshFriends();
      await refreshFeed();
    });
  }

  async function handleFriendRemove(targetUsername) {
    await withAuthGuard(async () => {
      await api.removeFriend(username, targetUsername);
      await refreshFriends();
      await refreshFeed();
    });
  }

  async function handleSubmitPost({ subjectUsername, activityKey, points, caption, photo }) {
    await withAuthGuard(async () => {
      await api.createPost({ subjectUsername, activityKey, points, caption, photo });
      await refreshFeed();
      const [prog, board] = await Promise.all([api.getProgress(username), api.getLeaderboard()]);
      setProgress(prog);
      setLeaderboard(board);
    });
  }

  async function handleReact(postId, emoji) {
    await withAuthGuard(async () => {
      await api.reactToPost(postId, emoji);
      await refreshFeed();
    });
  }

  async function handleSavePost(postId) {
    await withAuthGuard(async () => {
      await api.savePost(postId);
      await refreshFeed();
    });
  }

  if (!username) {
    return <LoginScreen onAuth={handleAuth} />;
  }

  if (!progress) {
    return <div className="loading-screen">{loadError ? `Error: ${loadError}` : 'Loading your quest…'}</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">🎓 The Beast Game</div>
        <div className="app-user">
          <span>{username}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      <XpBar levelInfo={progress.levelInfo} />
      <PeriodTotals periodTotals={progress.periodTotals} />
      <StreaksStrip streaks={progress.streaks} activities={activities} />

      <nav className="tabs">
        <button className={tab === 'activities' ? 'active' : ''} onClick={() => setTab('activities')}>Activities</button>
        <button className={tab === 'feed' ? 'active' : ''} onClick={() => setTab('feed')}>Feed</button>
        <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
          Friends {friendsData?.incomingRequests?.length ? `(${friendsData.incomingRequests.length})` : ''}
        </button>
        <button className={tab === 'badges' ? 'active' : ''} onClick={() => setTab('badges')}>
          Badges {progress.badges.length ? `(${progress.badges.length})` : ''}
        </button>
        <button className={tab === 'leaderboard' ? 'active' : ''} onClick={() => setTab('leaderboard')}>Leaderboard</button>
      </nav>

      <main className="app-main">
        {tab === 'activities' && (
          <ActivitiesView
            activities={activities}
            currentPeriodKeys={progress.currentPeriodKeys}
            streaks={progress.streaks}
            completedByCategory={progress.completedByCategory}
            onToggle={handleToggle}
          />
        )}
        {tab === 'feed' && (
          <FeedView
            feed={feed}
            friends={friendsData?.friends || []}
            activities={activities}
            currentUsername={username}
            onSubmitPost={handleSubmitPost}
            onReact={handleReact}
            onSave={handleSavePost}
          />
        )}
        {tab === 'friends' && (
          <FriendsView
            friendsData={friendsData}
            onSearch={handleFriendSearch}
            onRequest={handleFriendRequest}
            onRespond={handleFriendRespond}
            onRemove={handleFriendRemove}
          />
        )}
        {tab === 'badges' && <BadgesView badges={progress.badges} />}
        {tab === 'leaderboard' && <LeaderboardView leaderboard={leaderboard} currentUsername={username} />}
      </main>

      <footer className="app-footer">
        Everything here is for laughs. Nothing in this app encourages alcohol use — party-related activities are about the memory, not the drink, and any references are intended for those of legal drinking age only.
      </footer>
    </div>
  );
}
