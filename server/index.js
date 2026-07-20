const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { LEVELS } = require('./activities');

const app = express();
app.use(cors());
app.use(express.json());

const USERNAME_RE = /^[a-zA-Z0-9_ ]{2,20}$/;

function levelForXp(xp) {
  let current = LEVELS[0];
  for (const lvl of LEVELS) {
    if (xp >= lvl.minXp) current = lvl;
  }
  const idx = LEVELS.indexOf(current);
  const next = LEVELS[idx + 1] || null;
  return {
    level: current.level,
    title: current.title,
    xp,
    currentLevelMinXp: current.minXp,
    nextLevelMinXp: next ? next.minXp : null,
    progressToNext: next ? (xp - current.minXp) / (next.minXp - current.minXp) : 1,
  };
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function computeUserStats(userId) {
  const completions = db.prepare(`
    SELECT a.id, a.key, a.name, a.category, a.xp, a.rarity, a.icon, c.completed_at
    FROM completions c JOIN activities a ON a.id = c.activity_id
    WHERE c.user_id = ?
    ORDER BY c.completed_at ASC
  `).all(userId);

  const totalXp = completions.reduce((sum, c) => sum + c.xp, 0);
  const levelInfo = levelForXp(totalXp);

  const allActivities = db.prepare('SELECT * FROM activities').all();
  const categories = [...new Set(allActivities.map((a) => a.category))];
  const completedByCategory = {};
  for (const cat of categories) {
    const total = allActivities.filter((a) => a.category === cat).length;
    const done = completions.filter((c) => c.category === cat).length;
    completedByCategory[cat] = { done, total, complete: done === total };
  }

  const badges = [];
  if (completions.length >= 1) badges.push({ key: 'first_timer', name: 'First Timer', icon: '⭐', desc: 'Completed your first activity' });
  if (completions.length >= 10) badges.push({ key: 'ten_down', name: 'Double Digits', icon: '🔥', desc: 'Completed 10 activities' });
  if (completions.length >= 20) badges.push({ key: 'twenty_down', name: 'Overachiever', icon: '💯', desc: 'Completed 20 activities' });
  if (completions.some((c) => c.rarity === 'legendary')) badges.push({ key: 'legendary', name: 'Legendary', icon: '🏅', desc: 'Completed a legendary activity' });
  if (completions.some((c) => c.key === 'join_frat_sorority')) badges.push({ key: 'greek', name: 'Greek Icon', icon: '🏛️', desc: 'Joined a fraternity/sorority' });
  for (const cat of categories) {
    if (completedByCategory[cat].complete) {
      badges.push({ key: `cat_${cat}`, name: `${cat} Champion`, icon: '🎯', desc: `Completed every ${cat} activity` });
    }
  }
  if (allActivities.length && completions.length === allActivities.length) {
    badges.push({ key: 'blackout', name: 'Full Send', icon: '👑', desc: 'Completed every single activity' });
  }

  return {
    totalXp,
    levelInfo,
    completedKeys: completions.map((c) => c.key),
    completions,
    completedByCategory,
    badges,
  };
}

// --- Users ---
app.post('/api/users', (req, res) => {
  const { username } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Nickname must be 2-20 characters (letters, numbers, spaces, underscores).' });
  }
  let user = getUserByUsername(username);
  if (!user) {
    const info = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  res.json({ id: user.id, username: user.username });
});

// --- Activities ---
app.get('/api/activities', (req, res) => {
  const activities = db.prepare('SELECT * FROM activities ORDER BY category, xp').all();
  res.json(activities);
});

// --- Progress ---
app.get('/api/users/:username/progress', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(computeUserStats(user.id));
});

// --- Toggle completion ---
app.post('/api/users/:username/toggle', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { activityKey } = req.body || {};
  const activity = db.prepare('SELECT * FROM activities WHERE key = ?').get(activityKey);
  if (!activity) return res.status(404).json({ error: 'Activity not found' });

  const existing = db.prepare('SELECT * FROM completions WHERE user_id = ? AND activity_id = ?').get(user.id, activity.id);
  if (existing) {
    db.prepare('DELETE FROM completions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO completions (user_id, activity_id) VALUES (?, ?)').run(user.id, activity.id);
  }
  res.json(computeUserStats(user.id));
});

// --- Leaderboard ---
app.get('/api/leaderboard', (req, res) => {
  const users = db.prepare('SELECT id, username FROM users').all();
  const board = users
    .map((u) => {
      const stats = computeUserStats(u.id);
      return {
        username: u.username,
        totalXp: stats.totalXp,
        level: stats.levelInfo.level,
        title: stats.levelInfo.title,
        activitiesCompleted: stats.completions.length,
        badgeCount: stats.badges.length,
      };
    })
    .sort((a, b) => b.totalXp - a.totalXp)
    .slice(0, 100);
  res.json(board);
});

// In production, serve the built React app from this same process/port
// so there's a single service to deploy instead of two.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`College Cliche Quest listening on :${PORT}`));
