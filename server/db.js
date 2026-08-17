const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { ACTIVITIES } = require('./activities');

// Render's web services have an ephemeral filesystem — anything written to
// disk (like this database) is wiped on every new deploy unless it lives on
// a persistent Disk. DATA_DIR should point at that Disk's mount path in
// production (see render.yaml / the Render dashboard); it falls back to this
// directory for local dev, where a throwaway db is fine.
const dataDir = process.env.DATA_DIR || __dirname;
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    real_name TEXT,
    avatar_url TEXT,
    bio TEXT,
    password_hash TEXT,
    email TEXT UNIQUE COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token_hash TEXT,
    verify_token_expires TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    banned INTEGER NOT NULL DEFAULT 0,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_streak_date TEXT,
    phone_hash TEXT UNIQUE,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    phone_verify_code_hash TEXT,
    phone_verify_expires TEXT,
    apple_sub TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A verified-but-not-yet-usernamed "Sign in with Apple" identity. Created
  -- when someone authenticates with Apple for the first time and there's no
  -- existing account to log into or link — the real users row only gets
  -- created once they pick a username (see /api/auth/apple/finish), same
  -- shape as the email/password signup wizard's own two-step pattern.
  CREATE TABLE IF NOT EXISTS pending_apple_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    apple_sub TEXT NOT NULL,
    email TEXT,
    real_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    xp INTEGER NOT NULL,
    rarity TEXT NOT NULL,
    icon TEXT NOT NULL,
    repeatable TEXT,
    is_custom INTEGER NOT NULL DEFAULT 0,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    period_key TEXT NOT NULL DEFAULT 'once',
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, activity_id, period_key)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(requester_id, addressee_id)
  );

  -- 1:1 DMs, friends-only. user_a_id is always the lower of the two ids
  -- (enforced in index.js at creation) so there's exactly one conversation
  -- row per pair regardless of who messaged first.
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_a_id, user_b_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    photo_filename TEXT NOT NULL,
    photo_url TEXT,
    inset_photo_filename TEXT,
    inset_photo_url TEXT,
    subject_display_name TEXT,
    caption TEXT,
    saved INTEGER NOT NULL DEFAULT 0,
    is_anonymous INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Extra carousel photos beyond the required main/inset dual-camera shot —
  -- purely additive, never replaces the BeReal-style main+inset pair which
  -- always stays slide one. Cascades with the post; local disk + R2 file
  -- cleanup for these still has to happen explicitly (see deletePostAndFile
  -- and expirePostFromFeeds in index.js) since that's outside SQLite's reach.
  CREATE TABLE IF NOT EXISTS post_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    photo_filename TEXT NOT NULL,
    photo_url TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_post_photos_post ON post_photos(post_id, position);

  -- Extra tagged people beyond the required primary subject_user_id on
  -- posts — purely additive, capped at MAX_ADDITIONAL_SUBJECTS in index.js.
  -- The post's points badge/total stays one shared pool across everyone
  -- tagged (see post_credits.subject_user_id below) rather than per-person
  -- budgets, per the "shared budget, split however" design.
  CREATE TABLE IF NOT EXISTS post_additional_subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS post_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    awarder_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    points INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id, awarder_user_id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(post_id, user_id)
  );

  -- BeReal-style "RealMoji" — one saved selfie per emoji category, set up
  -- once and reused for every future reaction with that emoji (not stored
  -- per-reaction). Reacting with a category you've set a photo for is what
  -- makes reactions.emoji resolve to a face instead of a plain tally in
  -- serializePost's reactionSelfies join — see index.js.
  CREATE TABLE IF NOT EXISTS user_reaction_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    photo_filename TEXT NOT NULL,
    photo_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    password_hash TEXT,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, user_id)
  );

  -- Pending join requests for private groups with no password set — the
  -- moderator (group creator) approves or declines each one. Private groups
  -- WITH a password skip this table entirely (join is instant once the
  -- password checks out); this only exists for the moderator-approval mode.
  CREATE TABLE IF NOT EXISTS group_join_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    UNIQUE(post_id, reporter_user_id)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(blocker_user_id, blocked_user_id)
  );

  -- Soft, one-directional, silent hide: unlike blocks (mutual, prevents
  -- interaction), muting just stops showing the muted person's posts in your
  -- own feeds. They're never notified and can still friend/credit/comment on you.
  CREATE TABLE IF NOT EXISTS mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    muter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    muted_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(muter_user_id, muted_user_id)
  );

  -- Persistent points record, independent of posts/photos. posts.* rows
  -- (and post_credits with them, via its own ON DELETE CASCADE) are ephemeral
  -- and vanish 24h after posting unless saved — this table is the durable
  -- source of truth so daily/monthly/yearly totals survive that expiry.
  -- user_id = who EARNED the points (always the post's subject), never the
  -- poster/crediter. source_post_id cascades to NULL (not deleted) when the
  -- originating post is removed, so the earned points persist without a
  -- dangling reference. contributor_user_id (who gave the credit) similarly
  -- goes NULL if that person later deletes their account — the recipient's
  -- earned points are the recipient's own data and must survive that.
  CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    contributor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    earned_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_post_id, source_type, contributor_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_points_ledger_earned_at ON points_ledger(earned_at, user_id);

  -- Beast Dares — one user issues a dare to another, staking wager_points of
  -- their own as the prize; the target fulfills it by attaching the dare
  -- when posting, which pays the wager from issuer to target (see
  -- 'dare_wager' in the points ledger). completed_post_id cascades to
  -- NULL (not deleted) so the dare's own record survives if the post itself
  -- later expires/gets removed.
  CREATE TABLE IF NOT EXISTS dares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issuer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    wager_points INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    completed_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dares_target ON dares(target_user_id, status);
`);

// --- Migrations for databases created before `password_hash` / email auth existed ---
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('real_name')) {
  db.exec('ALTER TABLE users ADD COLUMN real_name TEXT');
}
if (!userCols.includes('avatar_url')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
}
if (!userCols.includes('bio')) {
  db.exec('ALTER TABLE users ADD COLUMN bio TEXT');
}
if (!userCols.includes('password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}
if (!userCols.includes('email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT UNIQUE COLLATE NOCASE');
}
if (!userCols.includes('email_verified')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('verify_token_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN verify_token_hash TEXT');
}
if (!userCols.includes('verify_token_expires')) {
  db.exec('ALTER TABLE users ADD COLUMN verify_token_expires TEXT');
}
if (!userCols.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('banned')) {
  db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('current_streak')) {
  db.exec('ALTER TABLE users ADD COLUMN current_streak INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('longest_streak')) {
  db.exec('ALTER TABLE users ADD COLUMN longest_streak INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('last_streak_date')) {
  db.exec('ALTER TABLE users ADD COLUMN last_streak_date TEXT');
}
// Note: SQLite's ALTER TABLE ADD COLUMN can't carry a UNIQUE constraint
// inline (unlike the fresh-DB CREATE TABLE above, where phone_hash IS
// declared UNIQUE) — so migrated databases get a plain column here, and
// uniqueness is enforced separately below via a real index instead.
if (!userCols.includes('phone_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN phone_hash TEXT');
}
if (!userCols.includes('phone_verified')) {
  db.exec('ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
}
if (!userCols.includes('phone_verify_code_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN phone_verify_code_hash TEXT');
}
if (!userCols.includes('phone_verify_expires')) {
  db.exec('ALTER TABLE users ADD COLUMN phone_verify_expires TEXT');
}
// Safe to run every boot regardless of whether phone_hash already had an
// inline UNIQUE (fresh DB) or was just ALTER-added above (migrated DB).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_hash ON users(phone_hash)');
if (!userCols.includes('apple_sub')) {
  db.exec('ALTER TABLE users ADD COLUMN apple_sub TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_sub ON users(apple_sub)');

// Auto-promote an admin account by email, so there's no manual DB surgery needed.
if (process.env.ADMIN_EMAIL) {
  db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(process.env.ADMIN_EMAIL.toLowerCase());
}

// NOTE on groups.created_by_user_id: new databases get ON DELETE SET NULL (see
// CREATE TABLE above) so deleting your account doesn't cascade-destroy groups
// you created. Databases from before this change still have the old ON DELETE
// CASCADE behavior — rebuilding the table in place to fix that turns out to
// corrupt other tables' foreign keys that point at `groups` (renaming a
// referenced table breaks their FK target). Instead, account deletion always
// explicitly detaches ownership (UPDATE groups SET created_by_user_id = NULL)
// before deleting the user row, which sidesteps the CASCADE either way.

// --- Migrations for databases created before private/password groups existed ---
const groupCols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
if (!groupCols.includes('visibility')) {
  db.exec(`ALTER TABLE groups ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
}
if (!groupCols.includes('password_hash')) {
  db.exec('ALTER TABLE groups ADD COLUMN password_hash TEXT');
}

// --- Migrations for databases created before `repeatable` / `period_key` existed ---
const activityCols = db.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
if (!activityCols.includes('repeatable')) {
  db.exec('ALTER TABLE activities ADD COLUMN repeatable TEXT');
}
if (!activityCols.includes('is_custom')) {
  db.exec('ALTER TABLE activities ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0');
}
if (!activityCols.includes('created_by_user_id')) {
  db.exec('ALTER TABLE activities ADD COLUMN created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}

// --- Migrations for databases created before groups/crowd-sourced credits existed ---
const postCols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
if (postCols.length) {
  if (!postCols.includes('visibility')) {
    db.exec(`ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  }
  if (!postCols.includes('group_id')) {
    db.exec('ALTER TABLE posts ADD COLUMN group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE');
  }
  if (!postCols.includes('is_anonymous')) {
    db.exec('ALTER TABLE posts ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0');
  }
  if (!postCols.includes('photo_url')) {
    db.exec('ALTER TABLE posts ADD COLUMN photo_url TEXT');
  }
  // Second photo for dual-camera posts — the small corner shot
  // that viewers can tap to swap with the main one. Null for single-photo posts.
  if (!postCols.includes('inset_photo_filename')) {
    db.exec('ALTER TABLE posts ADD COLUMN inset_photo_filename TEXT');
  }
  if (!postCols.includes('inset_photo_url')) {
    db.exec('ALTER TABLE posts ADD COLUMN inset_photo_url TEXT');
  }
  // "Random stranger" posts — no real account behind the subject, so
  // subject_user_id is set to the poster's own id (satisfies the NOT NULL
  // constraint without a migration) and this column carries the free-text
  // name/description instead. Its presence is what marks a post as one of
  // these — see every subject_display_name check in index.js.
  if (!postCols.includes('subject_display_name')) {
    db.exec('ALTER TABLE posts ADD COLUMN subject_display_name TEXT');
  }
  // Old posts stored a single fixed `points` value with no post_credits row.
  // Backfill one post_credits row per legacy post so totals still add up under the new model.
  if (postCols.includes('points')) {
    db.exec(`
      INSERT OR IGNORE INTO post_credits (post_id, awarder_user_id, points, created_at)
      SELECT id, credited_by_user_id, points, created_at FROM posts
      WHERE points IS NOT NULL
    `);
  }
}

const reactionCols = db.prepare('PRAGMA table_info(reactions)').all().map((c) => c.name);
if (!reactionCols.includes('photo_filename')) {
  db.exec('ALTER TABLE reactions ADD COLUMN photo_filename TEXT');
}
if (!reactionCols.includes('photo_url')) {
  db.exec('ALTER TABLE reactions ADD COLUMN photo_url TEXT');
}

const postCreditCols = db.prepare('PRAGMA table_info(post_credits)').all().map((c) => c.name);
if (postCreditCols.length && !postCreditCols.includes('subject_user_id')) {
  db.exec('ALTER TABLE post_credits ADD COLUMN subject_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
  // Backfill: every pre-existing credit row was implicitly for the post's
  // one and only subject, before multi-tag posts could have more than one.
  db.exec(`
    UPDATE post_credits SET subject_user_id = (
      SELECT subject_user_id FROM posts WHERE posts.id = post_credits.post_id
    ) WHERE subject_user_id IS NULL
  `);
}

const dareCols = db.prepare('PRAGMA table_info(dares)').all().map((c) => c.name);
if (dareCols.length && !dareCols.includes('wager_points')) {
  db.exec('ALTER TABLE dares ADD COLUMN wager_points INTEGER NOT NULL DEFAULT 0');
}

const completionCols = db.prepare('PRAGMA table_info(completions)').all().map((c) => c.name);
if (!completionCols.includes('period_key')) {
  // The old table has UNIQUE(user_id, activity_id), which blocks multiple
  // completions of the same repeatable activity. Rebuild it with the wider constraint.
  db.exec(`
    ALTER TABLE completions RENAME TO completions_old;

    CREATE TABLE completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL DEFAULT 'once',
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, activity_id, period_key)
    );

    INSERT INTO completions (id, user_id, activity_id, period_key, completed_at)
    SELECT id, user_id, activity_id, 'once', completed_at FROM completions_old;

    DROP TABLE completions_old;
  `);
}

const upsertActivity = db.prepare(`
  INSERT INTO activities (key, name, category, xp, rarity, icon, repeatable)
  VALUES (@key, @name, @category, @xp, @rarity, @icon, @repeatable)
  ON CONFLICT(key) DO UPDATE SET
    name = excluded.name,
    category = excluded.category,
    xp = excluded.xp,
    rarity = excluded.rarity,
    icon = excluded.icon,
    repeatable = excluded.repeatable
`);

// Only prunes built-in activities that were removed from activities.js —
// user-submitted custom activities (is_custom = 1) are never touched here.
const deleteStaleActivities = db.prepare(`
  DELETE FROM activities WHERE is_custom = 0 AND key NOT IN (${ACTIVITIES.map(() => '?').join(',')})
`);

const seed = db.transaction((activities) => {
  for (const a of activities) upsertActivity.run({ ...a, repeatable: a.repeatable || null });
  deleteStaleActivities.run(...activities.map((a) => a.key));
});
seed(ACTIVITIES);

module.exports = db;
