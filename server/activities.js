// No more curated preset list — every activity tag is now user-created (see
// POST /api/activities in index.js) and shared/reused across the whole app
// once someone's named it. Keeping this as an empty array (not deleting the
// export) means db.js's existing deleteStaleActivities cleanup — which
// already only prunes is_custom=0 rows — does the work of removing the old
// preset rows on next boot, without touching anything users have created.
const ACTIVITIES = [];

const LEVELS = [
  { level: 1, title: 'Squid', minXp: 0 },
  { level: 2, title: 'Normie', minXp: 250 },
  { level: 3, title: 'Ferda Beast', minXp: 500 },
];

module.exports = { ACTIVITIES, LEVELS };
