// Parses notepad-style workout shorthand into structured workouts.
//
// Supported per-exercise notations (mix freely on one line, separated by
// commas, spaces, slashes or semicolons):
//
//   Bench: 135x10, 155x8, 175x6       weight x reps, one set each
//   OHP 95 x 8, 8, 7                  bare numbers reuse the last weight
//   Squat 225x5x3                     weight x reps x sets
//   Squat 225 5x5                     weight, then sets x reps
//   Incline DB 3x10 @ 50              sets x reps @ weight
//   Pullups bw x 12, 10 / bw+25 x 6   bodyweight (optionally + added load)
//   Pushups 20, 15, 12                reps only -> bodyweight
//   Plank 3x60s / 1:30 / 2min         timed sets
//   175x6 @8  or  rpe 8               RPE (an @ value <= 10 after a set)
//   60kg x 8 / 135lb x 10             units (default unit otherwise)
//   (felt easy)                       parenthesized text -> exercise note
//
// Lines:
//   "2026-10-12 Push day", "10/12", "Mon 10/12", "Oct 12"  -> starts a workout
//   "Notes: ...", "# ...", "// ..."                        -> workout notes
//   "Bench" on its own, followed by "135x10" lines         -> multi-line sets

import { normalizeExerciseName, muscleGroupFor } from './exercises.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?,?\\s*';
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const SLASH_DATE = new RegExp(`^(?:${DAY})?(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?(?![\\dx])`, 'i');
const MONTH_DATE = new RegExp(`^(?:${DAY})?(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i');
const NOTE_LINE = /^(?:notes?\s*[:-]|#|\/\/|--)\s*/i;

const NUM = '\\d+(?:\\.\\d+)?';
const WEIGHT = `([WB]?${NUM})`;
const REPS = '(D?\\d+)';
const PATTERNS = [
  // weight x reps x sets
  ['wrs', new RegExp(`^${WEIGHT}\\s*x\\s*${REPS}\\s*x\\s*(\\d+)`)],
  // sets x reps @ weight
  ['sr@w', new RegExp(`^(\\d+)\\s*x\\s*${REPS}\\s*(?:@|at\\b)\\s*${WEIGHT}`)],
  // weight, then sets x reps ("225 5x5", "225: 5x5")
  ['w sr', new RegExp(`^${WEIGHT}[\\s:]+(\\d+)\\s*x\\s*${REPS}(?![\\d.]|\\s*x)`)],
  // sets x reps weight ("5x5 225")
  ['sr w', new RegExp(`^(\\d+)\\s*x\\s*${REPS}\\s+${WEIGHT}(?![\\d.]|\\s*x)`)],
  // weight x reps
  ['wr', new RegExp(`^${WEIGHT}\\s*x\\s*${REPS}`)],
  // @ value: RPE if <= 10 after a set, otherwise weight
  ['@', new RegExp(`^(?:@|at\\b)\\s*(${NUM})`)],
  ['rpe', new RegExp(`^R(${NUM})`)],
  ['w', /^([WB]\d+(?:\.\d+)?)/],
  ['dur', /^D(\d+)/],
  ['n', new RegExp(`^(${NUM})`)],
];
const SEPARATOR = /^(?:[\s,;/+&|]+|and\b|then\b)+/i;
const MAX_SETS_PREFIX = 10; // "3x10": a first number this small means sets, not weight

export function parseWorkoutText(text, options = {}) {
  const defaultUnit = options.defaultUnit === 'kg' ? 'kg' : 'lb';
  const today = options.today || isoToday();
  const warnings = [];
  const workouts = [];

  let current = newWorkout(today);
  let lastExercise = null;

  const finish = () => {
    finalizeWorkout(current, warnings);
    if (current.exercises.length || current.notes || current.explicitDate) workouts.push(current);
  };

  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!line) return;

    if (NOTE_LINE.test(line)) {
      const note = line.replace(NOTE_LINE, '').trim();
      if (note) current.notes = current.notes ? `${current.notes}\n${note}` : note;
      return;
    }

    const dateHeader = parseDateHeader(line, today);
    if (dateHeader) {
      if (current.exercises.length || current.explicitDate || current.notes) {
        finish();
        current = newWorkout(today);
      }
      current.date = dateHeader.date;
      current.explicitDate = true;
      if (dateHeader.rest) current.title = dateHeader.rest.replace(/^[\s:–—-]+/, '').trim();
      lastExercise = null;
      return;
    }

    const { name, spec, note } = splitLine(line);
    if (!name && !spec) {
      if (note && lastExercise) lastExercise.note = joinNote(lastExercise.note, note);
      return;
    }

    if (!name) {
      if (!lastExercise) {
        warnings.push({ line: lineNo, message: `Sets with no exercise name: "${line}"` });
        return;
      }
      const parsed = parseSpec(spec, defaultUnit);
      lastExercise.sets.push(...parsed.sets);
      if (note) lastExercise.note = joinNote(lastExercise.note, note);
      reportSpecIssues(parsed, line, lineNo, warnings);
      return;
    }

    const canonical = normalizeExerciseName(name);
    const parsed = spec ? parseSpec(spec, defaultUnit) : { sets: [], unparsed: [] };
    if (spec) reportSpecIssues(parsed, line, lineNo, warnings);

    let exercise = lastExercise && lastExercise.name === canonical ? lastExercise : null;
    if (!exercise) {
      exercise = { name: canonical, rawName: name, group: muscleGroupFor(canonical), sets: [], note: '', line: lineNo };
      current.exercises.push(exercise);
    }
    exercise.sets.push(...parsed.sets);
    if (note) exercise.note = joinNote(exercise.note, note);
    lastExercise = exercise;
  });

  finish();
  return { workouts: workouts.map(stripInternal), warnings };
}

function newWorkout(date) {
  return { date, title: '', notes: '', exercises: [], explicitDate: false };
}

function joinNote(a, b) {
  return a ? `${a}; ${b}` : b;
}

// A name-only line with no sets becomes the workout title when it comes first
// ("Push day"); anywhere else it's reported and dropped.
function finalizeWorkout(workout, warnings) {
  const kept = [];
  workout.exercises.forEach((ex, idx) => {
    if (ex.sets.length) {
      kept.push(ex);
    } else if (idx === 0 && !workout.title && !kept.length) {
      workout.title = ex.rawName.replace(/[:\s]+$/, '');
    } else {
      warnings.push({ line: ex.line, message: `No sets found for "${ex.rawName}"` });
    }
  });
  workout.exercises = kept;
}

function stripInternal({ explicitDate, ...w }) {
  return {
    ...w,
    exercises: w.exercises.map(({ line, rawName, ...ex }) => ex),
  };
}

function reportSpecIssues(parsed, line, lineNo, warnings) {
  if (parsed.unparsed.length) {
    warnings.push({ line: lineNo, message: `Couldn't read "${parsed.unparsed.join(' ')}" in "${line}"` });
  }
  if (!parsed.sets.length) {
    warnings.push({ line: lineNo, message: `No sets recognized in "${line}"` });
  }
  for (const s of parsed.sets) {
    if (s.reps != null && s.reps > 100) {
      warnings.push({ line: lineNo, message: `${s.reps} reps looks unusual in "${line}" — check it` });
      break;
    }
  }
}

export function parseDateHeader(line, today = isoToday()) {
  let m = line.match(ISO_DATE);
  if (m) return validDate(+m[1], +m[2], +m[3], line.slice(m[0].length));

  m = line.match(SLASH_DATE);
  if (m) {
    const year = m[3] ? expandYear(+m[3]) : inferYear(+m[1], +m[2], today);
    return validDate(year, +m[1], +m[2], line.slice(m[0].length));
  }

  m = line.match(MONTH_DATE);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    const year = m[3] ? +m[3] : inferYear(month, +m[2], today);
    return validDate(year, month, +m[2], line.slice(m[0].length));
  }
  return null;
}

function expandYear(y) {
  return y < 100 ? 2000 + y : y;
}

// Without a year, pick the most recent past occurrence of that month/day.
function inferYear(month, day, today) {
  const [ty, tm, td] = today.split('-').map(Number);
  return month > tm || (month === tm && day > td + 1) ? ty - 1 : ty;
}

function validDate(y, mo, d, rest) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return { date: dt.toISOString().slice(0, 10), rest: rest.trim() };
}

export function isoToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// "Bench press: 135x10, 155x8 (felt good)" -> name / spec / note
export function splitLine(line) {
  const notes = [];
  const withoutNotes = line.replace(/\(([^)]*)\)/g, (_, n) => {
    if (n.trim()) notes.push(n.trim());
    return ' ';
  });
  const m = withoutNotes.match(/(\d|\bbw\b|\bbodyweight\b|@)/i);
  const idx = m ? m.index : withoutNotes.length;
  const name = withoutNotes.slice(0, idx).replace(/[\s:=–—-]+$/, '').trim();
  const spec = withoutNotes.slice(idx).trim();
  return { name, spec, note: notes.join('; ') };
}

// Rewrites units, bodyweight, durations and RPE into single-letter-prefixed
// tokens so the pattern table only has to deal with numbers and "x".
function normalizeSpec(spec, defaultUnit) {
  let unit = defaultUnit;
  let s = ` ${spec.toLowerCase()} `
    .replace(/[×*]/g, 'x')
    .replace(/(\d)\s*(?:reps?|r)\b/g, '$1')
    .replace(/\s+for\s+/g, ' x ')
    .replace(/(\d)\s*sets?\s+of\s+/g, '$1x')
    .replace(/(\d)\s*sets?\b/g, '$1 sets');

  if (/\d\s*(?:kgs?|kilos?)\b|\b(?:kgs?|kilos?)\b/.test(s)) unit = 'kg';
  else if (/\d\s*(?:lbs?|pounds?|#)|\b(?:lbs?|pounds?)\b/.test(s)) unit = 'lb';

  s = s
    .replace(/\brpe\s*(\d+(?:\.\d+)?)/g, ' R$1 ')
    .replace(/(\d+):(\d{2})\b/g, (_, m, sec) => ` D${+m * 60 + +sec} `)
    .replace(/(\d+)\s*(?:s|sec|secs|seconds)\b/g, ' D$1 ')
    .replace(/(\d+)\s*(?:m|min|mins|minutes)\b/g, (_, m) => ` D${+m * 60} `)
    .replace(/(\d+(?:\.\d+)?)\s*(?:kgs?|kilos?|lbs?|pounds?|#)/g, ' W$1 ')
    .replace(/\b(?:kgs?|kilos?|lbs?|pounds?)\b/g, ' ')
    .replace(/\b(?:bw|bodyweight|body weight)\s*\+\s*w?(\d+(?:\.\d+)?)/g, ' B$1 ')
    .replace(/\b(?:bw|bodyweight|body weight)\b/g, ' B0 ')
    .replace(/(\d)\s*sets\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return { s, unit };
}

function weightToken(tok) {
  if (tok == null) return null;
  if (tok[0] === 'B') return { weight: parseFloat(tok.slice(1)), bodyweight: true };
  if (tok[0] === 'W') return { weight: parseFloat(tok.slice(1)), bodyweight: false, explicit: true };
  return { weight: parseFloat(tok), bodyweight: false };
}

function makeSets(count, repsTok, load, unit) {
  const sets = [];
  const isDur = repsTok[0] === 'D';
  const value = parseInt(isDur ? repsTok.slice(1) : repsTok, 10);
  for (let i = 0; i < count; i++) {
    sets.push({
      weight: load && !(load.bodyweight && load.weight === 0) ? load.weight : (load ? 0 : null),
      unit,
      reps: isDur ? null : value,
      durationS: isDur ? value : null,
      // Only an explicit "bw" marks bodyweight; "Curls 3x10" just has no load recorded.
      bodyweight: Boolean(load && load.bodyweight),
      rpe: null,
    });
  }
  return sets;
}

export function parseSpec(spec, defaultUnit = 'lb') {
  const { s, unit } = normalizeSpec(spec, defaultUnit);
  const sets = [];
  const unparsed = [];
  let load = null; // last weight seen on this line
  let lastSets = [];
  let pos = 0;

  const emit = (newSets) => {
    sets.push(...newSets);
    lastSets = newSets;
  };

  while (pos < s.length) {
    const sep = s.slice(pos).match(SEPARATOR);
    if (sep) { pos += sep[0].length; continue; }
    const rest = s.slice(pos);
    let matched = false;

    for (const [kind, re] of PATTERNS) {
      const m = rest.match(re);
      if (!m) continue;

      if (kind === 'wrs') {
        load = weightToken(m[1]);
        emit(makeSets(clampSets(+m[3]), m[2], load, unit));
      } else if (kind === 'sr@w') {
        if (+m[1] > MAX_SETS_PREFIX) continue; // "175x6 @8" is weight x reps + RPE
        load = weightToken(m[3]);
        emit(makeSets(clampSets(+m[1]), m[2], load, unit));
      } else if (kind === 'w sr') {
        if (+m[2] > MAX_SETS_PREFIX) continue;
        load = weightToken(m[1]);
        emit(makeSets(+m[2], m[3], load, unit));
      } else if (kind === 'sr w') {
        if (+m[1] > MAX_SETS_PREFIX) continue;
        load = weightToken(m[3]);
        emit(makeSets(+m[1], m[2], load, unit));
      } else if (kind === 'wr') {
        const first = weightToken(m[1]);
        const isSetsPrefix = m[1][0] !== 'W' && m[1][0] !== 'B'
          && Number.isInteger(first.weight) && first.weight <= MAX_SETS_PREFIX;
        if (isSetsPrefix) {
          // "3x8": sets x reps at whatever load is in effect (bodyweight if none)
          const newSets = makeSets(first.weight, m[2], load, unit);
          newSets.pendingLoad = !load;
          emit(newSets);
        } else {
          load = first;
          emit(makeSets(1, m[2], load, unit));
        }
      } else if (kind === '@') {
        const v = parseFloat(m[1]);
        if (lastSets.pendingLoad) {
          // "3x10 @ 50" written with extra spacing the sr@w pattern missed
          lastSets.forEach((st) => { st.weight = v; st.bodyweight = false; });
          lastSets.pendingLoad = false;
          load = { weight: v, bodyweight: false };
        } else if (v <= 10 && lastSets.length) {
          lastSets.forEach((st) => { st.rpe = v; });
        } else {
          load = { weight: v, bodyweight: false };
        }
      } else if (kind === 'rpe') {
        lastSets.forEach((st) => { st.rpe = parseFloat(m[1]); });
      } else if (kind === 'w') {
        load = weightToken(m[1]);
        if (lastSets.pendingLoad && !load.bodyweight) {
          lastSets.forEach((st) => { st.weight = load.weight; st.bodyweight = false; });
          lastSets.pendingLoad = false;
        }
      } else if (kind === 'dur') {
        emit(makeSets(1, m[0], load, unit));
      } else if (kind === 'n') {
        const v = parseFloat(m[1]);
        const more = /\d/.test(rest.slice(m[0].length));
        if (!load && more && v > 30) {
          // "Bench 135 10 8 6": a big leading number is the weight
          load = { weight: v, bodyweight: false };
        } else if (lastSets.pendingLoad && !more && v > MAX_SETS_PREFIX) {
          lastSets.forEach((st) => { st.weight = v; st.bodyweight = false; });
          lastSets.pendingLoad = false;
          load = { weight: v, bodyweight: false };
        } else {
          emit(makeSets(1, String(Math.round(v)), load, unit));
        }
      }
      pos += m[0].length;
      matched = true;
      break;
    }

    if (!matched) {
      const word = rest.match(/^\S+/)[0];
      if (!/^x$/.test(word)) unparsed.push(word);
      pos += word.length;
    }
  }

  return { sets: sets.map((st) => ({ ...st })), unparsed };
}

function clampSets(n) {
  return Math.max(1, Math.min(n, 20));
}
