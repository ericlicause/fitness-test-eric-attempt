import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkoutText, parseSpec, parseDateHeader } from '../src/parser.js';

const sets = (spec, unit) => parseSpec(spec, unit).sets.map((s) => [s.weight, s.reps ?? `${s.durationS}s`, s.bodyweight ? 'bw' : '', s.rpe ?? '']);

test('weight x reps lists', () => {
  assert.deepEqual(sets('135x10, 155x8, 175x6'), [[135, 10, '', ''], [155, 8, '', ''], [175, 6, '', '']]);
  assert.deepEqual(sets('135 x 10 155 x 8'), [[135, 10, '', ''], [155, 8, '', '']]);
  assert.deepEqual(sets('135 for 10'), [[135, 10, '', '']]);
});

test('bare numbers reuse the last weight', () => {
  assert.deepEqual(sets('95 x 8, 8, 7'), [[95, 8, '', ''], [95, 8, '', ''], [95, 7, '', '']]);
  assert.deepEqual(sets('95x8/8/7'), [[95, 8, '', ''], [95, 8, '', ''], [95, 7, '', '']]);
  assert.deepEqual(sets('135 10 8 6'), [[135, 10, '', ''], [135, 8, '', ''], [135, 6, '', '']]);
});

test('sets x reps notations', () => {
  assert.equal(sets('225x5x3').length, 3);
  assert.deepEqual(sets('225x5x3')[0], [225, 5, '', '']);
  assert.deepEqual(sets('3x10 @ 50'), Array(3).fill([50, 10, '', '']));
  assert.deepEqual(sets('225 5x5'), Array(5).fill([225, 5, '', '']));
  assert.deepEqual(sets('5x5 225'), Array(5).fill([225, 5, '', '']));
  assert.deepEqual(sets('3 sets of 10 at 30'), Array(3).fill([30, 10, '', '']));
  assert.deepEqual(sets('4x12 270'), Array(4).fill([270, 12, '', '']));
});

test('bodyweight, reps-only and timed sets', () => {
  assert.deepEqual(sets('bw x 12, 10'), [[0, 12, 'bw', ''], [0, 10, 'bw', '']]);
  assert.deepEqual(sets('bw+25 x 6'), [[25, 6, 'bw', '']]);
  assert.deepEqual(sets('20, 15, 12'), [[null, 20, '', ''], [null, 15, '', ''], [null, 12, '', '']]);
  assert.deepEqual(sets('3x8'), Array(3).fill([null, 8, '', '']));
  assert.deepEqual(sets('3x60s'), Array(3).fill([null, '60s', '', '']));
  assert.deepEqual(sets('1:30, 2min'), [[null, '90s', '', ''], [null, '120s', '', '']]);
});

test('RPE and units', () => {
  assert.deepEqual(sets('175x6 @8'), [[175, 6, '', 8]]);
  assert.deepEqual(sets('135x10 rpe 7.5'), [[135, 10, '', 7.5]]);
  const kg = parseSpec('60kg x 8', 'lb').sets[0];
  assert.equal(kg.unit, 'kg');
  assert.equal(kg.weight, 60);
  assert.deepEqual(sets('15lb x 15, 12'), [[15, 15, '', ''], [15, 12, '', '']]);
  assert.equal(parseSpec('100x5', 'kg').sets[0].unit, 'kg');
});

test('dates', () => {
  assert.equal(parseDateHeader('2026-10-12 Push', '2026-10-13').date, '2026-10-12');
  assert.equal(parseDateHeader('10/12 Push', '2026-10-13').date, '2026-10-12');
  assert.equal(parseDateHeader('Mon 10/12', '2026-10-13').date, '2026-10-12');
  assert.equal(parseDateHeader('12/30', '2026-10-13').date, '2025-12-30', 'future month/day means last year');
  assert.equal(parseDateHeader('Oct 3rd', '2026-10-13').date, '2026-10-03');
  assert.equal(parseDateHeader('10/12/25', '2026-10-13').date, '2025-10-12');
  assert.equal(parseDateHeader('Decline bench 135x10', '2026-10-13'), null);
  assert.equal(parseDateHeader('2/30', '2026-10-13'), null);
});

test('full workout text', () => {
  const { workouts, warnings } = parseWorkoutText(`Push day
Bench press: 135x10, 155x8, 175x6 @8
- Incline DB 3x10 @ 50 (slow eccentric)
OHP
95x8
95x7
Dips bw x 12, 10
Notes: felt strong`, { today: '2026-10-13' });
  assert.equal(workouts.length, 1);
  const w = workouts[0];
  assert.equal(w.date, '2026-10-13');
  assert.equal(w.title, 'Push day');
  assert.equal(w.notes, 'felt strong');
  assert.deepEqual(w.exercises.map((e) => e.name), ['Bench Press', 'Incline Dumbbell Press', 'Overhead Press', 'Dip']);
  assert.equal(w.exercises[1].note, 'slow eccentric');
  assert.equal(w.exercises[2].sets.length, 2);
  assert.deepEqual(warnings, []);
});

test('multiple dated workouts in one paste', () => {
  const { workouts } = parseWorkoutText(`10/10 Legs
Squat 225x5x3
10/12 Push
Bench 155x8`, { today: '2026-10-13' });
  assert.deepEqual(workouts.map((w) => [w.date, w.title, w.exercises.length]), [['2026-10-10', 'Legs', 1], ['2026-10-12', 'Push', 1]]);
});

test('warnings for unreadable lines', () => {
  const { warnings } = parseWorkoutText('Bench 135x10 banana\nCurls\nSquat 225x5', { today: '2026-10-13' });
  assert.ok(warnings.some((w) => /banana/.test(w.message)));
  assert.ok(warnings.some((w) => /No sets found for "Curls"/.test(w.message)));
});

test('consecutive lines of the same exercise merge', () => {
  const { workouts } = parseWorkoutText('Bench 135x10\nbench 155x8', { today: '2026-10-13' });
  assert.equal(workouts[0].exercises.length, 1);
  assert.equal(workouts[0].exercises[0].sets.length, 2);
});
