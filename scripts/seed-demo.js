// Fills a database with ~10 weeks of realistic push/pull/legs training so you
// can try the dashboards before you have your own history.
//
//   npm run demo        (writes data/demo.db and starts the server on it)

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { parseWorkoutText, isoToday } from '../src/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.LIFTLOG_DB || path.join(here, '..', 'data', 'demo.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
const store = openDb(file);

// Deterministic pseudo-random so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const r5 = (n) => Math.round(n / 5) * 5;

const DAYS = [
  {
    title: 'Push',
    lifts: [
      ['Bench', 145, 2.2, 3, 8], ['Incline DB', 45, 0.6, 3, 10], ['OHP', 85, 0.9, 3, 8],
      ['Lateral raise', 15, 0.15, 3, 15], ['Pushdowns', 40, 0.5, 3, 12],
    ],
  },
  {
    title: 'Pull',
    lifts: [
      ['Deadlift', 225, 3.5, 1, 5], ['Pullups', 'bw', 0, 3, 7], ['BB row', 115, 1.4, 3, 10],
      ['Face pulls', 30, 0.3, 3, 15], ['DB curl', 25, 0.25, 3, 10],
    ],
  },
  {
    title: 'Legs',
    lifts: [
      ['Squat', 185, 3, 3, 5], ['RDL', 135, 2, 3, 8], ['Leg press', 270, 3, 3, 12],
      ['Calf raise', 90, 1, 3, 15], ['Plank', 'time', 0, 2, 45],
    ],
  },
];

const today = isoToday();
const start = new Date(`${today}T00:00:00Z`);
start.setUTCDate(start.getUTCDate() - 7 * 10);
const training = [1, 3, 5]; // Mon/Wed/Fri
let session = 0;

for (let d = new Date(start); d.toISOString().slice(0, 10) < today; d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay();
  const extraSaturday = dow === 6 && rand() < 0.35;
  if (!training.includes(dow) && !extraSaturday) continue;
  if (rand() < 0.1) continue; // missed a day
  const date = d.toISOString().slice(0, 10);
  const day = DAYS[session % 3];
  const week = Math.floor(session / 3);
  session++;

  const lines = [`${date} ${day.title}`];
  for (const [name, base, perWeek, nSets, reps] of day.lifts) {
    if (base === 'bw') {
      const r = reps + Math.floor(week / 2);
      lines.push(`${name} bw x ${r}, ${r - 1}, ${r - 2}`);
    } else if (base === 'time') {
      lines.push(`${name} ${Array(nSets).fill(`${reps + week * 5}s`).join(', ')}`);
    } else {
      // Squat stalls for the last few weeks to show off the stall detection.
      const effectiveWeek = name === 'Squat' ? Math.min(week, 6) : week;
      const w = r5(base + perWeek * effectiveWeek + (rand() - 0.5) * 4);
      const setReps = Array.from({ length: nSets }, (_, i) => Math.max(1, reps - (i === nSets - 1 && rand() < 0.4 ? 1 : 0)));
      const rpe = name === 'Bench' || name === 'Squat' ? ` @${(7.5 + rand() * 1.5).toFixed(1).replace(/\.0$/, '')}` : '';
      lines.push(`${name} ${w} x ${setReps.join(', ')}${rpe}`);
    }
  }
  if (rand() < 0.2) lines.push('Notes: low sleep, felt flat');
  const text = lines.join('\n');
  const { workouts } = parseWorkoutText(text, { today });
  store.insertWorkout(workouts[0], text);
}

console.log(`Seeded ${session} workouts into ${file}`);
store.close();
