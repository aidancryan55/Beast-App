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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    xp INTEGER NOT NULL,
    rarity TEXT NOT NULL,
    icon TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, activity_id)
  );
`);

const upsertActivity = db.prepare(`
  INSERT INTO activities (key, name, category, xp, rarity, icon)
  VALUES (@key, @name, @category, @xp, @rarity, @icon)
  ON CONFLICT(key) DO UPDATE SET
    name = excluded.name,
    category = excluded.category,
    xp = excluded.xp,
    rarity = excluded.rarity,
    icon = excluded.icon
`);

const deleteStaleActivities = db.prepare(`
  DELETE FROM activities WHERE key NOT IN (${ACTIVITIES.map(() => '?').join(',')})
`);

const seed = db.transaction((activities) => {
  for (const a of activities) upsertActivity.run(a);
  deleteStaleActivities.run(...activities.map((a) => a.key));
});
seed(ACTIVITIES);

module.exports = db;
