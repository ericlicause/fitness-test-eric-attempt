// SQLite storage via Node's built-in node:sqlite (no native deps).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { muscleGroupFor } from './exercises.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  raw_text   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise    TEXT NOT NULL,
  ex_order    INTEGER NOT NULL,
  ex_note     TEXT NOT NULL DEFAULT '',
  set_number  INTEGER NOT NULL,
  weight      REAL,
  unit        TEXT NOT NULL DEFAULT 'lb',
  reps        INTEGER,
  duration_s  INTEGER,
  bodyweight  INTEGER NOT NULL DEFAULT 0,
  rpe         REAL
);
CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise);
CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(date);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = { unit: 'lb', bodyweight: '', goals: '' };

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return new Store(db);
}

class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // workout: { date, title, notes, exercises: [{ name, note, sets: [...] }] }
  insertWorkout(workout, rawText = '') {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO workouts (date, title, notes, raw_text) VALUES (?, ?, ?, ?)')
      .run(workout.date, workout.title || '', workout.notes || '', rawText);
    this.#insertSets(Number(lastInsertRowid), workout.exercises);
    return Number(lastInsertRowid);
  }

  replaceWorkout(id, workout, rawText = '') {
    const res = this.db
      .prepare('UPDATE workouts SET date = ?, title = ?, notes = ?, raw_text = ? WHERE id = ?')
      .run(workout.date, workout.title || '', workout.notes || '', rawText, id);
    if (!res.changes) return false;
    this.db.prepare('DELETE FROM sets WHERE workout_id = ?').run(id);
    this.#insertSets(id, workout.exercises);
    return true;
  }

  #insertSets(workoutId, exercises) {
    const stmt = this.db.prepare(`INSERT INTO sets
      (workout_id, exercise, ex_order, ex_note, set_number, weight, unit, reps, duration_s, bodyweight, rpe)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    exercises.forEach((ex, exIdx) => {
      ex.sets.forEach((s, setIdx) => {
        stmt.run(workoutId, ex.name, exIdx, ex.note || '', setIdx + 1,
          s.weight ?? null, s.unit || 'lb', s.reps ?? null, s.durationS ?? null,
          s.bodyweight ? 1 : 0, s.rpe ?? null);
      });
    });
  }

  deleteWorkout(id) {
    return this.db.prepare('DELETE FROM workouts WHERE id = ?').run(id).changes > 0;
  }

  getWorkout(id) {
    const w = this.db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
    if (!w) return null;
    const rows = this.db.prepare('SELECT * FROM sets WHERE workout_id = ? ORDER BY ex_order, set_number').all(id);
    return hydrate(w, rows);
  }

  // All workouts with their exercises, oldest first. A personal log stays
  // small enough (thousands of sets) that analytics can run in memory.
  allWorkouts() {
    const workouts = this.db.prepare('SELECT * FROM workouts ORDER BY date, id').all();
    const rows = this.db.prepare('SELECT * FROM sets ORDER BY workout_id, ex_order, set_number').all();
    const byWorkout = new Map();
    for (const r of rows) {
      if (!byWorkout.has(r.workout_id)) byWorkout.set(r.workout_id, []);
      byWorkout.get(r.workout_id).push(r);
    }
    return workouts.map((w) => hydrate(w, byWorkout.get(w.id) || []));
  }

  renameExercise(from, to) {
    return this.db.prepare('UPDATE sets SET exercise = ? WHERE exercise = ?').run(to, from).changes;
  }

  getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    for (const { key, value } of this.db.prepare('SELECT key, value FROM settings').all()) out[key] = value;
    return out;
  }

  updateSettings(patch) {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_SETTINGS) stmt.run(k, String(v ?? ''));
    }
    return this.getSettings();
  }
}

function hydrate(w, rows) {
  const exercises = [];
  let current = null;
  for (const r of rows) {
    if (!current || current.order !== r.ex_order) {
      current = { name: r.exercise, group: muscleGroupFor(r.exercise), note: r.ex_note, order: r.ex_order, sets: [] };
      exercises.push(current);
    }
    current.sets.push({
      weight: r.weight,
      unit: r.unit,
      reps: r.reps,
      durationS: r.duration_s,
      bodyweight: !!r.bodyweight,
      rpe: r.rpe,
    });
  }
  return {
    id: w.id,
    date: w.date,
    title: w.title,
    notes: w.notes,
    rawText: w.raw_text,
    createdAt: w.created_at,
    exercises: exercises.map(({ order, ...ex }) => ex),
  };
}
