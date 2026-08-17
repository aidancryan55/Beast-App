const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
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
const EMAIL_CODE_EXPIRY_MS = 10 * 60 * 1000;
const BCRYPT_COST = 12;
// Lifetime cap on how many Beast Points any single contributor can pour into
// one recipient, across every post they've ever credited them on — closes
// the two-friends-mutually-inflate-each-other farming hole that a per-post
// cap alone doesn't stop.
const MAX_CREDIT_PER_CONTRIBUTOR = 100;
// Selfie ("react with your face") reactions must pick one of these — keeps
// the category meaningful, unlike the freeform plain-emoji-tap reaction.
const REACTION_EMOJIS = ['🔥', '😂', '💀', '👑', '🐐'];

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

// --- Sign in with Apple ---
// Apple's public keys rotate; jwks-rsa fetches and caches them by `kid`
// instead of us pinning a static key. APPLE_BUNDLE_ID must match the app's
// real bundle ID (the token's `aud` claim) or a forged/other-app token would
// otherwise verify as valid.
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.aidanryan.beastgame';
const appleJwks = jwksClient({ jwksUri: 'https://appleid.apple.com/auth/keys' });
function getAppleSigningKey(header, callback) {
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}
function verifyAppleIdentityToken(identityToken) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      identityToken,
      getAppleSigningKey,
      { algorithms: ['RS256'], issuer: 'https://appleid.apple.com', audience: APPLE_BUNDLE_ID },
      (err, decoded) => (err ? reject(err) : resolve(decoded))
    );
  });
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

// --- Email verification codes + Resend ---
// Code-based (not link-based) so verification happens inline in the signup
// wizard — the user never has to leave the app to tap a link.
function generateEmailCode() {
  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expires = new Date(Date.now() + EMAIL_CODE_EXPIRY_MS).toISOString();
  return { code, codeHash, expires };
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Catch a Beast <onboarding@resend.dev>';

async function sendVerificationCode(email, code) {
  if (!RESEND_API_KEY) {
    // Dev fallback: no Resend key configured, so log the code instead of emailing it.
    console.log(`[dev] Verification code for ${email}: ${code}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: email,
      subject: 'Your Catch a Beast verification code',
      html: `<p>Your verification code is:</p>
             <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${code}</p>
             <p>This code expires in 10 minutes.</p>`,
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

// Shared cleanup for any stored photo URL (avatar or post photo) — routes
// to local-disk unlink or R2 delete depending on which one produced it.
function deleteStoredPhoto(url) {
  if (!url) return;
  if (url.startsWith('/uploads/')) fs.unlink(path.join(uploadsDir, url.slice('/uploads/'.length)), () => {});
  else deletePhotoFromR2(r2KeyFromUrl(url));
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
  // totalXp and periodTotals read from points_ledger, not post_credits — the
  // ledger is the durable source (see its comment in db.js) and is the only
  // one of the two that survives a post's 24h expiry cascade-delete. Using
  // post_credits here was a bug: it meant totalXp/leaderboard silently
  // dropped as old posts got cleaned up, and dare_wager payouts (ledger-only,
  // no post_credits row) never counted toward a user's total at all.
  const ledgerEntries = db.prepare(`SELECT points, earned_at FROM points_ledger WHERE user_id = ?`).all(userId);
  const totalXp = ledgerEntries.reduce((sum, e) => sum + e.points, 0);
  const levelInfo = levelForXp(totalXp);
  const periodTotals = computePeriodTotals(ledgerEntries.map((e) => ({ points: e.points, earnedAt: e.earned_at })));

  // Badges below are still post_credits-based (distinct posts credited on) —
  // a separate, narrower concern from the totalXp bug above, left as-is.
  const postCredits = db.prepare(`
    SELECT pc.post_id
    FROM post_credits pc
    JOIN posts p ON p.id = pc.post_id
    WHERE p.subject_user_id = ?
  `).all(userId);
  const creditedPostIds = new Set(postCredits.map((c) => c.post_id));

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
// Called whenever a group's creator (moderator) stops being a member —
// leaving or deleting their account. Without this, a private
// approval-gated group is silently left with no one able to approve
// join requests, since isModerator checks created_by_user_id against a
// still-current member. Hands ownership to whoever's been in the group
// longest (excluding the departing user); if no one else is left, the
// group has no pending requests to approve anyway, so NULL is harmless.
function transferGroupOwnershipAwayFrom(userId) {
  const groups = db.prepare('SELECT id FROM groups WHERE created_by_user_id = ?').all(userId);
  for (const g of groups) {
    const next = db.prepare(`
      SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ? ORDER BY joined_at ASC LIMIT 1
    `).get(g.id, userId);
    db.prepare('UPDATE groups SET created_by_user_id = ? WHERE id = ?').run(next ? next.user_id : null, g.id);
  }
}
function hasPendingGroupRequest(groupId, userId) {
  return !!db.prepare('SELECT 1 FROM group_join_requests WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}
function serializeGroup(group, viewerUserId) {
  const memberIds = getGroupMemberIds(group.id);
  const members = memberIds.map((id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username).filter(Boolean);
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    visibility: group.visibility,
    hasPassword: !!group.password_hash,
    memberCount: memberIds.length,
    maxMembers: GROUP_MAX_MEMBERS,
    members,
    isMember: viewerUserId ? memberIds.includes(viewerUserId) : false,
    isModerator: viewerUserId ? viewerUserId === group.created_by_user_id : false,
    hasPendingRequest: viewerUserId ? hasPendingGroupRequest(group.id, viewerUserId) : false,
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

// Lets the signup wizard flag a taken username right on the username step,
// instead of the user only finding out after also typing their email (that
// error used to surface confusingly on the email screen since /signup/start
// was the only place username uniqueness got checked). Read-only, no auth
// needed — username availability isn't sensitive info, it's already public
// on posts/leaderboard.
app.get('/api/username-available', (req, res) => {
  const username = ((req.query.username || '') + '').trim();
  if (!username || !DISPLAY_NAME_RE.test(username)) return res.json({ available: false });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  res.json({ available: !existing });
});

// Signup is a 4-step wizard (real name -> username -> email -> verify code
// -> password), matching the client's onboarding screens one for one. Each
// step below is its own request rather than one big /api/signup call.
// The user row is created at the "start" step with no password_hash yet
// (that column allows NULL) and only becomes a real, usable account once
// "finish" sets the password. That's what a NULL password_hash means
// everywhere else in this file: a signup that was started but never
// completed — safe to overwrite on retry, never valid to log into.
app.post('/api/signup/start', authLimiter, async (req, res) => {
  const body = req.body || {};
  const realName = (body.realName || '').trim().slice(0, 60);
  const username = (body.username || '').trim();
  const email = (body.email || '').trim().toLowerCase();

  if (!realName) return res.status(400).json({ error: 'Enter your name.' });
  if (!username || !DISPLAY_NAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 1-30 characters (letters, numbers, spaces, . \' -).' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const existingByEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existingByEmail && existingByEmail.password_hash) {
    return res.status(409).json({ error: 'That email is already registered. Try logging in.' });
  }
  const existingByUsername = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existingByUsername && (!existingByEmail || existingByUsername.id !== existingByEmail.id)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  const { code, codeHash, expires } = generateEmailCode();
  const isAdmin = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;

  if (existingByEmail) {
    // Re-starting an incomplete signup (e.g. they backed out and changed
    // something) — reuse the same row rather than erroring.
    db.prepare(`
      UPDATE users SET username = ?, real_name = ?, verify_token_hash = ?, verify_token_expires = ?, email_verified = 0
      WHERE id = ?
    `).run(username, realName, codeHash, expires, existingByEmail.id);
  } else {
    db.prepare(`
      INSERT INTO users (username, real_name, email, verify_token_hash, verify_token_expires, is_admin)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, realName, email, codeHash, expires, isAdmin);
  }

  try {
    await sendVerificationCode(email, code);
  } catch (err) {
    console.error('sendVerificationCode failed:', err);
  }

  res.status(201).json({ status: 'code_sent', email });
});

app.post('/api/signup/resend-code', authLimiter, async (req, res) => {
  const email = ((req.body || {}).email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.password_hash) return res.status(404).json({ error: 'Start signup again.' });

  const { code, codeHash, expires } = generateEmailCode();
  db.prepare('UPDATE users SET verify_token_hash = ?, verify_token_expires = ? WHERE id = ?').run(codeHash, expires, user.id);
  try {
    await sendVerificationCode(email, code);
  } catch (err) {
    console.error('sendVerificationCode failed:', err);
  }
  res.json({ status: 'code_sent' });
});

app.post('/api/signup/verify-code', authLimiter, (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.password_hash) return res.status(404).json({ error: 'Start signup again.' });
  if (!user.verify_token_hash) return res.status(400).json({ error: 'Request a new code.' });
  if (!user.verify_token_expires || new Date(user.verify_token_expires) < new Date()) {
    return res.status(400).json({ error: 'That code expired — request a new one.' });
  }
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  if (codeHash !== user.verify_token_hash) return res.status(400).json({ error: 'Incorrect code.' });

  db.prepare('UPDATE users SET email_verified = 1, verify_token_hash = NULL, verify_token_expires = NULL WHERE id = ?').run(user.id);
  res.json({ status: 'verified' });
});

app.post('/api/signup/finish', authLimiter, async (req, res) => {
  const body = req.body || {};
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.password_hash) return res.status(404).json({ error: 'Start signup again.' });
  if (!user.email_verified) return res.status(400).json({ error: 'Verify your email first.' });

  const passwordHash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);

  const token = createSession(user.id);
  res.status(201).json({ displayName: user.username, token, isAdmin: !!user.is_admin, avatarUrl: user.avatar_url || null });
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
  res.json({ displayName: user.username, token, isAdmin: !!user.is_admin, avatarUrl: user.avatar_url || null });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.authToken);
  res.json({ status: 'logged out' });
});

// realName is only ever sent on the very first authorization for a given
// Apple ID — Apple gives the app the user's name exactly once and never
// again, so the client has to capture and forward it right then.
app.post('/api/auth/apple', authLimiter, async (req, res) => {
  const { identityToken, realName } = req.body || {};
  if (!identityToken) return res.status(400).json({ error: 'Missing Apple identity token' });

  let claims;
  try {
    claims = await verifyAppleIdentityToken(identityToken);
  } catch {
    return res.status(401).json({ error: 'Could not verify Apple sign-in' });
  }
  const appleSub = claims.sub;
  const email = (claims.email || '').toLowerCase() || null;

  let user = db.prepare('SELECT * FROM users WHERE apple_sub = ?').get(appleSub);
  if (!user && email) {
    // A real, finished account (has a password) signing in with Apple for
    // the first time — link by verified email rather than making a duplicate.
    const existing = db.prepare('SELECT * FROM users WHERE email = ? AND password_hash IS NOT NULL').get(email);
    if (existing) {
      db.prepare('UPDATE users SET apple_sub = ? WHERE id = ?').run(appleSub, existing.id);
      user = existing;
    }
  }

  if (user) {
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended.', code: 'banned' });
    const token = createSession(user.id);
    return res.json({ displayName: user.username, token, isAdmin: !!user.is_admin, avatarUrl: user.avatar_url || null });
  }

  // Brand new identity — needs a username before an account can exist.
  // Carrying the verified appleSub forward as an opaque server-issued token
  // rather than trusting anything the client sends back for it.
  db.prepare('DELETE FROM pending_apple_signups WHERE apple_sub = ?').run(appleSub); // drop any stale attempt
  const pendingToken = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + EMAIL_CODE_EXPIRY_MS).toISOString();
  db.prepare(`
    INSERT INTO pending_apple_signups (token, apple_sub, email, real_name, expires_at) VALUES (?, ?, ?, ?, ?)
  `).run(pendingToken, appleSub, email, (realName || '').trim().slice(0, 60) || null, expires);
  res.json({ needsUsername: true, pendingToken, suggestedRealName: (realName || '').trim().slice(0, 60) || null });
});

app.post('/api/auth/apple/finish', authLimiter, (req, res) => {
  const body = req.body || {};
  const pendingToken = (body.pendingToken || '').trim();
  const username = (body.username || '').trim();
  const realName = (body.realName || '').trim().slice(0, 60);

  const pending = db.prepare('SELECT * FROM pending_apple_signups WHERE token = ?').get(pendingToken);
  if (!pending) return res.status(400).json({ error: 'That sign-in expired — try again.' });
  if (new Date(pending.expires_at) < new Date()) {
    db.prepare('DELETE FROM pending_apple_signups WHERE id = ?').run(pending.id);
    return res.status(400).json({ error: 'That sign-in expired — try again.' });
  }
  if (!realName) return res.status(400).json({ error: 'Enter your name.' });
  if (!username || !DISPLAY_NAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 1-30 characters (letters, numbers, spaces, . \' -).' });
  }
  const existingByUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingByUsername) return res.status(409).json({ error: 'That username is taken.' });

  const isAdmin = process.env.ADMIN_EMAIL && pending.email === process.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  const info = db.prepare(`
    INSERT INTO users (username, real_name, email, email_verified, apple_sub, is_admin)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run(username, realName, pending.email, pending.apple_sub, isAdmin);
  db.prepare('DELETE FROM pending_apple_signups WHERE id = ?').run(pending.id);

  const token = createSession(info.lastInsertRowid);
  res.json({ displayName: username, token, isAdmin: !!isAdmin, avatarUrl: null });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = req.authUser;
  res.json({ username: user.username, realName: user.real_name || '', bio: user.bio || '', email: user.email, avatarUrl: user.avatar_url || null, hasPassword: !!user.password_hash });
});

app.patch('/api/me/profile', requireAuth, (req, res) => {
  const body = req.body || {};
  const realName = (body.realName || '').trim().slice(0, 60);
  const bio = (body.bio || '').trim().slice(0, 160);
  if (!realName) return res.status(400).json({ error: 'Enter your name.' });
  db.prepare('UPDATE users SET real_name = ?, bio = ? WHERE id = ?').run(realName, bio, req.authUser.id);
  res.json({ realName, bio });
});

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const ok = await verifyPassword(currentPassword || '', req.authUser.password_hash);
  if (!ok) return res.status(401).json({ error: 'Current password is wrong.' });
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const passwordHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.authUser.id);
  res.json({ status: 'updated' });
});

app.post('/api/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  const user = req.authUser;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'A photo is required' });

  const oldAvatarUrl = user.avatar_url;
  const avatarUrl = await uploadPhotoToR2(file.path, file.filename);
  const finalUrl = avatarUrl || `/uploads/${file.filename}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(finalUrl, user.id);

  // Only the local copy needs cleanup when R2 took the upload — if R2 isn't
  // configured, finalUrl points at this same local file, so keep it.
  if (avatarUrl) fs.unlink(file.path, () => {});
  deleteStoredPhoto(oldAvatarUrl);

  res.json({ avatarUrl: finalUrl });
});

// Apple 5.1.1(v): account creation requires in-app account deletion.
app.delete('/api/account', requireAuth, async (req, res) => {
  const user = req.authUser;
  // Apple-only accounts (signed up via Sign in with Apple) have no password
  // to confirm with — their session token already proves who they are, same
  // as every other authenticated action they take.
  if (user.password_hash) {
    const ok = await verifyPassword((req.body || {}).password || '', user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password.' });
  }

  // Hand off group ownership first so deleting your account never cascades
  // into destroying a group other people are still in (see note in db.js),
  // and so private approval-gated groups you moderated don't get stranded
  // with no one able to approve join requests.
  transferGroupOwnershipAwayFrom(user.id);

  const photos = db.prepare(`
    SELECT photo_filename, photo_url, inset_photo_filename, inset_photo_url
    FROM posts WHERE subject_user_id = ? OR credited_by_user_id = ?
  `).all(user.id, user.id);
  const extraPhotos = db.prepare(`
    SELECT pp.photo_filename, pp.photo_url FROM post_photos pp
    JOIN posts p ON p.id = pp.post_id
    WHERE p.subject_user_id = ? OR p.credited_by_user_id = ?
  `).all(user.id, user.id);
  // This user's saved "react with your face" photos (one per emoji category,
  // reused across every post they've reacted to) — owned by this table, not
  // by any individual reaction row, so this is the only place they get cleaned up.
  const reactionPhotos = db.prepare(`
    SELECT photo_filename, photo_url FROM user_reaction_photos WHERE user_id = ?
  `).all(user.id);

  db.prepare('DELETE FROM users WHERE id = ?').run(user.id); // cascades sessions, posts, credits, reactions, comments, reports, blocks, group_members, post_photos, user_reaction_photos

  deleteStoredPhoto(user.avatar_url);

  for (const photo of photos) {
    fs.unlink(path.join(uploadsDir, photo.photo_filename), () => {});
    // Memories (R2) durable copies would otherwise survive account deletion
    // indefinitely — "deletes your posts, photos, and personal data" in the
    // privacy policy has to mean this too, not just the local/ephemeral copy.
    if (photo.photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.photo_url));
    if (photo.inset_photo_filename) fs.unlink(path.join(uploadsDir, photo.inset_photo_filename), () => {});
    if (photo.inset_photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.inset_photo_url));
  }
  for (const photo of extraPhotos) {
    fs.unlink(path.join(uploadsDir, photo.photo_filename), () => {});
    if (photo.photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.photo_url));
  }
  for (const photo of reactionPhotos) {
    fs.unlink(path.join(uploadsDir, photo.photo_filename), () => {});
    if (photo.photo_url) deletePhotoFromR2(r2KeyFromUrl(photo.photo_url));
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
  res.json({ ...computeUserStats(user.id), avatarUrl: user.avatar_url || null, friendCount: friendCount(user.id) });
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
    subjectDisplayName: r.subject_display_name || null,
    activityName: r.activity_name || null,
    activityIcon: r.activity_icon || null,
  }));
  res.json(memories);
});

// --- Beast Dares ---
// Issue → fulfill via a post → the wager the issuer staked pays out to the
// target. No premade dare content/templates, no notifications yet.
app.post('/api/dares', requireAuth, requireVerified, (req, res) => {
  const body = req.body || {};
  const target = getUserByUsername(body.targetUsername);
  if (!target) return res.status(404).json({ error: 'That person does not exist' });
  if (target.id === req.authUser.id) return res.status(400).json({ error: "You can't dare yourself" });
  if (isBlocked(req.authUser.id, target.id)) return res.status(403).json({ error: "You can't dare this person" });

  const description = ((body.description || '').trim()).slice(0, 200);
  if (!description) return res.status(400).json({ error: 'Say what the dare is.' });
  if (containsBlockedContent(description)) return res.status(400).json({ error: "That dare isn't allowed." });

  // The wager comes out of the same lifetime budget as crowd credit and the
  // starter award — otherwise dares would be a backdoor around
  // MAX_CREDIT_PER_CONTRIBUTOR for two people trading points back and forth.
  const wager = parseInt(body.wager, 10);
  const budget = creditBudgetFor(target.id, req.authUser.id, null);
  if (budget <= 0) {
    return res.status(400).json({ error: `You've already given this person the max ${MAX_CREDIT_PER_CONTRIBUTOR} points` });
  }
  const maxWager = Math.min(MAX_CREDIT_PER_CONTRIBUTOR, budget);
  if (!Number.isInteger(wager) || wager < 1 || wager > maxWager) {
    return res.status(400).json({ error: `Wager must be between 1 and ${maxWager}` });
  }

  const info = db.prepare('INSERT INTO dares (issuer_user_id, target_user_id, description, wager_points) VALUES (?, ?, ?, ?)')
    .run(req.authUser.id, target.id, description, wager);
  res.status(201).json({ id: info.lastInsertRowid, status: 'pending', wagerPoints: wager });
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
    wagerPoints: r.wager_points,
    status: r.status,
    issuerUsername: r.issuer_username,
    targetUsername: r.target_username,
    isIssuedByMe: r.issuer_user_id === req.authUser.id,
    createdAt: r.created_at,
  })));
});

// --- Leaderboard ---
app.get('/api/leaderboard', (req, res) => {
  // Exclude signups that were started but never finished (no password set
  // and no Apple sign-in linked) — they're not real, usable accounts, just
  // claimed usernames.
  const users = db.prepare('SELECT id, username, avatar_url FROM users WHERE password_hash IS NOT NULL OR apple_sub IS NOT NULL').all();
  const board = users
    .map((u) => {
      const stats = computeUserStats(u.id);
      return {
        username: u.username,
        avatarUrl: u.avatar_url || null,
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
    SELECT username FROM users WHERE username LIKE ? AND id != ? AND (password_hash IS NOT NULL OR apple_sub IS NOT NULL) LIMIT 10
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

// --- Muting (soft, silent, one-directional — see mutes table comment in db.js) ---
function getMutedUserIds(userId) {
  return db.prepare('SELECT muted_user_id FROM mutes WHERE muter_user_id = ?').all(userId).map((r) => r.muted_user_id);
}

app.get('/api/users/:username/muted', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.username FROM mutes m JOIN users u ON u.id = m.muted_user_id WHERE m.muter_user_id = ?
  `).all(req.authUser.id);
  res.json(rows.map((r) => r.username));
});

app.post('/api/users/:username/mute', requireAuth, (req, res) => {
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  if (target.id === req.authUser.id) return res.status(400).json({ error: "You can't mute yourself" });
  db.prepare('INSERT OR IGNORE INTO mutes (muter_user_id, muted_user_id) VALUES (?, ?)').run(req.authUser.id, target.id);
  res.json({ status: 'muted' });
});

app.post('/api/users/:username/unmute', requireAuth, (req, res) => {
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  db.prepare('DELETE FROM mutes WHERE muter_user_id = ? AND muted_user_id = ?').run(req.authUser.id, target.id);
  res.json({ status: 'unmuted' });
});

// --- Friends ---
// Reuses the `friendships` table that's been in the schema since the old
// friend-graph feature, but was unused after that feature was replaced by
// Groups + the public Discover feed — the (requester_id, addressee_id,
// status) shape already fits a request/accept model, so no migration needed.
function friendRowBetween(userIdA, userIdB) {
  return db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(userIdA, userIdB, userIdB, userIdA);
}
function friendCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) as n FROM friendships
    WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
  `).get(userId, userId).n;
}
function friendIdsOf(userId) {
  return db.prepare(`
    SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END as friend_id
    FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
  `).all(userId, userId, userId).map((r) => r.friend_id);
}
function serializeFriendUser(user) {
  return { username: user.username, avatarUrl: user.avatar_url || null };
}

app.get('/api/me/friends', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.* FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END)
    WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)
    ORDER BY u.username COLLATE NOCASE
  `).all(req.authUser.id, req.authUser.id, req.authUser.id);
  res.json(rows.map(serializeFriendUser));
});

// "People you may know" — anyone who's a friend of one of your friends but
// not already your friend (or a pending request either way). Ranked by how
// many of your friends they have in common, most mutual friends first.
app.get('/api/me/friend-suggestions', requireAuth, (req, res) => {
  const myId = req.authUser.id;
  const myFriendIds = friendIdsOf(myId);
  const hidden = new Set(getHiddenUserIds(myId));

  const mutualCounts = new Map();
  for (const friendId of myFriendIds) {
    for (const fofId of friendIdsOf(friendId)) {
      if (fofId === myId || hidden.has(fofId)) continue;
      mutualCounts.set(fofId, (mutualCounts.get(fofId) || 0) + 1);
    }
  }

  const ranked = [...mutualCounts.entries()].sort((a, b) => b[1] - a[1]);
  const results = [];
  for (const [candidateId, mutualFriends] of ranked) {
    if (results.length >= 20) break;
    if (friendRowBetween(myId, candidateId)) continue; // already friends, or a request is pending either way
    const user = db.prepare('SELECT username, avatar_url FROM users WHERE id = ? AND (password_hash IS NOT NULL OR apple_sub IS NOT NULL) AND banned = 0').get(candidateId);
    if (!user) continue;
    results.push({ username: user.username, avatarUrl: user.avatar_url || null, mutualFriends });
  }
  res.json(results);
});

// Limited public view of someone who isn't (yet) your friend — reachable from
// search/suggestions/discover. Never exposes private posts/memories, only
// aggregate stats that are already public via the leaderboard.
app.get('/api/users/:username/public-profile', requireAuth, (req, res) => {
  const target = getUserByUsername(req.params.username);
  if (!target || !target.password_hash) return res.status(404).json({ error: 'User not found' });
  if (isBlocked(req.authUser.id, target.id)) return res.status(404).json({ error: 'User not found' });

  const stats = computeUserStats(target.id);
  const friendRow = req.authUser.id === target.id ? null : friendRowBetween(req.authUser.id, target.id);
  res.json({
    username: target.username,
    avatarUrl: target.avatar_url || null,
    bio: target.bio || '',
    totalXp: stats.totalXp,
    level: stats.levelInfo.level,
    title: stats.levelInfo.title,
    creditedPostCount: stats.creditedPostCount,
    badgeCount: stats.badges.length,
    friendCount: friendCount(target.id),
    isSelf: req.authUser.id === target.id,
    friendStatus: !friendRow ? 'none' : (friendRow.status === 'accepted' ? 'friends' : (friendRow.requester_id === req.authUser.id ? 'requested' : 'incoming')),
    friendRequestId: friendRow && friendRow.status !== 'accepted' ? friendRow.id : null,
  });
});

app.get('/api/me/friend-requests', requireAuth, (req, res) => {
  const incoming = db.prepare(`
    SELECT f.id, u.username, u.avatar_url FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.authUser.id);
  const outgoing = db.prepare(`
    SELECT f.id, u.username, u.avatar_url FROM friendships f
    JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.authUser.id);
  res.json({
    incoming: incoming.map((r) => ({ id: r.id, username: r.username, avatarUrl: r.avatar_url || null })),
    outgoing: outgoing.map((r) => ({ id: r.id, username: r.username, avatarUrl: r.avatar_url || null })),
  });
});

app.post('/api/friends/request', requireAuth, (req, res) => {
  const target = getUserByUsername((req.body || {}).targetUsername);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  if (target.id === req.authUser.id) return res.status(400).json({ error: "You can't friend yourself" });
  if (isBlocked(req.authUser.id, target.id)) return res.status(403).json({ error: "You can't friend this person" });

  const existing = friendRowBetween(req.authUser.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends' });
    if (existing.requester_id === req.authUser.id) return res.status(400).json({ error: 'Request already sent' });
    // They already sent one your way — this makes it mutual, so just accept it.
    db.prepare(`UPDATE friendships SET status = 'accepted' WHERE id = ?`).run(existing.id);
    return res.json({ status: 'accepted' });
  }

  db.prepare(`INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')`).run(req.authUser.id, target.id);
  res.status(201).json({ status: 'requested' });
});

app.post('/api/friends/requests/:id/respond', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id);
  if (!request || request.addressee_id !== req.authUser.id || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found' });
  }
  const action = (req.body || {}).action;
  if (action === 'accept') {
    db.prepare(`UPDATE friendships SET status = 'accepted' WHERE id = ?`).run(request.id);
    return res.json({ status: 'accepted' });
  }
  if (action === 'decline') {
    db.prepare('DELETE FROM friendships WHERE id = ?').run(request.id);
    return res.json({ status: 'declined' });
  }
  res.status(400).json({ error: "action must be 'accept' or 'decline'" });
});

app.delete('/api/friends/requests/:id', requireAuth, (req, res) => {
  const request = db.prepare('SELECT * FROM friendships WHERE id = ?').get(req.params.id);
  if (!request || request.requester_id !== req.authUser.id || request.status !== 'pending') {
    return res.status(404).json({ error: 'Request not found' });
  }
  db.prepare('DELETE FROM friendships WHERE id = ?').run(request.id);
  res.json({ status: 'cancelled' });
});

app.delete('/api/friends/:username', requireAuth, (req, res) => {
  const target = getUserByUsername(req.params.username);
  if (!target) return res.status(404).json({ error: 'That user does not exist' });
  const existing = friendRowBetween(req.authUser.id, target.id);
  if (!existing || existing.status !== 'accepted') return res.status(404).json({ error: 'Not friends' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(existing.id);
  res.json({ status: 'removed' });
});

// --- Direct messages (1:1, friends-only) ---
function getConversation(userIdA, userIdB) {
  const a = Math.min(userIdA, userIdB);
  const b = Math.max(userIdA, userIdB);
  return db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(a, b);
}
function getOrCreateConversation(userIdA, userIdB) {
  const a = Math.min(userIdA, userIdB);
  const b = Math.max(userIdA, userIdB);
  db.prepare('INSERT OR IGNORE INTO conversations (user_a_id, user_b_id) VALUES (?, ?)').run(a, b);
  return db.prepare('SELECT * FROM conversations WHERE user_a_id = ? AND user_b_id = ?').get(a, b);
}

app.get('/api/conversations', requireAuth, (req, res) => {
  const myId = req.authUser.id;
  const rows = db.prepare(`
    SELECT c.id, u.username, u.avatar_url,
           (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_body,
           (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_at,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND sender_id != ? AND read_at IS NULL) as unread
    FROM conversations c
    JOIN users u ON u.id = (CASE WHEN c.user_a_id = ? THEN c.user_b_id ELSE c.user_a_id END)
    WHERE c.user_a_id = ? OR c.user_b_id = ?
  `).all(myId, myId, myId, myId);
  const conversations = rows
    .filter((r) => r.last_at) // hide empty conversations (created but nothing sent yet)
    .map((r) => ({
      username: r.username,
      avatarUrl: r.avatar_url || null,
      lastBody: r.last_body,
      lastAt: r.last_at,
      unread: r.unread,
    }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  res.json(conversations);
});

app.get('/api/conversations/:username/messages', requireAuth, (req, res) => {
  const other = getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const friendRow = friendRowBetween(req.authUser.id, other.id);
  if (!friendRow || friendRow.status !== 'accepted') return res.status(403).json({ error: 'You can only message friends' });
  if (isBlocked(req.authUser.id, other.id)) return res.status(403).json({ error: 'You can\'t message this person' });

  const convo = getConversation(req.authUser.id, other.id);
  if (!convo) return res.json([]);

  db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL`)
    .run(convo.id, req.authUser.id);

  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200').all(convo.id);
  res.json(rows.map((m) => ({
    id: m.id,
    body: m.body,
    fromMe: m.sender_id === req.authUser.id,
    createdAt: m.created_at,
  })));
});

app.post('/api/conversations/:username/messages', requireAuth, requireVerified, (req, res) => {
  const other = getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (other.id === req.authUser.id) return res.status(400).json({ error: "You can't message yourself" });
  const friendRow = friendRowBetween(req.authUser.id, other.id);
  if (!friendRow || friendRow.status !== 'accepted') return res.status(403).json({ error: 'You can only message friends' });
  if (isBlocked(req.authUser.id, other.id)) return res.status(403).json({ error: "You can't message this person" });

  const body = ((req.body || {}).body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  if (containsBlockedContent(body)) return res.status(400).json({ error: "That message isn't allowed." });

  const convo = getOrCreateConversation(req.authUser.id, other.id);
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, body) VALUES (?, ?, ?)').run(convo.id, req.authUser.id, body);
  res.status(201).json({ id: info.lastInsertRowid, body, fromMe: true, createdAt: new Date().toISOString() });
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

app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, description, password } = req.body || {};
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public';
  if (!name || !name.trim() || name.trim().length > 40) {
    return res.status(400).json({ error: 'Group name must be 1-40 characters' });
  }
  if (visibility === 'private' && password && password.length < 4) {
    return res.status(400).json({ error: 'Group password must be at least 4 characters' });
  }
  const passwordHash = visibility === 'private' && password ? await hashPassword(password) : null;

  const info = db.prepare(`
    INSERT INTO groups (name, description, visibility, password_hash, created_by_user_id) VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), (description || '').trim() || null, visibility, passwordHash, req.authUser.id);
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, req.authUser.id);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(serializeGroup(group, req.authUser.id));
});

// Three ways in, depending on how the group was set up:
//  - public: joins immediately, no barrier.
//  - private + password set: joins immediately if the password matches.
//  - private + no password: creates a pending request the moderator
//    (creator) has to approve — see /requests endpoints below.
app.post('/api/groups/:groupId/join', requireAuth, async (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (isGroupMember(group.id, req.authUser.id)) return res.status(400).json({ error: 'Already in this group' });
  if (getGroupMemberIds(group.id).length >= GROUP_MAX_MEMBERS) {
    return res.status(400).json({ error: `This group is full (max ${GROUP_MAX_MEMBERS})` });
  }

  if (group.visibility === 'private' && group.password_hash) {
    const ok = await verifyPassword((req.body || {}).password || '', group.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
  } else if (group.visibility === 'private') {
    if (hasPendingGroupRequest(group.id, req.authUser.id)) {
      return res.status(400).json({ error: 'Request already sent' });
    }
    db.prepare('INSERT INTO group_join_requests (group_id, user_id) VALUES (?, ?)').run(group.id, req.authUser.id);
    return res.status(201).json({ status: 'requested', group: serializeGroup(group, req.authUser.id) });
  }

  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, req.authUser.id);
  res.json({ status: 'joined', group: serializeGroup(group, req.authUser.id) });
});

app.delete('/api/groups/:groupId/request', requireAuth, (req, res) => {
  db.prepare('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?').run(req.params.groupId, req.authUser.id);
  res.json({ status: 'cancelled' });
});

app.get('/api/groups/:groupId/requests', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.created_by_user_id !== req.authUser.id) return res.status(403).json({ error: 'Only the moderator can view requests' });
  const rows = db.prepare(`
    SELECT r.user_id, u.username FROM group_join_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.group_id = ? ORDER BY r.created_at ASC
  `).all(group.id);
  res.json(rows.map((r) => ({ userId: r.user_id, username: r.username })));
});

app.post('/api/groups/:groupId/requests/:userId/respond', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.created_by_user_id !== req.authUser.id) return res.status(403).json({ error: 'Only the moderator can respond to requests' });
  const request = db.prepare('SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ?').get(group.id, req.params.userId);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  const action = (req.body || {}).action;
  db.prepare('DELETE FROM group_join_requests WHERE id = ?').run(request.id);
  if (action === 'approve') {
    if (getGroupMemberIds(group.id).length >= GROUP_MAX_MEMBERS) {
      return res.status(400).json({ error: `This group is full (max ${GROUP_MAX_MEMBERS})` });
    }
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, request.user_id);
    return res.json({ status: 'approved' });
  }
  if (action === 'decline') return res.json({ status: 'declined' });
  res.status(400).json({ error: "action must be 'approve' or 'decline'" });
});

app.post('/api/groups/:groupId/leave', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group.id, req.authUser.id);
  if (group.created_by_user_id === req.authUser.id) transferGroupOwnershipAwayFrom(req.authUser.id);
  res.json({ status: 'left' });
});

// --- Posts (photo-credited Beast Points) ---
const POST_JOIN_SQL = `
  SELECT p.*, su.username as subject_username, cu.username as credited_by_username,
         cu.avatar_url as credited_by_avatar_url,
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
// Per-give ceiling, same 1-100 range as the poster's own starter award —
// the real backstop against farming is MAX_CREDIT_PER_CONTRIBUTOR below,
// not a visibility-based split, so public and group posts share this cap.
function maxCreditFor() {
  return MAX_CREDIT_PER_CONTRIBUTOR;
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
  // Selfie ("react with your face") reactions, individually — rendered as
  // small circular photo bubbles instead of folded into the emoji counts
  // above. Resolved by joining to the reactor's saved photo for that emoji
  // category (user_reaction_photos), not stored on the reaction itself —
  // reacting with a category you've set a face for IS reacting with your
  // face, so this only returns rows where that's true.
  const reactionSelfies = db.prepare(`
    SELECT r.emoji, urp.photo_filename, urp.photo_url, u.username FROM reactions r
    JOIN users u ON u.id = r.user_id
    JOIN user_reaction_photos urp ON urp.user_id = r.user_id AND urp.emoji = r.emoji
    WHERE r.post_id = ?
    ORDER BY r.created_at ASC
  `).all(row.id).map((r) => ({
    emoji: r.emoji,
    username: r.username,
    photoUrl: r.photo_url || `/uploads/${r.photo_filename}`,
  }));
  const myReaction = viewerUserId
    ? db.prepare(`
        SELECT r.emoji, urp.photo_filename FROM reactions r
        LEFT JOIN user_reaction_photos urp ON urp.user_id = r.user_id AND urp.emoji = r.emoji
        WHERE r.post_id = ? AND r.user_id = ?
      `).get(row.id, viewerUserId)
    : null;
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, u.username FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(row.id).map((c) => ({ id: c.id, username: c.username, body: c.body, createdAt: c.created_at }));
  const totalPoints = db.prepare('SELECT COALESCE(SUM(points), 0) as total FROM post_credits WHERE post_id = ?').get(row.id).total;
  const creditorCount = db.prepare('SELECT COUNT(*) as n FROM post_credits WHERE post_id = ?').get(row.id).n;
  const myCreditRow = viewerUserId
    ? db.prepare(`
        SELECT pc.points, u.username as subject_username FROM post_credits pc
        LEFT JOIN users u ON u.id = pc.subject_user_id
        WHERE pc.post_id = ? AND pc.awarder_user_id = ?
      `).get(row.id, viewerUserId)
    : null;
  const isStranger = !!row.subject_display_name;
  const maxCredit = isStranger
    ? maxCreditFor()
    : viewerUserId
      ? Math.max(0, Math.min(maxCreditFor(), creditBudgetFor(row.subject_user_id, viewerUserId, row.id)))
      : maxCreditFor();
  const createdAtMs = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
  const expired = !row.saved && Date.now() - createdAtMs > POST_EXPIRY_MS;

  const isAnonymous = !!row.is_anonymous;
  const extraPhotoUrls = db.prepare('SELECT photo_filename, photo_url FROM post_photos WHERE post_id = ? ORDER BY position ASC')
    .all(row.id).map((p) => p.photo_url || `/uploads/${p.photo_filename}`);
  const additionalSubjects = db.prepare(`
    SELECT u.username, u.avatar_url FROM post_additional_subjects pas
    JOIN users u ON u.id = pas.user_id
    WHERE pas.post_id = ?
  `).all(row.id).map((u) => ({ username: u.username, avatarUrl: u.avatar_url || null }));

  return {
    id: row.id,
    subjectUsername: row.subject_username,
    subjectDisplayName: row.subject_display_name || null,
    additionalSubjects,
    creditedByUsername: isAnonymous ? 'Anonymous' : row.credited_by_username,
    creditedByAvatarUrl: isAnonymous ? null : (row.credited_by_avatar_url || null),
    isAnonymous,
    activityKey: row.activity_key || null,
    activityName: row.activity_name || null,
    activityIcon: row.activity_icon || null,
    visibility: row.visibility,
    groupId: row.group_id || null,
    groupName: row.group_name || null,
    points: totalPoints,
    creditorCount,
    myCredit: myCreditRow ? myCreditRow.points : null,
    myCreditSubjectUsername: myCreditRow ? myCreditRow.subject_username : null,
    maxCredit,
    caption: row.caption,
    saved: !!row.saved,
    photoUrl: row.photo_url || `/uploads/${row.photo_filename}`,
    insetPhotoUrl: row.inset_photo_url || (row.inset_photo_filename ? `/uploads/${row.inset_photo_filename}` : null),
    extraPhotoUrls,
    createdAt: row.created_at,
    expiresAt: new Date(createdAtMs + POST_EXPIRY_MS).toISOString(),
    expired,
    reactions,
    reactionSelfies,
    myReaction: myReaction ? myReaction.emoji : null,
    myReactionIsSelfie: !!(myReaction && myReaction.photo_filename),
    comments,
  };
}

// Extra carousel photos, max 4 — capped well below multer's per-file size
// limit's blast radius, and matches what the composer UI offers.
const MAX_EXTRA_PHOTOS = 4;
// Extra tagged people beyond the primary subject — 4 tagged total including them.
const MAX_ADDITIONAL_SUBJECTS = 3;

app.post('/api/posts', requireAuth, requireVerified, upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'insetPhoto', maxCount: 1 }, { name: 'extraPhotos', maxCount: MAX_EXTRA_PHOTOS }]), async (req, res) => {
  const creditedBy = req.authUser;
  const body = req.body || {};
  const visibility = body.visibility === 'group' ? 'group' : 'public';
  const mainFile = req.files?.photo?.[0];
  const insetFile = req.files?.insetPhoto?.[0];
  const extraFiles = req.files?.extraPhotos || [];

  const fail = (status, error) => {
    if (mainFile) fs.unlink(mainFile.path, () => {});
    if (insetFile) fs.unlink(insetFile.path, () => {});
    for (const f of extraFiles) fs.unlink(f.path, () => {});
    return res.status(status).json({ error });
  };

  // "Random stranger" mode: no real account behind the subject, just a
  // free-text name/description — for catching someone who may not even
  // have the app. Only makes sense on the public feed; group posts need a
  // real member since the group itself is a list of real accounts.
  const strangerName = ((body.subjectDisplayName || '').trim()).slice(0, 60);
  const isStranger = !!strangerName;
  if (isStranger && visibility === 'group') return fail(400, 'Group posts need a real member tagged, not a stranger');
  if (isStranger && containsBlockedContent(strangerName)) return fail(400, "That name isn't allowed.");

  let subject;
  if (isStranger) {
    subject = creditedBy; // placeholder to satisfy subject_user_id NOT NULL — never a real recipient, see subject_display_name
  } else {
    subject = getUserByUsername(body.subjectUsername);
    if (!subject) return fail(404, 'That person does not exist');
    // Self-tagging is only allowed inside groups — a small trusted circle,
    // and the starter points below are display-only there (never written to
    // the ledger) specifically so this can't be used to farm real points.
    if (subject.id === creditedBy.id && visibility !== 'group') return fail(400, "You can't credit yourself");
  }
  const isSelfPost = !isStranger && subject.id === creditedBy.id;
  if (!mainFile) return fail(400, 'A photo is required');
  if (containsBlockedContent(body.caption)) return fail(400, 'That caption isn\'t allowed.');
  if (!isStranger && !isSelfPost && isBlocked(creditedBy.id, subject.id)) return fail(403, "You can't post about this person");

  // Poster-chosen starter award (1-100), gated by the same lifetime
  // MAX_CREDIT_PER_CONTRIBUTOR cap as crowd credit — that cap is what keeps
  // this from being a farming hole now that it's no longer a fixed amount.
  // Stranger posts skip this entirely: there's no real account to award
  // points to, and letting the poster claim them instead would reopen the
  // exact self-farming hole this whole design exists to close. Self-posts
  // (group-only) DO get a poster-chosen starter number — it shows on the
  // card — but it's never written to the ledger (see below), so it can't
  // inflate the poster's real total; only other members' crowd credit does.
  let points = 0;
  if (!isStranger) {
    points = parseInt(body.points, 10);
    if (isSelfPost) {
      if (!Number.isInteger(points) || points < 1 || points > MAX_CREDIT_PER_CONTRIBUTOR) {
        return fail(400, `Points must be between 1 and ${MAX_CREDIT_PER_CONTRIBUTOR}`);
      }
    } else {
      const budget = creditBudgetFor(subject.id, creditedBy.id, null);
      if (budget <= 0) {
        return fail(400, `You've already given this person the max ${MAX_CREDIT_PER_CONTRIBUTOR} points`);
      }
      const maxPoints = Math.min(MAX_CREDIT_PER_CONTRIBUTOR, budget);
      if (!Number.isInteger(points) || points < 1 || points > maxPoints) {
        return fail(400, `Points must be between 1 and ${maxPoints}`);
      }
    }
  }

  // Optional: this post fulfills a pending dare. The subject of the post
  // (who's actually in the photo) must be who the dare targeted — not
  // possible for a stranger post since there's no real target to match.
  let dare = null;
  if (body.dareId && !isStranger) {
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

  // Tag up to MAX_ADDITIONAL_SUBJECTS more real people beyond the primary
  // subject — never on stranger or self posts (see isSelfPost/isStranger
  // above). Invalid entries (duplicate, blocked, not a real account, not in
  // the group) are silently dropped rather than failing the whole post —
  // this is a nice-to-have add-on, not something worth blocking a post over.
  const additionalSubjects = [];
  if (!isStranger && !isSelfPost) {
    const rawAdditional = Array.isArray(body.additionalSubjects)
      ? body.additionalSubjects
      : (body.additionalSubjects ? [body.additionalSubjects] : []);
    const seen = new Set([subject.id, creditedBy.id]);
    for (const uname of rawAdditional.slice(0, MAX_ADDITIONAL_SUBJECTS)) {
      const u = getUserByUsername(uname);
      if (!u || seen.has(u.id) || isBlocked(creditedBy.id, u.id)) continue;
      if (visibility === 'group' && !isGroupMember(groupId, u.id)) continue;
      seen.add(u.id);
      additionalSubjects.push(u);
    }
  }

  let activity = null;
  if (body.activityKey) {
    activity = db.prepare('SELECT * FROM activities WHERE key = ?').get(body.activityKey);
  }

  // Anonymity is only offered on the public feed, not inside smaller trusted
  // groups — enforced server-side regardless of what the client sends.
  const isAnonymous = visibility === 'public' && body.isAnonymous === 'true';

  const info = db.prepare(`
    INSERT INTO posts (subject_user_id, credited_by_user_id, activity_id, visibility, group_id, photo_filename, inset_photo_filename, subject_display_name, caption, is_anonymous)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(subject.id, creditedBy.id, activity ? activity.id : null, visibility, groupId, mainFile.filename, insetFile ? insetFile.filename : null, isStranger ? strangerName : null, body.caption || null, isAnonymous ? 1 : 0);

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
  for (let i = 0; i < extraFiles.length; i++) {
    const f = extraFiles[i];
    const extraUrl = await uploadPhotoToR2(f.path, f.filename);
    db.prepare('INSERT INTO post_photos (post_id, photo_filename, photo_url, position) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, f.filename, extraUrl || null, i);
  }
  for (const u of additionalSubjects) {
    db.prepare('INSERT INTO post_additional_subjects (post_id, user_id) VALUES (?, ?)').run(info.lastInsertRowid, u.id);
  }

  // Stored as a post_credits row (awarder = poster) so existing per-post
  // display logic (creditorCount, card totals) needs no rework, and
  // mirrored into the durable ledger so it survives expiry. Skipped
  // entirely for stranger posts — no real recipient, see the isStranger
  // check above. For self-posts the post_credits row still lands (so the
  // card shows the starter number), but the ledger write is skipped — the
  // whole point of self-posts being display-only for the poster's own
  // starter amount; only other members' later crowd credit is real.
  if (!isStranger) {
    db.prepare('INSERT INTO post_credits (post_id, awarder_user_id, subject_user_id, points) VALUES (?, ?, ?, ?)')
      .run(info.lastInsertRowid, creditedBy.id, subject.id, points);
    if (!isSelfPost) {
      writeLedgerEntry(subject.id, points, 'tag_starter', info.lastInsertRowid, creditedBy.id);
    }
  }

  updateStreakOnPost(creditedBy.id);

  if (dare) {
    db.prepare(`UPDATE dares SET status = 'completed', completed_post_id = ?, completed_at = datetime('now') WHERE id = ?`)
      .run(info.lastInsertRowid, dare.id);
    // Pay the wager the issuer staked when they proposed the dare. Re-clamped
    // against the issuer's current lifetime budget toward the target (rather
    // than trusting the amount validated at issue time), in case other
    // point-giving between them since then already ate into that budget.
    const payout = Math.min(dare.wager_points, Math.max(0, creditBudgetFor(dare.target_user_id, dare.issuer_user_id, null)));
    if (payout > 0) {
      writeLedgerEntry(dare.target_user_id, payout, 'dare_wager', info.lastInsertRowid, dare.issuer_user_id);
    }
  }

  res.status(201).json(serializePost(getPostRow(info.lastInsertRowid), creditedBy.id));
});

app.post('/api/posts/:postId/credit', requireAuth, requireVerified, (req, res) => {
  const user = req.authUser;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const isStranger = !!post.subject_display_name;

  // Multi-tag posts let the crowd choose which tagged person their credit
  // goes to. Once you've credited someone specific on a post, re-hitting
  // this endpoint (to adjust the amount) can only ever apply to that same
  // person — retargeting an existing credit to someone else would silently
  // move points between two different people's ledgers (points_ledger has
  // no per-recipient uniqueness within a post, only per-contributor), so
  // the target is locked in on the first credit and ignored after that.
  const existingCredit = db.prepare('SELECT subject_user_id FROM post_credits WHERE post_id = ? AND awarder_user_id = ?').get(post.id, user.id);
  let subjectUserId = post.subject_user_id;
  if (existingCredit && existingCredit.subject_user_id) {
    subjectUserId = existingCredit.subject_user_id;
  } else if (!isStranger && (req.body || {}).subjectUsername) {
    const chosen = getUserByUsername(req.body.subjectUsername);
    const isPrimary = chosen && chosen.id === post.subject_user_id;
    const isAdditional = chosen && !isPrimary
      && !!db.prepare('SELECT 1 FROM post_additional_subjects WHERE post_id = ? AND user_id = ?').get(post.id, chosen.id);
    if (!chosen || (!isPrimary && !isAdditional)) return res.status(400).json({ error: 'That person is not tagged on this post' });
    subjectUserId = chosen.id;
  }

  if (subjectUserId === user.id) return res.status(400).json({ error: "You can't credit yourself" });
  // The poster already set their own starter credit for this post at
  // creation time — without this check they could re-hit this endpoint
  // and, via the ON CONFLICT upsert below, overwrite that amount up to the
  // max. Crowd credit has to come from someone else.
  if (post.credited_by_user_id === user.id) return res.status(400).json({ error: "You already posted this" });
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return res.status(403).json({ error: "You're not in that group" });
  }

  // "Random stranger" posts (see subject_display_name) have no real account
  // behind the subject — subject_user_id is just the poster's own id, a
  // placeholder. Crediting one still bumps the post's own displayed total
  // (people can throw points at it for fun), but skips the lifetime-budget
  // check and the ledger write entirely, since there's no real recipient
  // for those points to land on. Writing them to subject_user_id's ledger
  // would silently hand the poster free points for tagging a made-up name.
  const points = parseInt((req.body || {}).points, 10);
  let max = maxCreditFor();
  if (!isStranger) {
    const budget = creditBudgetFor(subjectUserId, user.id, post.id);
    if (budget <= 0) {
      return res.status(400).json({ error: `You've already given this person the max ${MAX_CREDIT_PER_CONTRIBUTOR} points` });
    }
    max = Math.min(max, budget);
  }
  if (!Number.isInteger(points) || points < 1 || points > max) {
    return res.status(400).json({ error: `Points must be between 1 and ${max}` });
  }

  db.prepare(`
    INSERT INTO post_credits (post_id, awarder_user_id, subject_user_id, points) VALUES (?, ?, ?, ?)
    ON CONFLICT(post_id, awarder_user_id) DO UPDATE SET
      points = excluded.points,
      subject_user_id = COALESCE(post_credits.subject_user_id, excluded.subject_user_id)
  `).run(post.id, user.id, subjectUserId, points);
  if (!isStranger) {
    writeLedgerEntry(subjectUserId, points, 'crowd_credit', post.id, user.id);
  }

  res.json(serializePost(getPostRow(post.id), user.id));
});

// Discover: every public post, unfiltered by friendship.
app.get('/api/users/:username/discover', (req, res) => {
  const user = getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hidden = new Set(getHiddenUserIds(user.id));
  const muted = new Set(getMutedUserIds(user.id));
  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'public'
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all();

  // BLF ranks by current point total (highest first), not just recency — the
  // sort is stable, so equal-point posts still fall back to newest-first
  // since that's the order they arrived in from the query above.
  const posts = rows
    .filter((r) => !hidden.has(r.subject_user_id) && !hidden.has(r.credited_by_user_id) && !muted.has(r.credited_by_user_id))
    .map((r) => serializePost(r, user.id))
    .filter((p) => !p.expired)
    .sort((a, b) => b.points - a.points);
  res.json(posts);
});

// Group feed: posts scoped to one group, members only.
app.get('/api/groups/:groupId/feed', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!isGroupMember(group.id, req.authUser.id)) return res.status(403).json({ error: "You're not in that group" });

  const hidden = new Set(getHiddenUserIds(req.authUser.id));
  const muted = new Set(getMutedUserIds(req.authUser.id));
  const rows = db.prepare(`
    ${POST_JOIN_SQL}
    WHERE p.visibility = 'group' AND p.group_id = ?
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all(group.id);

  const posts = rows
    .filter((r) => !hidden.has(r.subject_user_id) && !hidden.has(r.credited_by_user_id) && !muted.has(r.credited_by_user_id))
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

// "React with your face" (BeReal-style RealMoji). Same one-reaction-per-post
// slot as the plain emoji tap above — the difference is purely which photo
// gets shown for it. Your photo for an emoji category is saved once (in
// user_reaction_photos) and reused for every future reaction with that
// category: send a photo the first time (or to update it), and after that
// just send the emoji — this route looks up your saved photo for it.
app.post('/api/posts/:postId/react-selfie', requireAuth, requireVerified, upload.single('photo'), async (req, res) => {
  const user = req.authUser;
  const file = req.file;
  const fail = (status, error) => {
    if (file) fs.unlink(file.path, () => {});
    return res.status(status).json({ error });
  };

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
  if (!post) return fail(404, 'Post not found');
  if (post.visibility === 'group' && !isGroupMember(post.group_id, user.id)) {
    return fail(403, "You're not in that group");
  }
  const emoji = ((req.body || {}).emoji || '').trim();
  if (!REACTION_EMOJIS.includes(emoji)) return fail(400, 'Not a valid reaction category');

  if (file) {
    const existingPreset = db.prepare('SELECT * FROM user_reaction_photos WHERE user_id = ? AND emoji = ?').get(user.id, emoji);
    if (existingPreset) {
      fs.unlink(path.join(uploadsDir, existingPreset.photo_filename), () => {});
      if (existingPreset.photo_url) deletePhotoFromR2(r2KeyFromUrl(existingPreset.photo_url));
    }
    const photoUrl = await uploadPhotoToR2(file.path, file.filename);
    db.prepare(`
      INSERT INTO user_reaction_photos (user_id, emoji, photo_filename, photo_url, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, emoji) DO UPDATE SET photo_filename = excluded.photo_filename, photo_url = excluded.photo_url, updated_at = excluded.updated_at
    `).run(user.id, emoji, file.filename, photoUrl || null);
  } else if (!db.prepare('SELECT 1 FROM user_reaction_photos WHERE user_id = ? AND emoji = ?').get(user.id, emoji)) {
    return fail(400, 'Take a photo to set up this reaction face first');
  }

  const existing = db.prepare('SELECT * FROM reactions WHERE post_id = ? AND user_id = ?').get(post.id, user.id);
  if (existing) {
    db.prepare('UPDATE reactions SET emoji = ? WHERE id = ?').run(emoji, existing.id);
  } else {
    db.prepare('INSERT INTO reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(post.id, user.id, emoji);
  }

  res.json(serializePost(getPostRow(post.id), user.id));
});

app.get('/api/me/reaction-photos', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT emoji, photo_filename, photo_url FROM user_reaction_photos WHERE user_id = ?').all(req.authUser.id);
  const byEmoji = {};
  for (const r of rows) byEmoji[r.emoji] = r.photo_url || `/uploads/${r.photo_filename}`;
  res.json(byEmoji);
});

app.delete('/api/me/reaction-photos/:emoji', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM user_reaction_photos WHERE user_id = ? AND emoji = ?').get(req.authUser.id, req.params.emoji);
  if (!row) return res.status(404).json({ error: 'No saved photo for that reaction' });
  fs.unlink(path.join(uploadsDir, row.photo_filename), () => {});
  if (row.photo_url) deletePhotoFromR2(r2KeyFromUrl(row.photo_url));
  db.prepare('DELETE FROM user_reaction_photos WHERE id = ?').run(row.id);
  res.json({ status: 'removed' });
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
function deleteExtraPhotoFiles(postId) {
  const extras = db.prepare('SELECT photo_filename, photo_url FROM post_photos WHERE post_id = ?').all(postId);
  for (const p of extras) {
    fs.unlink(path.join(uploadsDir, p.photo_filename), () => {});
    if (p.photo_url) deletePhotoFromR2(r2KeyFromUrl(p.photo_url));
  }
}

function deleteReactionPhotoFiles(postId) {
  const reacts = db.prepare('SELECT photo_filename, photo_url FROM reactions WHERE post_id = ? AND photo_filename IS NOT NULL').all(postId);
  for (const r of reacts) {
    fs.unlink(path.join(uploadsDir, r.photo_filename), () => {});
    if (r.photo_url) deletePhotoFromR2(r2KeyFromUrl(r.photo_url));
  }
}

function deletePostAndFile(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;
  fs.unlink(path.join(uploadsDir, post.photo_filename), () => {});
  if (post.photo_url) deletePhotoFromR2(r2KeyFromUrl(post.photo_url));
  if (post.inset_photo_filename) fs.unlink(path.join(uploadsDir, post.inset_photo_filename), () => {});
  if (post.inset_photo_url) deletePhotoFromR2(r2KeyFromUrl(post.inset_photo_url));
  deleteExtraPhotoFiles(postId);
  deleteReactionPhotoFiles(postId);
  db.prepare('DELETE FROM posts WHERE id = ?').run(postId); // cascades post_photos, reactions
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
  const extras = db.prepare('SELECT photo_filename, photo_url FROM post_photos WHERE post_id = ?').all(postId);
  for (const p of extras) fs.unlink(path.join(uploadsDir, p.photo_filename), () => {});
  const reacts = db.prepare('SELECT photo_filename, photo_url FROM reactions WHERE post_id = ? AND photo_filename IS NOT NULL').all(postId);
  for (const r of reacts) fs.unlink(path.join(uploadsDir, r.photo_filename), () => {});
  if (!post.photo_url) {
    deleteExtraPhotoFiles(postId); // no durable copy of the post at all — safe to also drop the R2 extras/reaction selfies
    deleteReactionPhotoFiles(postId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(postId); // cascades post_photos, reactions
  }
}

// --- Admin moderation queue ---
// Not a public endpoint — gated behind is_admin (see ADMIN_EMAIL in db.js).
// This is what makes "act on reports within 24h" operationally possible.
app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.reason, r.status, r.created_at,
           reporter.username as reporter_username,
           p.id as post_id, p.photo_filename, p.photo_url, p.caption, p.visibility, p.subject_display_name,
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
    subjectDisplayName: r.subject_display_name || null,
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
<title>Privacy Policy — Catch a Beast</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px 20px 60px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2em; }
  a { color: #6b3fa0; }
</style>
</head>
<body>
<h1>Privacy Policy — Catch a Beast</h1>
<p>Last updated: ${new Date().toISOString().slice(0, 10)}</p>

<h2>What we collect</h2>
<p>Your name (private — used internally, never shown to other users), an email address (for login and account recovery — never shown publicly), a display name/username (shown publicly on posts and the leaderboard), your password (stored as a bcrypt hash, never in plain text), and photos you upload as part of posts.</p>

<h2>How we use it</h2>
<p>To operate the app: authenticate you, show your display name on content you post or are credited in, calculate points and leaderboard standing, and send you a one-time verification email via Resend when you sign up.</p>

<h2>Photos and posts</h2>
<p>Photos you post are automatically deleted from our servers 24 hours after posting, unless you choose to save them. Public posts are visible to all users; group posts are visible only to members of that group.</p>

<h2>Content moderation</h2>
<p>We have zero tolerance for illegal content, harassment, hate speech, or exploitation of any kind. Any user can report a post they find objectionable directly in the app. Reports are reviewed by a moderator, and violating content or accounts are actioned (content removed and/or the account suspended) within 24 hours. Users can also block other users, which immediately hides that user's content from them and vice versa.</p>

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
app.listen(PORT, () => console.log(`Catch a Beast listening on :${PORT}`));
