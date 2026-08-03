const path = require('path');
const Database = require('better-sqlite3');
const { ACTIVITIES } = require('./activities');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT,
    email TEXT UNIQUE COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    verify_token_hash TEXT,
    verify_token_expires TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    repeatable TEXT
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

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_id INTEGER REFERENCES activities(id) ON DELETE SET NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    photo_filename TEXT NOT NULL,
    caption TEXT,
    saved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS post_credits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    awarder_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, user_id)
  );
`);

// --- Migrations for databases created before `password_hash` / email auth existed ---
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
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

// --- Migrations for databases created before `repeatable` / `period_key` existed ---
const activityCols = db.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
if (!activityCols.includes('repeatable')) {
  db.exec('ALTER TABLE activities ADD COLUMN repeatable TEXT');
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

const deleteStaleActivities = db.prepare(`
  DELETE FROM activities WHERE key NOT IN (${ACTIVITIES.map(() => '?').join(',')})
`);

const seed = db.transaction((activities) => {
  for (const a of activities) upsertActivity.run({ ...a, repeatable: a.repeatable || null });
  deleteStaleActivities.run(...activities.map((a) => a.key));
});
seed(ACTIVITIES);

module.exports = db;
