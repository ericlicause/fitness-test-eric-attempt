// Exercise name normalization and muscle-group lookup.
//
// Notepad shorthand is messy ("bench", "BP", "db incline"), so names are
// lowercased, stripped of punctuation, matched against an alias table and
// otherwise title-cased. Muscle groups drive the volume-balance insights.

export const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
  'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core', 'Cardio', 'Other',
];

export const PUSH_GROUPS = ['Chest', 'Shoulders', 'Triceps'];
export const PULL_GROUPS = ['Back', 'Biceps'];
export const LEG_GROUPS = ['Quads', 'Hamstrings', 'Glutes', 'Calves'];

// canonical name -> [primary muscle group, ...aliases]
const CATALOG = {
  'Bench Press': ['Chest', 'bench', 'bp', 'flat bench', 'barbell bench', 'bb bench', 'bench press', 'flat bench press'],
  'Incline Bench Press': ['Chest', 'incline bench', 'incline bp', 'incline press', 'incline barbell press'],
  'Dumbbell Bench Press': ['Chest', 'db bench', 'dumbbell bench', 'db press', 'db bench press', 'flat db press'],
  'Incline Dumbbell Press': ['Chest', 'incline db', 'incline db press', 'incline dumbbell', 'incline dumbbell bench', 'db incline', 'db incline press'],
  'Chest Fly': ['Chest', 'fly', 'flys', 'flyes', 'chest fly', 'pec fly', 'pec deck', 'cable fly', 'db fly'],
  'Push-up': ['Chest', 'pushup', 'pushups', 'push up', 'push ups', 'push-ups'],
  'Dip': ['Triceps', 'dips', 'dip', 'chest dips', 'tricep dips'],

  'Overhead Press': ['Shoulders', 'ohp', 'overhead press', 'military press', 'press', 'shoulder press', 'standing press', 'strict press'],
  'Dumbbell Shoulder Press': ['Shoulders', 'db shoulder press', 'db ohp', 'seated db press', 'dumbbell shoulder press', 'arnold press'],
  'Lateral Raise': ['Shoulders', 'lateral raise', 'lateral raises', 'lat raise', 'lat raises', 'side raise', 'side raises', 'laterals'],
  'Rear Delt Fly': ['Shoulders', 'rear delt', 'rear delts', 'rear delt fly', 'reverse fly', 'reverse pec deck'],
  'Face Pull': ['Shoulders', 'face pull', 'face pulls'],

  'Deadlift': ['Back', 'deadlift', 'deadlifts', 'dl', 'conventional deadlift', 'sumo deadlift', 'sumo'],
  'Barbell Row': ['Back', 'row', 'rows', 'bb row', 'barbell row', 'bent over row', 'bent-over row', 'pendlay row'],
  'Dumbbell Row': ['Back', 'db row', 'db rows', 'dumbbell row', 'one arm row', 'single arm row'],
  'Cable Row': ['Back', 'cable row', 'seated row', 'seated cable row'],
  'Lat Pulldown': ['Back', 'pulldown', 'pulldowns', 'lat pulldown', 'lat pull down', 'lat pull'],
  'Pull-up': ['Back', 'pullup', 'pullups', 'pull up', 'pull ups', 'pull-ups', 'chinup', 'chinups', 'chin up', 'chin ups', 'chin-up', 'chin-ups'],

  'Barbell Curl': ['Biceps', 'curl', 'curls', 'bb curl', 'barbell curl', 'ez curl', 'ez bar curl'],
  'Dumbbell Curl': ['Biceps', 'db curl', 'db curls', 'dumbbell curl', 'dumbbell curls'],
  'Hammer Curl': ['Biceps', 'hammer curl', 'hammer curls', 'hammers'],
  'Tricep Pushdown': ['Triceps', 'pushdown', 'pushdowns', 'tricep pushdown', 'triceps pushdown', 'rope pushdown', 'tricep extension', 'cable pushdown'],
  'Skull Crusher': ['Triceps', 'skull crusher', 'skull crushers', 'skullcrushers', 'lying tricep extension'],
  'Overhead Tricep Extension': ['Triceps', 'overhead extension', 'overhead tricep extension', 'oh tricep extension'],

  'Squat': ['Quads', 'squat', 'squats', 'back squat', 'bb squat', 'barbell squat', 'high bar squat', 'low bar squat'],
  'Front Squat': ['Quads', 'front squat', 'front squats'],
  'Leg Press': ['Quads', 'leg press', 'legpress'],
  'Lunge': ['Quads', 'lunge', 'lunges', 'walking lunge', 'walking lunges', 'split squat', 'bulgarian split squat', 'bss'],
  'Leg Extension': ['Quads', 'leg extension', 'leg extensions', 'leg ext'],
  'Romanian Deadlift': ['Hamstrings', 'rdl', 'rdls', 'romanian deadlift', 'stiff leg deadlift', 'sldl'],
  'Leg Curl': ['Hamstrings', 'leg curl', 'leg curls', 'hamstring curl', 'lying leg curl', 'seated leg curl'],
  'Hip Thrust': ['Glutes', 'hip thrust', 'hip thrusts', 'glute bridge'],
  'Calf Raise': ['Calves', 'calf raise', 'calf raises', 'calves', 'standing calf raise', 'seated calf raise'],

  'Plank': ['Core', 'plank', 'planks'],
  'Hanging Leg Raise': ['Core', 'leg raise', 'leg raises', 'hanging leg raise', 'hanging leg raises'],
  'Crunch': ['Core', 'crunch', 'crunches', 'sit up', 'sit ups', 'situps', 'cable crunch'],
  'Ab Wheel': ['Core', 'ab wheel', 'ab rollout', 'rollouts'],
};

const ALIASES = new Map();
const GROUP_BY_NAME = new Map();
for (const [canonical, [group, ...aliases]] of Object.entries(CATALOG)) {
  GROUP_BY_NAME.set(canonical, group);
  ALIASES.set(clean(canonical), canonical);
  for (const a of aliases) ALIASES.set(clean(a), canonical);
}

// Keyword fallbacks for names that aren't in the catalog, checked in order.
const KEYWORD_GROUPS = [
  [/\b(run|jog|bike|cycle|row(ing)? machine|erg|elliptical|stair|treadmill|walk|swim|sprint)\b/, 'Cardio'],
  [/\b(calf|calves)\b/, 'Calves'],
  [/\b(curl)\b.*\b(leg|ham)/, 'Hamstrings'],
  [/\b(leg|ham)\w*\b.*\bcurl/, 'Hamstrings'],
  [/\b(rdl|hamstring|good morning|nordic)\b/, 'Hamstrings'],
  [/\b(glute|hip thrust|bridge|kickback|abduct)/, 'Glutes'],
  [/\b(squat|lunge|leg press|leg ext|step up|quad)/, 'Quads'],
  [/\b(tricep|triceps|pushdown|skull|close grip|jm press|dip)/, 'Triceps'],
  [/\b(curl|bicep|biceps)/, 'Biceps'],
  [/\b(row|pulldown|pull ?up|chin ?up|lat|deadlift|shrug|back ext)/, 'Back'],
  [/\b(lateral|delt|shoulder|overhead|ohp|military|face pull|upright)/, 'Shoulders'],
  [/\b(bench|chest|pec|fly|flye|push ?up|incline|decline)/, 'Chest'],
  [/\b(ab|abs|core|plank|crunch|sit ?up|oblique|hollow|pallof|carry)/, 'Core'],
];

function clean(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bDb\b/g, 'DB').replace(/\bBb\b/g, 'BB').replace(/\bEz\b/g, 'EZ')
    .replace(/\bRdl\b/g, 'RDL').replace(/\bOhp\b/g, 'OHP');
}

export function normalizeExerciseName(raw) {
  const c = clean(raw);
  if (!c) return '';
  if (ALIASES.has(c)) return ALIASES.get(c);
  // Plural forms that aren't listed ("hip thrusts" style)
  if (c.endsWith('s') && ALIASES.has(c.slice(0, -1))) return ALIASES.get(c.slice(0, -1));
  return titleCase(c);
}

export function muscleGroupFor(name) {
  if (GROUP_BY_NAME.has(name)) return GROUP_BY_NAME.get(name);
  const c = clean(name);
  for (const [re, group] of KEYWORD_GROUPS) if (re.test(c)) return group;
  return 'Other';
}

export function isLowerBody(name) {
  return LEG_GROUPS.includes(muscleGroupFor(name)) || /deadlift/i.test(name);
}
