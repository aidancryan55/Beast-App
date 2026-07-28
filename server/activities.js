// Seed data: cliche college activities, grouped by category.
// xp = base points awarded on completion. rarity drives badge flavor/UI color.
const ACTIVITIES = [
  // --- Social / Party ---
  { key: 'face_paint', name: 'Paint your face for game day', category: 'Social', xp: 10, rarity: 'common', icon: '🎨' },
  { key: 'darty', name: 'Throw or attend a day party', category: 'Social', xp: 25, rarity: 'uncommon', icon: '☀️' },
  { key: 'tailgate', name: 'Go to a tailgate', category: 'Social', xp: 20, rarity: 'common', icon: '🏈' },
  { key: 'themed_party', name: 'Wear a costume to a themed party', category: 'Social', xp: 20, rarity: 'common', icon: '🎭' },
  { key: 'road_trip', name: 'Go on a spontaneous road trip', category: 'Social', xp: 30, rarity: 'uncommon', icon: '🚗' },
  { key: 'formal', name: 'Attend a formal or semi-formal', category: 'Social', xp: 25, rarity: 'common', icon: '🕺' },
  { key: 'tank_top', name: 'Wear a tank top', category: 'Social', xp: 10, rarity: 'common', icon: '🎽', repeatable: 'daily' },
  { key: 'mob_with_boys', name: 'Mob out with your boys', category: 'Social', xp: 15, rarity: 'common', icon: '👬', repeatable: 'weekly' },

  // --- Romance ---
  { key: 'kiss_someone', name: 'Kiss a girl', category: 'Romance', xp: 15, rarity: 'common', icon: '💋' },
  { key: 'campus_crush', name: 'Get a campus crush', category: 'Romance', xp: 10, rarity: 'common', icon: '😍' },
  { key: 'blind_date', name: 'Go on a blind date / set-up', category: 'Romance', xp: 20, rarity: 'uncommon', icon: '💌' },
  { key: 'walk_of_shame', name: "Head home in last night's outfit", category: 'Romance', xp: 20, rarity: 'uncommon', icon: '🚶' },
  { key: 'set_up_by_boy', name: 'Get set up by your boy', category: 'Romance', xp: 15, rarity: 'common', icon: '🤝' },
  { key: 'set_up_your_boy', name: 'Set up your boy', category: 'Romance', xp: 15, rarity: 'common', icon: '💘' },

  // --- Greek Life ---
  { key: 'rush', name: 'Go through rush week', category: 'Greek Life', xp: 25, rarity: 'uncommon', icon: '🏛️' },
  { key: 'get_bid', name: 'Get a bid', category: 'Greek Life', xp: 30, rarity: 'uncommon', icon: '📜' },
  { key: 'join_frat_sorority', name: 'Become a new member of a fraternity/sorority', category: 'Greek Life', xp: 60, rarity: 'rare', icon: '🏆' },
  { key: 'formal_greek', name: 'Attend a Greek mixer', category: 'Greek Life', xp: 20, rarity: 'common', icon: '🎉', repeatable: 'weekly' },
  { key: 'date_party', name: 'Get invited to a date party', category: 'Greek Life', xp: 20, rarity: 'uncommon', icon: '💐', repeatable: 'weekly' },
  { key: 'letters', name: 'Wear your letters on campus', category: 'Greek Life', xp: 10, rarity: 'common', icon: '🔤', repeatable: 'daily' },
  { key: 'philanthropy', name: 'Participate in a philanthropy/charity event', category: 'Greek Life', xp: 25, rarity: 'uncommon', icon: '❤️', repeatable: 'weekly' },
  { key: 'top_house', name: 'Be in the top house on campus', category: 'Greek Life', xp: 40, rarity: 'rare', icon: '👑' },

  // --- Academics / Campus Life ---
  { key: 'all_nighter', name: 'Pull an all-nighter studying', category: 'Academics', xp: 30, rarity: 'uncommon', icon: '📚' },
  { key: 'sleep_lecture', name: 'Fall asleep during a lecture', category: 'Academics', xp: 10, rarity: 'common', icon: '😴' },
  { key: 'group_project', name: 'Survive a terrible group project', category: 'Academics', xp: 20, rarity: 'common', icon: '🤝' },
  { key: 'skip_class', name: 'Skip class', category: 'Academics', xp: 10, rarity: 'common', icon: '🙈' },

  // --- Rites of Passage ---
  { key: 'kick_out_roommate', name: 'Kick out your roommate for a night', category: 'Rites of Passage', xp: 20, rarity: 'uncommon', icon: '🚪' },
  { key: 'fire_alarm', name: 'Get evacuated by a dorm fire alarm at 2am', category: 'Rites of Passage', xp: 15, rarity: 'common', icon: '🚨' },
  { key: 'first_football_game', name: 'Go to your first home football game', category: 'Rites of Passage', xp: 20, rarity: 'common', icon: '🎊' },
  { key: 'wake_up_confused', name: 'Sprint across campus because you overslept', category: 'Rites of Passage', xp: 20, rarity: 'uncommon', icon: '🏃' },
  { key: 'make_bread', name: 'Make some bread', category: 'Rites of Passage', xp: 20, rarity: 'uncommon', icon: '🍞', repeatable: 'weekly' },
  { key: 'study_abroad', name: 'Study abroad for a semester', category: 'Rites of Passage', xp: 50, rarity: 'rare', icon: '✈️' },
  { key: 'internship', name: 'Land your first internship', category: 'Rites of Passage', xp: 40, rarity: 'rare', icon: '💼' },
  { key: 'graduate', name: 'Walk across the stage at graduation', category: 'Rites of Passage', xp: 100, rarity: 'legendary', icon: '🎓' },
];

const LEVELS = [
  { level: 1, title: 'Squid', minXp: 0 },
  { level: 2, title: 'Normie', minXp: 250 },
  { level: 3, title: 'Ferda Beast', minXp: 500 },
];

module.exports = { ACTIVITIES, LEVELS };
