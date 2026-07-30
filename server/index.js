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

// A signup/login identifier can be a nickname, an email, or a phone number —
// whichever the user types is stored as-is and used to log back in.
const NICKNAME_RE = /^[a-zA-Z0-9_ ]{2,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;
function isValidIdentifier(value) {
  return typeof value === 'string' && value.length <= 50
    && (NICKNAME_RE.test(value) || EMAIL_RE.test(value) || PHONE_RE.test(value));
}
const POST_EXPIRY_MS = 24 * 60 * 60 * 1000;
const GROUP_MAX_MEMBERS = 30;

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

// --- Auth: password hashing (scrypt, no extra dependency) + opaque session tokens ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return check.length === expected.length && crypto.timingSafeEqual(check, expected);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}
function getUserByToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token) || null;
}
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Please log in again' });
  req.authUser = user;
  req.authToken = token;
  next();
}
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
  // Points from photo-credited posts come from post_credits (many possible
  // awarders per post), so pull each individual credit as its own point event.
  const postCredits = db.prepare(`
    SELECT pc.points, pc.created_at, pc.post_id
    FROM post_credits pc
    JOIN posts p ON p.id = pc.post_id
    WHERE p.subject_user_id = ?
  `).all(userId);
  const creditedPostIds = new Set(postCredits.map((c) => c.post_id));

  const totalXp = postCredits.reduce((sum, c) => sum + c.points, 0);
  const levelInfo = levelForXp(totalXp);

  const periodTotals = computePeriodTotals(postCredits.map((c) => ({ points: c.points, earnedAt: c.created_at })));

  const creditsGivenCount = db.prepare(`
    SELECT COUNT(DISTINCT post_id) as n FROM post_credits WHERE awarder_user_id = ?
  `).get(userId).n;

  const badges = [];
  if (creditedPostIds.size >= 1) badges.push({ key: 'witnessed', name: 'Witnessed', icon: '📸', desc: 'Got credited with photo proof' });
  if (creditedPostIds.size >= 10) badges.push({ key: 'certified', name: 'Certified Beast', icon: '🎥', desc: 'Got credited on 10 different posts' });
  if (creditsGivenCount >= 5) badges.push({ key: 'talent_scout', name: 'Talent Scout', icon: '🔭', desc: 'Credited 5+ different posts' });

  return {
    totalXp,
    levelInfo,
    badges,
    periodTotals,
    creditedPostCount: creditedPostIds.size,
  };
}

// --- Groups ---
function isGroupMember(groupId, userId) {
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}
function getGroupMemberIds(groupId) {
  return db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId).map((r) => r.user_id);
}
function serializeGroup(group, viewerUserId) {
  const memberIds = getGroupMemberIds(group.id);
  const members = memberIds.map((id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username).filter(Boolean);
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    memberCount: memberIds.length,
    maxMembers: GROUP_MAX_MEMBERS,
    members,
    isMember: viewerUserId ? memberIds.includes(viewerUserId) : false,
    createdByUsername: db.prepare('SELECT username FROM users WHERE id = ?').get(group.created_by_user_id)?.username,
  };
}

// --- Auth ---
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !isValidIdentifier(username)) {
    return res.status(400).json({ error: 'Enter a nickname, email, or phone number.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  let user = getUserByUsername(username);
  if (user && user.password_hash) {
    return res.status(409).json({ error: 'That nickname is already taken.' });
  }

  const hash = hashPassword(password);
  if (user && !user.password_hash) {
    // Legacy/unclaimed account from before accounts had passwords — claim it.
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  } else {
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = createSession(user.id);
  res.status(201).json({ username: user.username, token });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserByUsername(username || '');
  if (!user) return res.status(404).json({ error: 'No account with that nickname — sign up instead.' });
  if (!user.password_hash) return res.status(400).json({ error: 'This account needs a password — use Sign Up to claim it.' });
  if (!verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = createSession(user.id);
  res.json({ username: user.username, token });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.authToken);
  res.json({ status: 'logged out' });
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
        creditedPostCount: stats.creditedPostCount,
        badgeCount: stats.badges.length,
      };
    })
    .sort((a, b) => b.totalXp - a.totalXp)
    .slice(0, 100);
  res.json(board);
});

// Used by the "who's the beast?" search when posting publicly (any user, no friend graph needed).
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

// --- Groups ---
app.get('/api/users/:username/groups', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const groups = db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `).all(user.id);
  res.json(groups.map((g) => serializeGroup(g, user.id)));
});

app.get('/api/users/:username/groups/discover', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const q = (req.query.q || '').trim();
  const groups = db.prepare(`
    SELECT g.* FROM groups g
    WHERE g.name LIKE ?
      AND g.id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
    ORDER BY g.created_at DESC
    LIMIT 50
  `).all(`%${q}%`, user.id);
  res.json(groups.map((g) => serializeGroup(g, user.id)));
});

app.post('/api/groups', requireAuth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name || !name.trim() || name.trim().length > 40) {
    return res.status(400).json({ error: 'Group name must be 1-40 characters' });
  }
  const info = db.prepare(`
    INSERT INTO groups (name, description, created_by_user_id) VALUES (?, ?, ?)
  `).run(name.trim(), (description || '').trim() || null, req.authUser.id);
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.authUser.id);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(serializeGroup(group, req.authUser.id));
});

app.get('/api/groups/:groupId', (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const viewer = getUserByUsername((req.query.viewerUsername || ''));
  res.json(serializeGroup(group, viewer ? viewer.id : null));
});

app.post('/api/groups/:groupId/join', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (isGroupMember(group.id, req.authUser.id)) return res.status(400).json({ error: 'Already in this group' });
  if (getGroupMemberIds(group.id).length >= GROUP_MAX_MEMBERS) {
    return res.status(400).json({ error: `This group is full (max ${GROUP_MAX_MEMBERS})` });
  }
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, req.authUser.id);
  res.json(serializeGroup(group, req.authUser.id));
});

app.post('/api/groups/:groupId/leave', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group.id, req.authUser.id);
  res.json({ status: 'left' });
});

// --- Posts (photo-credited Beast Points) ---
const POST_JOIN_SQL = `
  SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
         a.key as activity_key, a.name as activity_name, a.icon as activity_icon,
         g.name as group_name
  FROM posts p
  JOIN users su ON su.id = p.subject_user_id
  JOIN users cu ON cu.id = p.credited_by_user_id
  LEFT JOIN activities a ON a.id = p.activity_id
  LEFT JOIN groups g ON g.id = p.group_id
`;
function getPostRow(id) {
  return db.prepare(`${POST_JOIN_SQL} WHERE p.id = ?`).get(id);
}
function maxCreditFor(visibility) {
  return visibility === 'group' ? 200 : 50;
}

function serializePost(row, viewerUserId) {
  const reactions = db.prepare(`SELECT emoji, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY emoji`).all(row.id);
  const myReaction = viewerUserId
    ? db.prepare(`SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?`).get(row.id, viewerUserId)
    : null;
  const totalPoints = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM post_credits WHERE post_id = ?').get(row.id).total;
  const creditorCount = db.prepare('SELECT COUNT(*) as n FROM post_credits WHERE post_id = ?').get(row.id).n;
  const myCredit = viewerUserId
    ? db.prepare('SELECT points FROM post_credits WHERE post_id = ? AND awarder_user_id = ?').get(row.id, viewerUserId)
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
    visibility: row.visibility,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    points: totalPoints,
    creditorCount,
    myCredit: myCredit ? myCredit.points : null,
    maxCredit: maxCreditFor(row.visibility),
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

app.post('/api/posts', requireAuth, upload.single('photo'), (req, res) => {
  const creditedBy = req.authUser;
  const body = req.body || {};
  const visibility = body.visibility === 'group' ? 'group' : 'public';

  const fail = (status, error) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(status).json({ error });
  };

  const subject = getUserByUsername(body.subjectUsername);
  if (!subject) return fail(404, 'That person does not exist');
  if (subject.id === creditedBy.id) return fail(400, "You can't credit yourself");
  if (!req.file) return res.status(400).json({ error: 'A photo is required' });

  let groupId = null;
  if (visibility === 'group') {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(body.groupId);
    if (!group) return fail(404, 'Group not found');
    if (!isGroupMember(group.id, creditedBy.id)) return fail(403, "You're not in that group");
    if (!isGroupMember(group.id, subject.id)) return fail(400, 'That person is not in this group');
    groupId = group.id;
  }

  const points = parseInt(body.points, 10);
  const max = maxCreditFor(visibility);
  if (!Number.isInteger(points) || points < 1 || points > max) {
    return fail(400, `Points must be between 1 and ${max}`);
  }

  let activity = null;
  if (body.activityKey) {
    activity = db.prepare('SELECT * FROM activities WHERE key = ?').get(body.activityKey);
  }

  const info = db.prepare(`
    INSERT INTO posts (subject_user_id, credited_by_user_id, activity_id, visibility, group_id, photo_filename, caption)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(subject.id, creditedBy.id, activity ? activity.id : null, visibility, groupId, req.file.filename, body.caption || null);

  db.prepare('INSERT INTO post_credits (post_id, awarder_user_id, points) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, creditedBy.id, points);

  res.status(201).json(serializePost(getPostRow(info.lastInsertRowid), creditedBy.id));
});

app.post('/api/posts/:postId/credit', requireAuth, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.subject_user_id === user.id) return res.status(400).json({ error: "You can't credit yourself" });
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return res.status(403).json({ error: "You're not in that group" });
  }

  const points = parseInt((req.body || {}).points, 10);
  const max = maxCreditFor(post.visibility);
  if (!Number.isInteger(points) || points < 1 || points > max) {
    return res.status(400).json({ error: `Points must be between 1 and ${max}` });
  }

  db.prepare(`
    INSERT INTO post_credits (post_id, awarder_user_id, points) VALUES (?, ?, ?)
    ON CONFLICT(post_id, awarder_user_id) DO UPDATE SET points = excluded.points
  `).run(post.id, user.id, points);

  res.json(serializePost(getPostRow(post.id), user.id));
});

// Discover: every public post, unfiltered by friendship.
app.get('/api/users/:username/discover', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'public'
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all();

  const posts = rows.map((r) => serializePost(r, user.id)).filter((p) => !p.expired);
  res.json(posts);
});

// Group feed: posts scoped to one group, members only.
app.get('/api/groups/:groupId/feed', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!isGroupMember(group.id, req.authUser.id)) return res.status(403).json({ error: "You're not in that group" });

  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'group' AND p.group_id = ?
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all(group.id);

  const posts = rows.map((r) => serializePost(r, req.authUser.id)).filter((p) => !p.expired);
  res.json(posts);
});

app.post('/api/posts/:postId/react', requireAuth, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return res.status(403).json({ error: "You're not in that group" });
  }
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

  res.json(serializePost(getPostRow(post.id), user.id));
});

app.post('/api/posts/:postId/save', requireAuth, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.subject_user_id !== user.id) return res.status(403).json({ error: 'Only the person in the photo can save it' });

  db.prepare('UPDATE posts SET saved = ? WHERE id = ?').run(post.saved ? 0 : 1, post.id);
  res.json(serializePost(getPostRow(post.id), user.id));
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
