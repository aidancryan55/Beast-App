const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const db = require('./db');
const { LEVELS } = require('./activities');

const app = express();
app.use(cors());
app.use(express.json());

const USERNAME_RE = /^[a-zA-Z0-9_ ]{2,20}$/;
const POST_EXPIRY_MS = 24 * 60 * 60 * 1000;

const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

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

// --- Repeatable-activity period keys ---
// 'daily' periods are calendar dates; 'weekly' periods are consecutive 7-day
// buckets since the epoch (not calendar weeks — just needs to be stable and
// consecutive for streak math, nobody sees the raw key).
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function dayIndex(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 86400000);
}
function periodKeyFor(repeatable) {
  if (repeatable === 'daily') return todayStr();
  if (repeatable === 'weekly') return `W${Math.floor(dayIndex(todayStr()) / 7)}`;
  return 'once';
}
function periodSortValue(periodKey, repeatable) {
  if (repeatable === 'daily') return /^\d{4}-\d{2}-\d{2}$/.test(periodKey) ? dayIndex(periodKey) : null;
  if (repeatable === 'weekly') return /^W\d+$/.test(periodKey) ? parseInt(periodKey.slice(1), 10) : null;
  return null;
}
function computeStreak(periodKeys, repeatable) {
  const values = [...new Set(periodKeys.map((k) => periodSortValue(k, repeatable)))]
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  if (!values.length) return 0;
  let streak = 1;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i] - values[i - 1] === 1) streak++;
    else break;
  }
  return streak;
}

// --- Time-bucketed point totals (today / this week / this month / this year) ---
function startOfWeek(d) {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return s;
}
function computePeriodTotals(events) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = startOfWeek(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

  const totals = { today: 0, week: 0, month: 0, year: 0, allTime: 0 };
  for (const e of events) {
    const t = new Date(`${e.earnedAt.replace(' ', 'T')}Z`);
    totals.allTime += e.points;
    if (t >= yearStart) totals.year += e.points;
    if (t >= monthStart) totals.month += e.points;
    if (t >= weekStart) totals.week += e.points;
    if (t >= todayStart) totals.today += e.points;
  }
  return totals;
}

function computeUserStats(userId) {
  const completions = db.prepare(`
    SELECT a.id, a.key, a.name, a.category, a.xp, a.rarity, a.icon, a.repeatable, c.period_key, c.completed_at
    FROM completions c JOIN activities a ON a.id = c.activity_id
    WHERE c.user_id = ?
    ORDER BY c.completed_at ASC
  `).all(userId);

  const creditedPosts = db.prepare(`
    SELECT points, created_at FROM posts WHERE subject_user_id = ?
  `).all(userId);

  const totalXp = completions.reduce((sum, c) => sum + c.xp, 0) + creditedPosts.reduce((sum, p) => sum + p.points, 0);
  const levelInfo = levelForXp(totalXp);

  const pointEvents = [
    ...completions.map((c) => ({ points: c.xp, earnedAt: c.completed_at })),
    ...creditedPosts.map((p) => ({ points: p.points, earnedAt: p.created_at })),
  ];
  const periodTotals = computePeriodTotals(pointEvents);

  const allActivities = db.prepare('SELECT * FROM activities').all();
  const categories = [...new Set(allActivities.map((a) => a.category))];

  const completedKeys = [...new Set(completions.map((c) => c.key))];
  const completedSet = new Set(completedKeys);

  const completedByCategory = {};
  for (const cat of categories) {
    const total = allActivities.filter((a) => a.category === cat).length;
    const done = allActivities.filter((a) => a.category === cat && completedSet.has(a.key)).length;
    completedByCategory[cat] = { done, total, complete: done === total };
  }

  // Streaks + "done for the current period" state, per repeatable activity.
  const periodKeysByActivity = {};
  for (const c of completions) {
    if (!c.repeatable) continue;
    (periodKeysByActivity[c.key] ||= []).push(c.period_key);
  }
  const streaks = {};
  const currentPeriodKeys = new Set();
  for (const a of allActivities) {
    if (a.repeatable) {
      const keys = periodKeysByActivity[a.key] || [];
      const streak = computeStreak(keys, a.repeatable);
      if (streak > 0) streaks[a.key] = streak;
      if (keys.includes(periodKeyFor(a.repeatable))) currentPeriodKeys.add(a.key);
    } else if (completedSet.has(a.key)) {
      currentPeriodKeys.add(a.key);
    }
  }
  const bestStreak = Object.values(streaks).reduce((max, s) => Math.max(max, s), 0);

  const badges = [];
  if (completions.length >= 1) badges.push({ key: 'first_timer', name: 'First Timer', icon: '⭐', desc: 'Completed your first activity' });
  if (completedKeys.length >= 10) badges.push({ key: 'ten_down', name: 'Double Digits', icon: '🔟', desc: 'Completed 10 different activities' });
  if (completedKeys.length >= 20) badges.push({ key: 'twenty_down', name: 'Overachiever', icon: '💯', desc: 'Completed 20 different activities' });
  if (bestStreak >= 3) badges.push({ key: 'on_a_roll', name: 'On a Roll', icon: '🔥', desc: 'Hit a 3+ streak on a repeatable habit' });
  if (bestStreak >= 7) badges.push({ key: 'unstoppable', name: 'Unstoppable', icon: '🔥🔥', desc: 'Hit a 7+ streak on a repeatable habit' });
  if (completions.some((c) => c.rarity === 'legendary')) badges.push({ key: 'legendary', name: 'Legendary', icon: '🏅', desc: 'Completed a legendary activity' });
  if (completedSet.has('join_frat_sorority')) badges.push({ key: 'greek', name: 'Greek Icon', icon: '🏛️', desc: 'Joined a fraternity/sorority' });
  for (const cat of categories) {
    if (completedByCategory[cat].complete) {
      badges.push({ key: `cat_${cat}`, name: `${cat} Champion`, icon: '🎯', desc: `Completed every ${cat} activity` });
    }
  }
  if (allActivities.length && completedKeys.length === allActivities.length) {
    badges.push({ key: 'blackout', name: 'Full Send', icon: '👑', desc: 'Completed every single activity' });
  }
  if (creditedPosts.length >= 1) badges.push({ key: 'witnessed', name: 'Witnessed', icon: '📸', desc: 'Got credited by a friend with photo proof' });
  if (creditedPosts.length >= 10) badges.push({ key: 'certified', name: 'Certified Beast', icon: '🎥', desc: 'Got credited 10 times by friends' });

  return {
    totalXp,
    levelInfo,
    completedKeys,
    currentPeriodKeys: [...currentPeriodKeys],
    streaks,
    completions,
    completedByCategory,
    badges,
    periodTotals,
    creditedPostCount: creditedPosts.length,
  };
}

// --- Friends ---
function areFriends(userIdA, userIdB) {
  const row = db.prepare(`
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))
  `).get(userIdA, userIdB, userIdB, userIdA);
  return !!row;
}
function getFriendIds(userId) {
  const rows = db.prepare(`
    SELECT requester_id, addressee_id FROM friendships
    WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
  `).all(userId, userId);
  return rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
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

  const periodKey = periodKeyFor(activity.repeatable);
  const existing = db.prepare('SELECT * FROM completions WHERE user_id = ? AND activity_id = ? AND period_key = ?').get(user.id, activity.id, periodKey);
  if (existing) {
    db.prepare('DELETE FROM completions WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO completions (user_id, activity_id, period_key) VALUES (?, ?, ?)').run(user.id, activity.id, periodKey);
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
        activitiesCompleted: stats.completedKeys.length,
        badgeCount: stats.badges.length,
      };
    })
    .sort((a, b) => b.totalXp - a.totalXp)
    .slice(0, 100);
  res.json(board);
});

// --- Friends ---
app.get('/api/users/:username/friends', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const friends = getFriendIds(user.id).map((id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id).username);
  const incoming = db.prepare(`
    SELECT u.username FROM friendships f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
  `).all(user.id).map((r) => r.username);
  const outgoing = db.prepare(`
    SELECT u.username FROM friendships f JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
  `).all(user.id).map((r) => r.username);

  res.json({ friends, incomingRequests: incoming, outgoingRequests: outgoing });
});

app.get('/api/users/:username/search', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const q = (req.query.q || '').trim();
  if (q.length < 1) return res.json([]);
  const results = db.prepare(`
    SELECT username FROM users WHERE username LIKE ? AND id != ? LIMIT 10
  `).all(`%${q}%`, user.id).map((r) => r.username);
  res.json(results);
});

app.post('/api/users/:username/friends/request', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  if (target.id === user.id) return res.status(400).json({ error: "You can't friend yourself" });
  if (areFriends(user.id, target.id)) return res.status(400).json({ error: 'Already friends' });

  const reverseRequest = db.prepare(`
    SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'
  `).get(target.id, user.id);
  if (reverseRequest) {
    db.prepare(`UPDATE friendships SET status = 'accepted' WHERE id = ?`).run(reverseRequest.id);
    return res.json({ status: 'accepted' });
  }

  const existing = db.prepare(`SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ?`).get(user.id, target.id);
  if (existing) return res.status(400).json({ error: 'Request already sent' });

  db.prepare(`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')`).run(user.id, target.id);
  res.json({ status: 'pending' });
});

app.post('/api/users/:username/friends/respond', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const requester = getUserByUsername((req.body || {}).requesterUsername);
  if (!requester) return res.status(404).json({ error: 'That user does not exist' });
  const { accept } = req.body || {};

  const row = db.prepare(`
    SELECT * FROM friendships WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'
  `).get(requester.id, user.id);
  if (!row) return res.status(404).json({ error: 'No pending request from that user' });

  if (accept) {
    db.prepare(`UPDATE friendships SET status = 'accepted' WHERE id = ?`).run(row.id);
  } else {
    db.prepare(`DELETE FROM friendships WHERE id = ?`).run(row.id);
  }
  res.json({ status: accept ? 'accepted' : 'declined' });
});

app.post('/api/users/:username/friends/remove', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });

  db.prepare(`
    DELETE FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).run(user.id, target.id, target.id, user.id);
  res.json({ status: 'removed' });
});

// --- Posts (photo-credited Beast Points) ---
function serializePost(row, viewerUserId) {
  const reactions = db.prepare(`SELECT emoji, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY emoji`).all(row.id);
  const myReaction = viewerUserId
    ? db.prepare(`SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?`).get(row.id, viewerUserId)
    : null;
  const createdAtMs = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
  const expired = !row.saved && Date.now() - createdAtMs > POST_EXPIRY_MS;

  return {
    id: row.id,
    subjectUsername: row.subject_username,
    creditedByUsername: row.credited_by_username,
    activityKey: row.activity_key || null,
    activityName: row.activity_name || null,
    activityIcon: row.activity_icon || null,
    points: row.points,
    caption: row.caption,
    saved: !!row.saved,
    photoUrl: `/uploads/${row.photo_filename}`,
    createdAt: row.created_at,
    expiresAt: new Date(createdAtMs + POST_EXPIRY_MS).toISOString(),
    expired,
    reactions,
    myReaction: myReaction ? myReaction.emoji : null,
  };
}

app.post('/api/posts', upload.single('photo'), (req, res) => {
  const creditedBy = getUserByUsername((req.body || {}).creditedByUsername);
  if (!creditedBy) return res.status(404).json({ error: 'User not found' });
  const subject = getUserByUsername((req.body || {}).subjectUsername);
  if (!subject) return res.status(404).json({ error: 'That friend does not exist' });
  if (subject.id === creditedBy.id) return res.status(400).json({ error: "You can't credit yourself" });
  if (!areFriends(creditedBy.id, subject.id)) return res.status(403).json({ error: 'You can only credit friends' });
  if (!req.file) return res.status(400).json({ error: 'A photo is required' });

  const points = parseInt((req.body || {}).points, 10);
  if (!Number.isInteger(points) || points < 1 || points > 200) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Points must be between 1 and 200' });
  }

  let activity = null;
  if ((req.body || {}).activityKey) {
    activity = db.prepare('SELECT * FROM activities WHERE key = ?').get(req.body.activityKey);
  }

  const info = db.prepare(`
    INSERT INTO posts (subject_user_id, credited_by_user_id, activity_id, points, photo_filename, caption)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(subject.id, creditedBy.id, activity ? activity.id : null, points, req.file.filename, (req.body || {}).caption || null);

  const row = db.prepare(`
    SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
           a.key as activity_key, a.name as activity_name, a.icon as activity_icon
    FROM posts p
    JOIN users su ON su.id = p.subject_user_id
    JOIN users cu ON cu.id = p.credited_by_user_id
    LEFT JOIN activities a ON a.id = p.activity_id
    WHERE p.id = ?
  `).get(info.lastInsertRowid);

  res.status(201).json(serializePost(row, creditedBy.id));
});

app.get('/api/users/:username/feed', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const visibleIds = [user.id, ...getFriendIds(user.id)];
  const placeholders = visibleIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
           a.key as activity_key, a.name as activity_name, a.icon as activity_icon
    FROM posts p
    JOIN users su ON su.id = p.subject_user_id
    JOIN users cu ON cu.id = p.credited_by_user_id
    LEFT JOIN activities a ON a.id = p.activity_id
    WHERE p.subject_user_id IN (${placeholders})
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all(...visibleIds);

  const posts = rows.map((r) => serializePost(r, user.id)).filter((p) => !p.expired);
  res.json(posts);
});

app.post('/api/posts/:postId/react', (req, res) => {
  const user = getUserByUsername((req.body || {}).username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'emoji is required' });

  const existing = db.prepare('SELECT * FROM reactions WHERE post_id = ? AND user_id = ?').get(post.id, user.id);
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
  } else if (existing) {
    db.prepare('UPDATE reactions SET emoji = ? WHERE id = ?').run(emoji, existing.id);
  } else {
    db.prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(post.id, user.id, emoji);
  }

  const row = db.prepare(`
    SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
           a.key as activity_key, a.name as activity_name, a.icon as activity_icon
    FROM posts p
    JOIN users su ON su.id = p.subject_user_id
    JOIN users cu ON cu.id = p.credited_by_user_id
    LEFT JOIN activities a ON a.id = p.activity_id
    WHERE p.id = ?
  `).get(post.id);
  res.json(serializePost(row, user.id));
});

app.post('/api/posts/:postId/save', (req, res) => {
  const user = getUserByUsername((req.body || {}).username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.subject_user_id !== user.id) return res.status(403).json({ error: 'Only the person in the photo can save it' });

  db.prepare('UPDATE posts SET saved = ? WHERE id = ?').run(post.saved ? 0 : 1, post.id);

  const row = db.prepare(`
    SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
           a.key as activity_key, a.name as activity_name, a.icon as activity_icon
    FROM posts p
    JOIN users su ON su.id = p.subject_user_id
    JOIN users cu ON cu.id = p.credited_by_user_id
    LEFT JOIN activities a ON a.id = p.activity_id
    WHERE p.id = ?
  `).get(post.id);
  res.json(serializePost(row, user.id));
});

// Reclaim disk space from expired, unsaved photos.
function cleanupExpiredPosts() {
  const cutoff = new Date(Date.now() - POST_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
  const expired = db.prepare(`SELECT * FROM posts WHERE saved = 0 AND created_at < ?`).all(cutoff);
  for (const post of expired) {
    fs.unlink(path.join(uploadsDir, post.photo_filename), () => {});
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  }
}
cleanupExpiredPosts();
setInterval(cleanupExpiredPosts, 60 * 60 * 1000);

// In production, serve the built React app from this same process/port
// so there's a single service to deploy instead of two.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`The Beast Game listening on :${PORT}`));
