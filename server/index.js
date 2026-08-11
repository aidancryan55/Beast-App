const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
// Fixed bonus paid to BOTH sides of a completed dare — kept fixed since
// dares are mutual by nature, unlike the poster-chosen tag/crowd credit
// below, both of which lean on MAX_CREDIT_PER_CONTRIBUTOR instead.
const DARE_BONUS_POINTS = 2;
// Lifetime cap on how many Beast Points any single contributor can pour into
// one recipient, across every post they've ever credited them on — closes
// the two-friends-mutually-inflate-each-other farming hole that a per-post
// cap alone doesn't stop.
const MAX_CREDIT_PER_CONTRIBUTOR = 100;

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

// --- Durable photo storage (Cloudflare R2) for Memories ---
// Render's local disk is ephemeral (wiped on redeploy) and posts already
// auto-delete after 24h — fine for the live feed, but a "Memories" archive of
// everything a user has ever posted needs storage that actually survives.
// Dev fallback: without R2 credentials, uploads just stay on local disk as
// they always have — Memories will only reflect currently-live (unexpired)
// posts in that case, since expired rows get hard-deleted same as before.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxxx.r2.dev or a custom domain, no trailing slash

const r2Configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL);
const r2Client = r2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

// Returns the public R2 URL on success, or null if R2 isn't configured / the
// upload failed — callers must treat null as "stay on local disk," not throw.
async function uploadPhotoToR2(localFilePath, key) {
  if (!r2Client) return null;
  try {
    const body = fs.readFileSync(localFilePath);
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: 'image/jpeg',
    }));
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error('R2 upload failed:', err.message);
    return null;
  }
}

async function deletePhotoFromR2(key) {
  if (!r2Client || !key) return;
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  } catch (err) {
    console.error('R2 delete failed:', err.message);
  }
}

// photo_url is stored as the full public URL; the R2 object key is always
// everything after the last '/', since we never nest keys in subfolders.
function r2KeyFromUrl(photoUrl) {
  return photoUrl ? photoUrl.slice(photoUrl.lastIndexOf('/') + 1) : null;
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

// --- Beast Streak ("Beast Bender" internally) ---
// v1 keep-alive condition is "user POSTS a beast that calendar day" — this may
// later change to "gets credited" instead of "posts", but that's not
// implemented yet; don't assume credit-based keep-alive elsewhere in the code.
// Calendar day boundary uses the SERVER process's local timezone (via JS
// Date), not the poster's own timezone — a deliberate v1 simplification, not
// an oversight. A user near midnight in a different timezone than the server
// could see their day boundary land at an unexpected local time.
function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayDateString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getStreakInfo(userId) {
  const user = db.prepare('SELECT current_streak, longest_streak, last_streak_date FROM users WHERE id = ?').get(userId);
  return {
    current: user.current_streak,
    longest: user.longest_streak,
    // "At risk" means yesterday was the last active day and today hasn't
    // happened yet for streak purposes — post today or the streak resets.
    atRisk: user.last_streak_date === yesterdayDateString(),
  };
}

// Called once per successful post (see POST /api/posts). Not exported/used
// anywhere else — keep streak mutation confined to this one call site so the
// "posts, not credits" v1 rule stays easy to find and change later.
function updateStreakOnPost(userId) {
  const today = todayDateString();
  const user = db.prepare('SELECT current_streak, longest_streak, last_streak_date FROM users WHERE id = ?').get(userId);

  if (user.last_streak_date === today) return; // already posted today, no change

  const newCurrent = user.last_streak_date === yesterdayDateString() ? user.current_streak + 1 : 1;
  const newLongest = Math.max(user.longest_streak, newCurrent);

  db.prepare('UPDATE users SET current_streak = ?, longest_streak = ?, last_streak_date = ? WHERE id = ?')
    .run(newCurrent, newLongest, today, userId);
}

// --- Points ledger ---
// Durable record of every points-earning event, independent of the post that
// caused it (see the points_ledger comment in db.js for why). Call this
// alongside every post_credits write, not instead of it — post_credits stays
// the live per-post display source (creditorCount, card totals) for the
// post's 24h life; this is the thing that outlives it. Upserts on
// (source_post_id, source_type, contributor_user_id) so editing an existing
// crowd credit updates the ledger amount rather than double-counting it.
function writeLedgerEntry(recipientUserId, points, sourceType, sourcePostId, contributorUserId) {
  db.prepare(`
    INSERT INTO points_ledger (user_id, points, source_type, source_post_id, contributor_user_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_post_id, source_type, contributor_user_id) DO UPDATE SET points = excluded.points
  `).run(recipientUserId, points, sourceType, sourcePostId, contributorUserId);
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
    streak: getStreakInfo(userId),
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

  const photos = db.prepare(`
    SELECT photo_filename, photo_url, inset_photo_filename, inset_photo_url
    FROM posts WHERE subject_user_id = ? OR credited_by_user_id = ?
  `).all(user.id, user.id);

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades sessions, posts, credits, reactions, comments, reports, blocks, group_members

  for (const photo of photos) {
    fs.unlink(path.join(uploadsDir, photo.photo_filename), () => {});
    // Memories (R2) durable copies would otherwise survive account deletion
    // indefinitely — "deletes your posts, photos, and personal data" in the
    // privacy policy has to mean this too, not just the local/ephemeral copy.
    if (photo.photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.photo_url));
    if (photo.inset_photo_filename) fs.unlink(path.join(uploadsDir, photo.inset_photo_filename), () => {});
    if (photo.inset_photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.inset_photo_url));
  }

  res.json({ status: 'deleted' });
});

// --- Activities ---
app.get('/api/activities', (req, res) => {
  const activities = db.prepare('SELECT * FROM activities ORDER BY category, xp').all();
  res.json(activities);
});

function slugifyActivityName(name) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `custom_${crypto.randomBytes(3).toString('hex')}`;
}

// Users can coin their own activity tag; once created it's shared and reusable
// by anyone (looked up by its slugified key), not private to the creator.
app.post('/api/activities', requireAuth, requireVerified, (req, res) => {
  const name = ((req.body || {}).name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Give it a name' });
  if (containsBlockedContent(name)) return res.status(400).json({ error: "That name isn't allowed." });

  const key = slugifyActivityName(name);
  db.prepare(`
    INSERT INTO activities (key, name, category, xp, rarity, icon, is_custom, created_by_user_id)
    VALUES (?, ?, 'Custom', 10, 'common', '✨', 1, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(key, name, req.authUser.id);

  res.status(201).json(db.prepare('SELECT * FROM activities WHERE key = ?').get(key));
});

// --- Progress ---
app.get('/api/users/:username/progress', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(computeUserStats(user.id));
});

// --- Beast Streak ---
app.get('/api/me/streak', requireAuth, (req, res) => {
  res.json(getStreakInfo(req.authUser.id));
});

// --- Memories ---
// Private per-user history of every beast YOU'VE photographed (posts you
// created, not posts you're tagged in), independent of the public feed's 24h
// expiry. expirePostFromFeeds already hard-deletes any row with no durable
// R2 copy once it ages out, so whatever's still in `posts` here is fair game.
app.get('/api/me/memories', requireAuth, (req, res) => {
  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.credited_by_user_id = ?
    ORDER BY p.created_at DESC
  `).all(req.authUser.id);
  const memories = rows.map((r) => ({
    id: r.id,
    date: r.created_at.slice(0, 10),
    photoUrl: r.photo_url || `/uploads/${r.photo_filename}`,
    caption: r.caption,
    subjectUsername: r.subject_username,
    activityName: r.activity_name || null,
    activityIcon: r.activity_icon || null,
  }));
  res.json(memories);
});

// --- Beast Dares ---
// Basic mechanic only: no premade dare content/templates, no notifications
// yet — just issue → fulfill via a post → both sides get a small bonus.
app.post('/api/dares', requireAuth, requireVerified, (req, res) => {
  const body = req.body || {};
  const target = getUserByUsername(body.targetUsername);
  if (!target) return res.status(404).json({ error: 'That person does not exist' });
  if (target.id === req.authUser.id) return res.status(400).json({ error: "You can't dare yourself" });
  if (isBlocked(req.authUser.id, target.id)) return res.status(403).json({ error: "You can't dare this person" });

  const description = ((body.description || '').trim()).slice(0, 200);
  if (!description) return res.status(400).json({ error: 'Say what the dare is.' });
  if (containsBlockedContent(description)) return res.status(400).json({ error: "That dare isn't allowed." });

  const info = db.prepare('INSERT INTO dares (issuer_user_id, target_user_id, description) VALUES (?, ?, ?)')
    .run(req.authUser.id, target.id, description);
  res.status(201).json({ id: info.lastInsertRowid, status: 'pending' });
});

app.get('/api/me/dares', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, iss.username as issuer_username, tgt.username as target_username
    FROM dares d
    JOIN users iss ON iss.id = d.issuer_user_id
    JOIN users tgt ON tgt.id = d.target_user_id
    WHERE d.issuer_user_id = ? OR d.target_user_id = ?
    ORDER BY d.created_at DESC
  `).all(req.authUser.id, req.authUser.id);
  res.json(rows.map((r) => ({
    id: r.id,
    description: r.description,
    status: r.status,
    issuerUsername: r.issuer_username,
    targetUsername: r.target_username,
    isIssuedByMe: r.issuer_user_id === req.authUser.id,
    createdAt: r.created_at,
  })));
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
// How many more points `contributorUserId` is still allowed to give
// `subjectUserId` before hitting the lifetime MAX_CREDIT_PER_CONTRIBUTOR cap.
// Adds back whatever they've already put on `postId` specifically, since an
// edit to that post's credit replaces (not adds to) their prior amount there.
function creditBudgetFor(subjectUserId, contributorUserId, postId) {
  const totalGiven = db.prepare(`
    SELECT COALESCE(SUM(points), 0) as total FROM points_ledger
    WHERE user_id = ? AND contributor_user_id = ?
  `).get(subjectUserId, contributorUserId).total;
  const alreadyOnThisPost = db.prepare(`
    SELECT points FROM points_ledger
    WHERE user_id = ? AND contributor_user_id = ? AND source_post_id = ? AND source_type = 'crowd_credit'
  `).get(subjectUserId, contributorUserId, postId)?.points || 0;
  return MAX_CREDIT_PER_CONTRIBUTOR - totalGiven + alreadyOnThisPost;
}

function serializePost(row, viewerUserId) {
  const reactions = db.prepare(`SELECT emoji, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY emoji`).all(row.id);
  const myReaction = viewerUserId
    ? db.prepare(`SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?`).get(row.id, viewerUserId)
    : null;
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, u.username FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(row.id).map((c) => ({ id: c.id, username: c.username, body: c.body, createdAt: c.created_at }));
  const totalPoints = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM post_credits WHERE post_id = ?').get(row.id).total;
  const creditorCount = db.prepare('SELECT COUNT(*) as n FROM post_credits WHERE post_id = ?').get(row.id).n;
  const myCredit = viewerUserId
    ? db.prepare('SELECT points FROM post_credits WHERE post_id = ? AND awarder_user_id = ?').get(row.id, viewerUserId)
    : null;
  const maxCredit = viewerUserId
    ? Math.max(0, Math.min(maxCreditFor(row.visibility), creditBudgetFor(row.subject_user_id, viewerUserId, row.id)))
    : maxCreditFor(row.visibility);
  const createdAtMs = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
  const expired = !row.saved && Date.now() - createdAtMs > POST_EXPIRY_MS;

  const isAnonymous = !!row.is_anonymous;

  return {
    id: row.id,
    subjectUsername: row.subject_username,
    creditedByUsername: isAnonymous ? 'Anonymous' : row.credited_by_username,
    isAnonymous,
    activityKey: row.activity_key || null,
    activityName: row.activity_name || null,
    activityIcon: row.activity_icon || null,
    visibility: row.visibility,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    points: totalPoints,
    creditorCount,
    myCredit: myCredit ? myCredit.points : null,
    maxCredit,
    caption: row.caption,
    saved: !!row.saved,
    photoUrl: row.photo_url || `/uploads/${row.photo_filename}`,
    insetPhotoUrl: row.inset_photo_url || (row.inset_photo_filename ? `/uploads/${row.inset_photo_filename}` : null),
    createdAt: row.created_at,
    expiresAt: new Date(createdAtMs + POST_EXPIRY_MS).toISOString(),
    expired,
    reactions,
    myReaction: myReaction ? myReaction.emoji : null,
    comments,
  };
}

app.post('/api/posts', requireAuth, requireVerified, upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'insetPhoto', maxCount: 1 }]), async (req, res) => {
  const creditedBy = req.authUser;
  const body = req.body || {};
  const visibility = body.visibility === 'group' ? 'group' : 'public';
  const mainFile = req.files?.photo?.[0];
  const insetFile = req.files?.insetPhoto?.[0];

  const fail = (status, error) => {
    if (mainFile) fs.unlink(mainFile.path, () => {});
    if (insetFile) fs.unlink(insetFile.path, () => {});
    return res.status(status).json({ error });
  };

  const subject = getUserByUsername(body.subjectUsername);
  if (!subject) return fail(404, 'That person does not exist');
  if (subject.id === creditedBy.id) return fail(400, "You can't credit yourself");
  if (!mainFile) return fail(400, 'A photo is required');
  if (containsBlockedContent(body.caption)) return fail(400, 'That caption isn\'t allowed.');
  if (isBlocked(creditedBy.id, subject.id)) return fail(403, "You can't post about this person");

  // Poster-chosen starter award (1-100), gated by the same lifetime
  // MAX_CREDIT_PER_CONTRIBUTOR cap as crowd credit — that cap is what keeps
  // this from being a farming hole now that it's no longer a fixed amount.
  const points = parseInt(body.points, 10);
  const budget = creditBudgetFor(subject.id, creditedBy.id, null);
  if (budget <= 0) {
    return fail(400, `You've already given this person the max ${MAX_CREDIT_PER_CONTRIBUTOR} points`);
  }
  const maxPoints = Math.min(MAX_CREDIT_PER_CONTRIBUTOR, budget);
  if (!Number.isInteger(points) || points < 1 || points > maxPoints) {
    return fail(400, `Points must be between 1 and ${maxPoints}`);
  }

  // Optional: this post fulfills a pending dare. The subject of the post
  // (who's actually in the photo) must be who the dare targeted.
  let dare = null;
  if (body.dareId) {
    dare = db.prepare('SELECT * FROM dares WHERE id = ?').get(body.dareId);
    if (!dare) return fail(404, 'Dare not found');
    if (dare.status !== 'pending') return fail(400, 'That dare was already completed');
    if (dare.target_user_id !== subject.id) return fail(400, 'This dare is for someone else');
  }

  let groupId = null;
  if (visibility === 'group') {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(body.groupId);
    if (!group) return fail(404, 'Group not found');
    if (!isGroupMember(group.id, creditedBy.id)) return fail(403, "You're not in that group");
    if (!isGroupMember(group.id, subject.id)) return fail(400, 'That person is not in this group');
    groupId = group.id;
  }

  let activity = null;
  if (body.activityKey) {
    activity = db.prepare('SELECT * FROM activities WHERE key = ?').get(body.activityKey);
  }

  // Anonymity is only offered on the public feed, not inside smaller trusted
  // groups — enforced server-side regardless of what the client sends.
  const isAnonymous = visibility === 'public' && body.isAnonymous === 'true';

  const info = db.prepare(`
    INSERT INTO posts (subject_user_id, credited_by_user_id, activity_id, visibility, group_id, photo_filename, inset_photo_filename, caption, is_anonymous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(subject.id, creditedBy.id, activity ? activity.id : null, visibility, groupId, mainFile.filename, insetFile ? insetFile.filename : null, body.caption || null, isAnonymous ? 1 : 0);

  // Mirror the photo(s) into durable storage so they can survive the 24h
  // expiry cleanup for Memories — see uploadPhotoToR2's dev-fallback comment.
  // This doesn't block the local-disk copy, which still serves the live feed.
  const photoUrl = await uploadPhotoToR2(mainFile.path, mainFile.filename);
  if (photoUrl) {
    db.prepare('UPDATE posts SET photo_url = ? WHERE id = ?').run(photoUrl, info.lastInsertRowid);
  }
  if (insetFile) {
    const insetPhotoUrl = await uploadPhotoToR2(insetFile.path, insetFile.filename);
    if (insetPhotoUrl) {
      db.prepare('UPDATE posts SET inset_photo_url = ? WHERE id = ?').run(insetPhotoUrl, info.lastInsertRowid);
    }
  }

  // Stored as a post_credits row (awarder = poster) so existing per-post
  // display logic (creditorCount, card totals) needs no rework, and
  // mirrored into the durable ledger so it survives expiry.
  db.prepare('INSERT INTO post_credits (post_id, awarder_user_id, points) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, creditedBy.id, points);
  writeLedgerEntry(subject.id, points, 'tag_starter', info.lastInsertRowid, creditedBy.id);

  updateStreakOnPost(creditedBy.id);

  if (dare) {
    db.prepare(`UPDATE dares SET status = 'completed', completed_post_id = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(info.lastInsertRowid, dare.id);
    // Fixed bonus to both sides — see DARE_BONUS_POINTS comment.
    writeLedgerEntry(dare.issuer_user_id, DARE_BONUS_POINTS, 'dare_bonus', info.lastInsertRowid, dare.target_user_id);
    writeLedgerEntry(dare.target_user_id, DARE_BONUS_POINTS, 'dare_bonus', info.lastInsertRowid, dare.issuer_user_id);
  }

  res.status(201).json(serializePost(getPostRow(info.lastInsertRowid), creditedBy.id));
});

app.post('/api/posts/:postId/credit', requireAuth, requireVerified, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.subject_user_id === user.id) return res.status(400).json({ error: "You can't credit yourself" });
  // The poster already set their own starter credit for this post at
  // creation time — without this check they could re-hit this endpoint
  // and, via the ON CONFLICT upsert below, overwrite that amount up to the
  // max. Crowd credit has to come from someone else.
  if (post.credited_by_user_id === user.id) return res.status(400).json({ error: "You already posted this" });
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return res.status(403).json({ error: "You're not in that group" });
  }

  const points = parseInt((req.body || {}).points, 10);
  const budget = creditBudgetFor(post.subject_user_id, user.id, post.id);
  if (budget <= 0) {
    return res.status(400).json({ error: `You've already given this person the max ${MAX_CREDIT_PER_CONTRIBUTOR} points` });
  }
  const max = Math.min(maxCreditFor(post.visibility), budget);
  if (!Number.isInteger(points) || points < 1 || points > max) {
    return res.status(400).json({ error: `Points must be between 1 and ${max}` });
  }

  db.prepare(`
    INSERT INTO post_credits (post_id, awarder_user_id, points) VALUES (?, ?, ?)
    ON CONFLICT(post_id, awarder_user_id) DO UPDATE SET points = excluded.points
  `).run(post.id, user.id, points);
  writeLedgerEntry(post.subject_user_id, points, 'crowd_credit', post.id, user.id);

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
  // Any emoji is allowed, not just the client's quick-tap set — capped to a
  // short length so this can't be abused as a free-text field.
  const emoji = ((req.body || {}).emoji || '').trim().slice(0, 16);
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

app.post('/api/posts/:postId/comments', requireAuth, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return res.status(403).json({ error: "You're not in that group" });
  }

  const body = ((req.body || {}).body || '').trim().slice(0, 300);
  if (!body) return res.status(400).json({ error: 'Say something first' });
  if (containsBlockedContent(body)) return res.status(400).json({ error: "That comment isn't allowed." });

  db.prepare('INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)').run(post.id, user.id, body);
  res.status(201).json(serializePost(getPostRow(post.id), user.id));
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

// Full, permanent removal — used by admin moderation (report resolve:
// 'remove'/'ban'). Unlike expirePostFromFeeds below, this always deletes the
// row and BOTH copies of the photo (local + R2) regardless of durability,
// since removed content must not keep surviving in someone's Memories.
function deletePostAndFile(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;
  fs.unlink(path.join(uploadsDir, post.photo_filename), () => {});
  if (post.photo_url) deletePhotoFromR2(r2KeyFromUrl(post.photo_url));
  if (post.inset_photo_filename) fs.unlink(path.join(uploadsDir, post.inset_photo_filename), () => {});
  if (post.inset_photo_url) deletePhotoFromR2(r2KeyFromUrl(post.inset_photo_url));
  db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
}

// Called by the 24h auto-expiry sweep (cleanupExpiredPosts), NOT moderation.
// Always frees the local disk copy. If a durable R2 copy exists, the row is
// kept — it's already excluded from public/group feeds via the `expired`
// flag in serializePost, but stays visible to its poster in Memories. If
// there's no durable copy (R2 unconfigured), falls back to today's behavior:
// hard-delete the row, same as deletePostAndFile.
function expirePostFromFeeds(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;
  fs.unlink(path.join(uploadsDir, post.photo_filename), () => {});
  if (post.inset_photo_filename) fs.unlink(path.join(uploadsDir, post.inset_photo_filename), () => {});
  if (!post.photo_url) {
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  }
}

// --- Admin moderation queue ---
// Not a public endpoint — gated behind is_admin (see ADMIN_EMAIL in db.js).
// This is what makes "act on reports within 24h" operationally possible.
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.status, r.created_at,
           reporter.username as reporter_username,
           p.id as post_id, p.photo_filename, p.photo_url, p.caption, p.visibility,
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
    photoUrl: r.photo_url || `/uploads/${r.photo_filename}`,
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
  for (const post of expired) expirePostFromFeeds(post.id);
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
