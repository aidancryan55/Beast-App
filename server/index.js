const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { LEVELS } = require('./activities');

// Load server/.env in local dev (Render sets real env vars directly, no .env file there).
if (fs.existsSync(path.join(__dirname, '.env'))) {
  process.loadEnvFile(path.join(__dirname, '.env'));
}

const app = express();
app.use(cors());
app.use(express.json());

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DISPLAY_NAME_RE = /^[\w .'-]{1,30}$/;
const POST_EXPIRY_MS = 24 * 60 * 60 * 1000;
const GROUP_MAX_MEMBERS = 30;
const VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

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

// --- Auth: bcrypt password hashing + opaque session tokens ---
function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}
function verifyPassword(password, hash) {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
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
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.', code: 'banned' });
  req.authUser = user;
  req.authToken = token;
  next();
}
function requireVerified(req, res, next) {
  if (!req.authUser.email_verified) {
    return res.status(403).json({ error: 'Verify your email before posting — check your inbox for the confirmation link.', code: 'unverified' });
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.authUser.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// --- Basic caption content filter ---
// Not a substitute for the report/block/admin pipeline below (which is what
// actually satisfies Apple's UGC moderation requirement) — just a first-pass
// block on the most obvious abuse in text fields. Photo content isn't
// automatically screened; that needs a paid image-moderation API we don't have.
const CAPTION_BLOCKLIST = [/\bn[i1]gg[ae3]r/i, /\bf[a4]gg?[o0]t/i, /\br[a4]pe/i, /\bch[i1]ld\s*p[o0]rn/i];
function containsBlockedContent(text) {
  return typeof text === 'string' && CAPTION_BLOCKLIST.some((re) => re.test(text));
}

// --- Email verification tokens + Resend ---
function generateVerifyToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + VERIFY_TOKEN_EXPIRY_MS).toISOString();
  return { token, tokenHash, expires };
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'The Beast Game <onboarding@resend.dev>';
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 4001}`;

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${APP_URL}/api/verify?token=${token}`;
  if (!RESEND_API_KEY) {
    // Dev fallback: no Resend key configured, so log the link instead of emailing it.
    console.log(`[dev] Verification link for ${email}:\n${verifyUrl}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: 'Confirm your email for The Beast Game',
      html: `<p>Tap the link below to confirm your email and finish signing up for The Beast Game:</p>
             <p><a href="${verifyUrl}">${verifyUrl}</a></p>
             <p>This link expires in 24 hours.</p>`,
    }),
  });
  if (!res.ok) {
    console.error('Resend send failed:', res.status, await res.text().catch(() => ''));
  }
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

// --- Blocking ---
function isBlocked(userIdA, userIdB) {
  return !!db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?)
  `).get(userIdA, userIdB, userIdB, userIdA);
}
// Union of "users I've blocked" and "users who've blocked me" — either
// direction hides that person's content from a feed.
function getHiddenUserIds(userId) {
  const rows = db.prepare(`
    SELECT blocker_user_id, blocked_user_id FROM blocks
    WHERE blocker_user_id = ? OR blocked_user_id = ?
  `).all(userId, userId);
  return rows.map((r) => (r.blocker_user_id === userId ? r.blocked_user_id : r.blocker_user_id));
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
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — try again in a bit.' },
});

app.post('/api/signup', authLimiter, async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const name = (displayName || '').trim();
  if (!name || !DISPLAY_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Display name must be 1-30 characters (letters, numbers, spaces, . \' -).' });
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existingEmail) return res.status(409).json({ error: 'That email is already registered.' });
  const existingName = db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (existingName) return res.status(409).json({ error: 'That display name is taken.' });

  const passwordHash = await hashPassword(password);
  const { token, tokenHash, expires } = generateVerifyToken();

  const isAdmin = process.env.ADMIN_EMAIL && email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  db.prepare(`
    INSERT INTO users (username, email, password_hash, email_verified, verify_token_hash, verify_token_expires, is_admin)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `).run(name, email.toLowerCase(), passwordHash, tokenHash, expires, isAdmin);

  try {
    await sendVerificationEmail(email, token);
  } catch (err) {
    console.error('sendVerificationEmail failed:', err);
  }

  res.status(201).json({ status: 'pending_verification', email: email.toLowerCase() });
});

// Hit by clicking the link in the verification email — plain HTML response, no SPA involved.
app.get('/api/verify', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = token ? db.prepare('SELECT * FROM users WHERE verify_token_hash = ?').get(tokenHash) : null;

  const page = (title, message) => res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#17131f;color:#f1edf9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
h1{font-size:22px}p{color:#b3a9c4}</style></head>
<body><div><h1>${title}</h1><p>${message}</p></div></body></html>`);

  if (!user) return page('Invalid link', 'This verification link is invalid or has already been used.');
  if (!user.verify_token_expires || new Date(user.verify_token_expires) < new Date()) {
    return page('Link expired', 'This verification link has expired. Please sign up again.');
  }

  db.prepare('UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires = NULL WHERE id = ?').run(user.id);
  page('Email verified 🎉', 'You can close this tab and log back in to The Beast Game.');
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !user.password_hash) return res.status(404).json({ error: 'No account with that email.' });
  const ok = await verifyPassword(password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.', code: 'banned' });
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email first — check your inbox for the confirmation link.', code: 'unverified' });
  }
  const token = createSession(user.id);
  res.json({ displayName: user.username, token, isAdmin: !!user.is_admin });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.authToken);
  res.json({ status: 'logged out' });
});

// Apple 5.1.1(v): account creation requires in-app account deletion.
app.delete('/api/account', requireAuth, async (req, res) => {
  const user = req.authUser;
  const ok = await verifyPassword((req.body || {}).password || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });

  // Detach group ownership first so deleting your account never cascades into
  // destroying a group other people are still in (see note in db.js).
  db.prepare('UPDATE groups SET created_by_user_id = NULL WHERE created_by_user_id = ?').run(user.id);

  const photoFilenames = db.prepare(`
    SELECT photo_filename FROM posts WHERE subject_user_id = ? OR credited_by_user_id = ?
  `).all(user.id, user.id).map((r) => r.photo_filename);

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades sessions, posts, credits, reactions, reports, blocks, group_members

  for (const filename of photoFilenames) {
    fs.unlink(path.join(uploadsDir, filename), () => {});
  }

  res.json({ status: 'deleted' });
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

// --- Blocking ---
app.get('/api/users/:username/blocked', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.username FROM blocks b JOIN users u ON u.id = b.blocked_user_id WHERE b.blocker_user_id = ?
  `).all(req.authUser.id);
  res.json(rows.map((r) => r.username));
});

app.post('/api/users/:username/block', requireAuth, (req, res) => {
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  if (target.id === req.authUser.id) return res.status(400).json({ error: "You can't block yourself" });
  db.prepare(`
    INSERT OR IGNORE INTO blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)
  `).run(req.authUser.id, target.id);
  res.json({ status: 'blocked' });
});

app.post('/api/users/:username/unblock', requireAuth, (req, res) => {
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  db.prepare('DELETE FROM blocks WHERE blocker_user_id = ? AND blocked_user_id = ?').run(req.authUser.id, target.id);
  res.json({ status: 'unblocked' });
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

app.post('/api/posts', requireAuth, requireVerified, upload.single('photo'), (req, res) => {
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
  if (containsBlockedContent(body.caption)) return fail(400, 'That caption isn\'t allowed.');
  if (isBlocked(creditedBy.id, subject.id)) return fail(403, "You can't post about this person");

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

app.post('/api/posts/:postId/credit', requireAuth, requireVerified, (req, res) => {
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

  const hidden = new Set(getHiddenUserIds(user.id));
  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'public'
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all();

  const posts = rows
    .filter((r) => !hidden.has(r.subject_user_id) && !hidden.has(r.credited_by_user_id))
    .map((r) => serializePost(r, user.id))
    .filter((p) => !p.expired);
  res.json(posts);
});

// Group feed: posts scoped to one group, members only.
app.get('/api/groups/:groupId/feed', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!isGroupMember(group.id, req.authUser.id)) return res.status(403).json({ error: "You're not in that group" });

  const hidden = new Set(getHiddenUserIds(req.authUser.id));
  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'group' AND p.group_id = ?
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all(group.id);

  const posts = rows
    .filter((r) => !hidden.has(r.subject_user_id) && !hidden.has(r.credited_by_user_id))
    .map((r) => serializePost(r, req.authUser.id))
    .filter((p) => !p.expired);
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

// --- Reporting (Apple 1.2: users must be able to report objectionable content) ---
app.post('/api/posts/:postId/report', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const reason = ((req.body || {}).reason || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'Tell us what\'s wrong with this post.' });

  db.prepare(`
    INSERT INTO reports (post_id, reporter_user_id, reason) VALUES (?, ?, ?)
    ON CONFLICT(post_id, reporter_user_id) DO UPDATE SET reason = excluded.reason, status = 'pending', resolved_at = NULL
  `).run(post.id, req.authUser.id, reason);

  res.status(201).json({ status: 'reported' });
});

function deletePostAndFile(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;
  fs.unlink(path.join(uploadsDir, post.photo_filename), () => {});
  db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
}

// --- Admin moderation queue ---
// Not a public endpoint — gated behind is_admin (see ADMIN_EMAIL in db.js).
// This is what makes "act on reports within 24h" operationally possible.
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.status, r.created_at,
           reporter.username as reporter_username,
           p.id as post_id, p.photo_filename, p.caption, p.visibility,
           su.username as subject_username, cu.username as credited_by_username
    FROM reports r
    JOIN users reporter ON reporter.id = r.reporter_user_id
    JOIN posts p ON p.id = r.post_id
    JOIN users su ON su.id = p.subject_user_id
    JOIN users cu ON cu.id = p.credited_by_user_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all();
  res.json(rows.map((r) => ({
    id: r.id,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    reporterUsername: r.reporter_username,
    postId: r.post_id,
    photoUrl: `/uploads/${r.photo_filename}`,
    caption: r.caption,
    visibility: r.visibility,
    subjectUsername: r.subject_username,
    creditedByUsername: r.credited_by_username,
  })));
});

app.post('/api/admin/reports/:reportId/resolve', requireAuth, requireAdmin, (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.reportId);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const { action } = req.body || {}; // 'dismiss' | 'remove' | 'ban'

  if (action === 'remove' || action === 'ban') {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(report.post_id);
    if (post && action === 'ban') {
      db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(post.credited_by_user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(post.credited_by_user_id);
    }
    deletePostAndFile(report.post_id);
  }

  db.prepare(`UPDATE reports SET status = ?, resolved_at = datetime('now') WHERE id = ?`)
    .run(action === 'dismiss' ? 'dismissed' : action === 'ban' ? 'banned' : 'removed', report.id);

  res.json({ status: 'resolved' });
});

// Reclaim disk space from expired, unsaved photos.
function cleanupExpiredPosts() {
  const cutoff = new Date(Date.now() - POST_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
  const expired = db.prepare(`SELECT id FROM posts WHERE saved = 0 AND created_at < ?`).all(cutoff);
  for (const post of expired) deletePostAndFile(post.id);
}
cleanupExpiredPosts();
setInterval(cleanupExpiredPosts, 60 * 60 * 1000);

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'aidancryan55@gmail.com';

// Static privacy policy page (Apple requires a working URL, linked in-app and
// in App Store Connect). Plain server-rendered HTML so it works with no JS
// and survives independently of the SPA bundle.
app.get('/privacy', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — The Beast Game</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 20px 60px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2em; }
  a { color: #6b3fa0; }
</style>
</head>
<body>
<h1>Privacy Policy — The Beast Game</h1>
<p>Last updated: ${new Date().toISOString().slice(0, 10)}</p>

<h2>What we collect</h2>
<p>Email address (for login and account recovery — never shown publicly), a display name (shown publicly on posts and the leaderboard), your password (stored as a bcrypt hash, never in plain text), and photos you upload as part of posts.</p>

<h2>How we use it</h2>
<p>To operate the app: authenticate you, show your display name on content you post or are credited in, calculate points and leaderboard standing, and send you a one-time verification email via Resend when you sign up.</p>

<h2>Photos and posts</h2>
<p>Photos you post are automatically deleted from our servers 24 hours after posting, unless you choose to save them. Public posts are visible to all users; group posts are visible only to members of that group.</p>

<h2>Content moderation</h2>
<p>Any user can report a post they find objectionable directly in the app. Reports are reviewed by a moderator, and violating content or accounts are actioned (content removed and/or the account suspended) within 24 hours. Users can also block other users, which immediately hides that user's content from them and vice versa.</p>

<h2>Account deletion</h2>
<p>You can permanently delete your account and all associated data at any time from within the app, under Settings. This immediately deletes your posts, photos, and personal data from our active database.</p>

<h2>Data sharing</h2>
<p>We do not sell or share your personal data with third parties, except Resend (resend.com), which we use solely to deliver transactional verification emails.</p>

<h2>Contact</h2>
<p>Questions, concerns, or a report you'd like to escalate directly? Email <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
</body>
</html>`);
});

// In production, serve the built React app from this same process/port
// so there's a single service to deploy instead of two.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`The Beast Game listening on :${PORT}`));
