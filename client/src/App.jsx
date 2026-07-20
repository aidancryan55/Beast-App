import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import './App.css';

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

function LoginScreen({ onLogin }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onLogin(name.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-emoji">🎓🍺🎉</div>
        <h1>College Cliché Quest</h1>
        <p className="tagline">Live the cliché. Earn Beast Points. Become a Beast.</p>
        <form onSubmit={submit}>
          <input
            autoFocus
            placeholder="Pick a nickname"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={loading || name.trim().length < 2}>
            {loading ? 'Loading…' : 'Start Questing'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="fineprint">No password needed — just a nickname. Your progress shows up on the public leaderboard, so don't use your real name if you'd rather stay anonymous.</p>
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
          : 'Max level reached — you are a certified Beast'}
      </div>
    </div>
  );
}

function RarityBadge({ rarity }) {
  return <span className={`rarity rarity-${rarity}`}>{rarity}</span>;
}

function ActivityCard({ activity, completed, onToggle }) {
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
          <span className="activity-xp">+{activity.xp} BP</span>
        </span>
      </span>
      <span className="activity-check">{completed ? '✓' : ''}</span>
    </button>
  );
}

function QuickLogBar({ activities, completedKeys, onToggle }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const completedSet = new Set(completedKeys);

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
        placeholder="🔍 Type it, tap it, done — e.g. beer"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {matches.length > 0 && (
        <div className="quick-log-results">
          {matches.map((a) => {
            const completed = completedSet.has(a.key);
            return (
              <button
                key={a.key}
                className={`quick-log-result ${completed ? 'completed' : ''}`}
                onClick={() => logAndClear(a.key)}
              >
                <span className="activity-icon">{a.icon}</span>
                <span className="activity-name">{a.name}</span>
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

function ActivitiesView({ activities, completedKeys, onToggle, completedByCategory }) {
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

  const completedSet = new Set(completedKeys);

  return (
    <div className="activities-view">
      <QuickLogBar activities={activities} completedKeys={completedKeys} onToggle={onToggle} />
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

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('ccq_username') || '');
  const [activities, setActivities] = useState([]);
  const [progress, setProgress] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [tab, setTab] = useState('activities');
  const [loadError, setLoadError] = useState('');

  async function login(name) {
    const user = await api.createOrGetUser(name);
    localStorage.setItem('ccq_username', user.username);
    setUsername(user.username);
  }

  function logout() {
    localStorage.removeItem('ccq_username');
    setUsername('');
    setProgress(null);
  }

  async function refreshAll() {
    try {
      const [acts, prog, board] = await Promise.all([
        api.getActivities(),
        api.getProgress(username),
        api.getLeaderboard(),
      ]);
      setActivities(acts);
      setProgress(prog);
      setLeaderboard(board);
    } catch (err) {
      if (err.message === 'User not found') {
        logout();
        return;
      }
      setLoadError(err.message);
    }
  }

  useEffect(() => {
    if (username) refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  async function handleToggle(activityKey) {
    const updated = await api.toggleActivity(username, activityKey);
    setProgress(updated);
    const board = await api.getLeaderboard();
    setLeaderboard(board);
  }

  if (!username) {
    return <LoginScreen onLogin={login} />;
  }

  if (!progress) {
    return <div className="loading-screen">{loadError ? `Error: ${loadError}` : 'Loading your quest…'}</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">🎓 College Cliché Quest</div>
        <div className="app-user">
          <span>{username}</span>
          <button className="logout-btn" onClick={logout}>Switch player</button>
        </div>
      </header>

      <XpBar levelInfo={progress.levelInfo} />

      <nav className="tabs">
        <button className={tab === 'activities' ? 'active' : ''} onClick={() => setTab('activities')}>Activities</button>
        <button className={tab === 'badges' ? 'active' : ''} onClick={() => setTab('badges')}>
          Badges {progress.badges.length ? `(${progress.badges.length})` : ''}
        </button>
        <button className={tab === 'leaderboard' ? 'active' : ''} onClick={() => setTab('leaderboard')}>Leaderboard</button>
      </nav>

      <main className="app-main">
        {tab === 'activities' && (
          <ActivitiesView
            activities={activities}
            completedKeys={progress.completedKeys}
            completedByCategory={progress.completedByCategory}
            onToggle={handleToggle}
          />
        )}
        {tab === 'badges' && <BadgesView badges={progress.badges} />}
        {tab === 'leaderboard' && <LeaderboardView leaderboard={leaderboard} currentUsername={username} />}
      </main>

      <footer className="app-footer">
        Play responsibly. Everything here is for laughs — actual drinking activities are only for those of legal age.
      </footer>
    </div>
  );
}
