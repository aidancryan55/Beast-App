import { useEffect, useState } from 'react';
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
          <div className="login-emoji">📬</div>
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
      <div className="login-card">
        <div className="login-emoji">🎓🏆🎉</div>
        <h1>The Beast Game</h1>
        <p className="tagline">Catch your friends being beasts. Earn Beast Points. Become a Beast.</p>
        <div className="auth-toggle">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Log In</button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); }}>Sign Up</button>
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
            <p>📬 Almost there — verify your email first.</p>
            <p className="fineprint">Check your inbox for the confirmation link we sent when you signed up.</p>
          </div>
        )}
        {error && errorCode !== 'unverified' && <p className="error">{error}</p>}
        <p className="fineprint">Your display name is shown publicly on the leaderboard and on posts anyone can see in Discover — your email stays private and is only used to sign in.</p>
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

function CreatePostForm({ myGroups, activities, currentUsername, onSubmit, onClose, onSearchUsers, fixedGroupId }) {
  const [destination, setDestination] = useState(fixedGroupId ? 'group' : 'public');
  const [groupId, setGroupId] = useState(fixedGroupId || myGroups[0]?.id || '');
  const [subjectUsername, setSubjectUsername] = useState('');
  const [subjectQuery, setSubjectQuery] = useState('');
  const [subjectResults, setSubjectResults] = useState([]);
  const [activityKey, setActivityKey] = useState('');
  const [points, setPoints] = useState(20);
  const [caption, setCaption] = useState('');
  const [photo, setPhoto] = useState(null);
  const [preview, setPreview] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const maxPoints = destination === 'group' ? 200 : 50;
  const selectedGroup = myGroups.find((g) => g.id === Number(groupId));
  const groupMembers = (selectedGroup?.members || []).filter((m) => m.toLowerCase() !== currentUsername.toLowerCase());

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
  }

  async function submit(e) {
    e.preventDefault();
    if (!photo) return setError('Add a photo first');
    if (!subjectUsername) return setError(destination === 'group' ? 'Pick who to credit' : 'Search for who to credit');
    if (destination === 'group' && !groupId) return setError('Pick a group');
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({
        subjectUsername,
        activityKey,
        points: Number(points),
        caption,
        photo,
        visibility: destination,
        groupId: destination === 'group' ? groupId : null,
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

        <label className="photo-picker">
          {preview ? <img src={preview} alt="" className="photo-preview" /> : <span>Tap to take/choose a photo</span>}
          <input type="file" accept="image/*" capture="environment" onChange={handlePhoto} hidden />
        </label>

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
              <select value={subjectUsername} onChange={(e) => setSubjectUsername(e.target.value)}>
                <option value="">Pick a member</option>
                {groupMembers.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </>
        ) : (
          <label>
            Who's the beast?
            <input
              type="text"
              placeholder="Search any nickname"
              value={subjectUsername || subjectQuery}
              onChange={(e) => runSubjectSearch(e.target.value)}
            />
            {subjectResults.length > 0 && !subjectUsername && (
              <div className="subject-results">
                {subjectResults.map((name) => (
                  <button type="button" key={name} className="subject-result" onClick={() => { setSubjectUsername(name); setSubjectResults([]); }}>
                    {name}
                  </button>
                ))}
              </div>
            )}
          </label>
        )}

        <label>
          What'd they do? (optional)
          <select value={activityKey} onChange={(e) => setActivityKey(e.target.value)}>
            <option value="">Just vibes</option>
            {activities.map((a) => <option key={a.key} value={a.key}>{a.icon} {a.name}</option>)}
          </select>
        </label>

        <label>
          Beast Points to award (max {maxPoints}{destination === 'public' ? ' — anyone else who sees it can chip in more' : ''})
          <input type="number" min="1" max={maxPoints} value={points} onChange={(e) => setPoints(e.target.value)} />
        </label>

        <label>
          Caption (optional)
          <input type="text" maxLength={140} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="caught him in the wild..." />
        </label>

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

function PostCard({ post, currentUsername, onReact, onSave, onCredit }) {
  const isSubject = post.subjectUsername.toLowerCase() === currentUsername.toLowerCase();
  const hoursLeft = post.saved ? null : Math.max(0, Math.ceil((Date.parse(post.expiresAt) - Date.now()) / 3600000));

  return (
    <div className="post-card">
      <div className="post-header">
        <span className="post-credit-line">
          <strong>{post.creditedByUsername}</strong> caught <strong>{post.subjectUsername}</strong>
          {post.activityName && <> {post.activityIcon} {post.activityName}</>}
          <span className={`post-visibility ${post.visibility}`}>
            {post.visibility === 'group' ? `👥 ${post.groupName}` : '🌎 Public'}
          </span>
        </span>
        <span className="post-points">+{post.points} BP</span>
      </div>
      <img className="post-photo" src={post.photoUrl} alt="" />
      {post.caption && <p className="post-caption">{post.caption}</p>}
      {post.creditorCount > 1 && <p className="post-creditors">{post.creditorCount} people chipped in points</p>}
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
        {!isSubject && <GiveCredit post={post} onCredit={onCredit} />}
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

function PostList({ posts, currentUsername, onReact, onSave, onCredit, emptyText }) {
  if (!posts.length) return <div className="empty-state">{emptyText}</div>;
  return (
    <div className="post-list">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} currentUsername={currentUsername} onReact={onReact} onSave={onSave} onCredit={onCredit} />
      ))}
    </div>
  );
}

function DiscoverView({ discoverFeed, myGroups, activities, currentUsername, onSubmitPost, onReact, onSave, onCredit, onSearchUsers }) {
  const [showForm, setShowForm] = useState(false);
  return (
    <div className="feed-view">
      <button className="credit-friend-btn" onClick={() => setShowForm(true)}>📸 Post publicly</button>
      {showForm && (
        <CreatePostForm
          myGroups={myGroups}
          activities={activities}
          currentUsername={currentUsername}
          onSubmit={onSubmitPost}
          onClose={() => setShowForm(false)}
          onSearchUsers={onSearchUsers}
        />
      )}
      <PostList
        posts={discoverFeed}
        currentUsername={currentUsername}
        onReact={onReact}
        onSave={onSave}
        onCredit={onCredit}
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

function GroupDetail({ group, groupFeed, activities, currentUsername, onBack, onLeave, onSubmitPost, onReact, onSave, onCredit }) {
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
          activities={activities}
          currentUsername={currentUsername}
          onSubmit={onSubmitPost}
          onClose={() => setShowForm(false)}
        />
      )}

      <PostList
        posts={groupFeed}
        currentUsername={currentUsername}
        onReact={onReact}
        onSave={onSave}
        onCredit={onCredit}
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
  const [activities, setActivities] = useState([]);
  const [progress, setProgress] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [discoverFeed, setDiscoverFeed] = useState([]);
  const [groups, setGroups] = useState([]);
  const [discoverGroupsList, setDiscoverGroupsList] = useState([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(null);
  const [groupFeed, setGroupFeed] = useState([]);
  const [tab, setTab] = useState('discover');
  const [loadError, setLoadError] = useState('');

  async function handleLogin(email, password) {
    const result = await api.login(email, password);
    api.setToken(result.token);
    const authData = { displayName: result.displayName, token: result.token };
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
      const [acts, prog, board, discoverRes, groupsRes] = await Promise.all([
        api.getActivities(),
        api.getProgress(displayName),
        api.getLeaderboard(),
        api.getDiscover(displayName),
        api.getGroups(displayName),
      ]);
      setActivities(acts);
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

  async function handleSubmitPost({ subjectUsername, activityKey, points, caption, photo, visibility, groupId }) {
    await withAuthGuard(async () => {
      await api.createPost({ subjectUsername, activityKey, points, caption, photo, visibility, groupId });
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
          <span>{displayName}</span>
          <button className="logout-btn" onClick={logout}>Log out</button>
        </div>
      </header>

      <XpBar levelInfo={progress.levelInfo} />
      <PeriodTotals periodTotals={progress.periodTotals} />

      <nav className="tabs">
        <button className={tab === 'discover' ? 'active' : ''} onClick={() => setTab('discover')}>Discover</button>
        <button className={tab === 'groups' ? 'active' : ''} onClick={() => { setTab('groups'); setActiveGroupId(null); }}>Groups</button>
        <button className={tab === 'badges' ? 'active' : ''} onClick={() => setTab('badges')}>
          Badges {progress.badges.length ? `(${progress.badges.length})` : ''}
        </button>
        <button className={tab === 'leaderboard' ? 'active' : ''} onClick={() => setTab('leaderboard')}>Leaderboard</button>
      </nav>

      <main className="app-main">
        {tab === 'discover' && (
          <DiscoverView
            discoverFeed={discoverFeed}
            myGroups={groups}
            activities={activities}
            currentUsername={displayName}
            onSubmitPost={handleSubmitPost}
            onReact={handleReact}
            onSave={handleSavePost}
            onCredit={handleCreditPost}
            onSearchUsers={handleSearchUsers}
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
            activities={activities}
            currentUsername={displayName}
            onBack={() => setActiveGroupId(null)}
            onLeave={handleLeaveGroup}
            onSubmitPost={handleSubmitPost}
            onReact={handleReact}
            onSave={handleSavePost}
            onCredit={handleCreditPost}
          />
        )}
        {tab === 'badges' && <BadgesView badges={progress.badges} />}
        {tab === 'leaderboard' && <LeaderboardView leaderboard={leaderboard} currentUsername={displayName} />}
      </main>

      <footer className="app-footer">
        Everything here is for laughs. Nothing in this app encourages alcohol use — party-related activities are about the memory, not the drink, and any references are intended for those of legal drinking age only.
      </footer>
    </div>
  );
}
