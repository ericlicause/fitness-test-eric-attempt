import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalytics, exerciseHistory, estimate1RM, weekStart, coachingSummary } from '../src/analytics.js';
import { parseWorkoutText } from '../src/parser.js';

let nextId = 1;
function log(date, text) {
  const w = parseWorkoutText(text, { today: date }).workouts[0];
  return { ...w, id: nextId++, exercises: w.exercises };
}

test('estimate1RM (Epley)', () => {
  assert.equal(estimate1RM(100, 1), 100);
  assert.equal(Math.round(estimate1RM(100, 10)), 133);
  assert.equal(estimate1RM(100, 15), null);
  assert.equal(estimate1RM(0, 5), null);
});

test('weekStart is Monday', () => {
  assert.equal(weekStart('2026-10-13'), '2026-10-12'); // Tuesday
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekStart('2026-10-18'), '2026-10-12'); // Sunday
});

test('progressing lift, PRs and next target', () => {
  const ws = [
    log('2026-09-01', 'Bench 135x8, 135x8'),
    log('2026-09-08', 'Bench 140x8, 140x8'),
    log('2026-09-15', 'Bench 145x8'),
    log('2026-09-22', 'Bench 150x8'),
  ];
  const a = computeAnalytics(ws, { today: '2026-09-23' });
  const bench = a.exercises.find((e) => e.name === 'Bench Press');
  assert.equal(bench.status, 'progressing');
  assert.ok(bench.trendPctPerMonth > 5);
  assert.equal(a.prs.length, 3);
  assert.equal(bench.next.text, '155 lb x 6', 'top of 6-8 range -> add 5 lb');
});

test('stalled lift gets a deload suggestion', () => {
  const ws = [
    log('2026-09-01', 'Squat 225x5'),
    log('2026-09-04', 'Squat 235x5'),
    log('2026-09-08', 'Squat 235x4'),
    log('2026-09-11', 'Squat 235x4'),
    log('2026-09-15', 'Squat 230x5'),
    log('2026-09-18', 'Squat 235x4'),
  ];
  const h = exerciseHistory(ws, 'Squat', { today: '2026-09-19' });
  assert.equal(h.status, 'stalled');
  assert.match(h.next.text, /^Deload/);
  const a = computeAnalytics(ws, { today: '2026-09-19' });
  assert.ok(a.insights.some((i) => i.title.includes('Squat') && /last 4 sessions/.test(i.detail)));
});

test('bodyweight and timed exercises track reps / duration', () => {
  const ws = [log('2026-09-01', 'Pullups bw x 8, 6\nPlank 45s'), log('2026-09-03', 'Pullups bw x 10\nPlank 60s')];
  const a = computeAnalytics(ws, { today: '2026-09-04' });
  const pu = a.exercises.find((e) => e.name === 'Pull-up');
  assert.equal(pu.kind, 'reps');
  assert.equal(pu.best, 10);
  const plank = a.exercises.find((e) => e.name === 'Plank');
  assert.equal(plank.kind, 'time');
  assert.equal(plank.best, 60);
});

test('kg sets convert to the display unit', () => {
  const ws = [log('2026-09-01', 'Deadlift 100kg x 1')];
  const a = computeAnalytics(ws, { unit: 'lb', today: '2026-09-02' });
  assert.equal(a.exercises[0].best, 220.5); // 100 kg = 220.46 lb
});

test('rep ranges, muscle volume, imbalance insights and summary', () => {
  const ws = [];
  for (let d = 1; d <= 22; d += 3) {
    const day = String(d).padStart(2, '0');
    ws.push(log(`2026-09-${day}`, 'Bench 185x5, 185x5, 185x5\nOHP 115x8, 115x8\nDips bw x 12, 12'));
  }
  const a = computeAnalytics(ws, { today: '2026-09-23' });
  assert.ok(a.repRanges.last4w.strength > 0);
  assert.ok(a.muscleSets.find((m) => m.group === 'Chest').setsPerWeek > 5);
  assert.ok(a.insights.some((i) => /back\/biceps/.test(i.title)));
  assert.ok(a.insights.some((i) => /No leg training/.test(i.title)));
  const summary = coachingSummary(a, { goals: 'Bench 225', bodyweight: '180' });
  assert.match(summary, /Goals: Bench 225/);
  assert.match(summary, /Bench Press \(Chest\)/);
});

test('empty log', () => {
  const a = computeAnalytics([], { today: '2026-09-23' });
  assert.equal(a.overview.totalWorkouts, 0);
  assert.equal(a.insights.length, 1);
});
