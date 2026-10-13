// LiftLog HTTP server: JSON API + static frontend, no framework.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { parseWorkoutText, isoToday } from './parser.js';
import { computeAnalytics, exerciseHistory, coachingSummary } from './analytics.js';
import { normalizeExerciseName } from './exercises.js';
import { aiEnabled, transcribeImage, generatePlan, AiError } from './ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const MAX_BODY = 12 * 1024 * 1024; // photos are downscaled client-side, this is headroom

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp(store) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  const unit = () => store.getSettings().unit;
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  // Clients send their local date so "today" and year inference match the user's timezone.
  const today = (req) => (isDate(req.body?.today) ? req.body.today : isDate(req.query.get('today')) ? req.query.get('today') : isoToday());

  route('GET', '/api/health', () => ({ ok: true, ai: aiEnabled() }));

  route('GET', '/api/settings', () => store.getSettings());
  route('PUT', '/api/settings', (req) => {
    const patch = { ...req.body };
    if (patch.unit && !['lb', 'kg'].includes(patch.unit)) throw new HttpError(400, 'unit must be lb or kg');
    return store.updateSettings(patch);
  });

  route('POST', '/api/parse', (req) => {
    return parseWorkoutText(req.body.text, { defaultUnit: unit(), today: today(req) });
  });

  route('GET', '/api/workouts', () => {
    return store.allWorkouts().reverse().map(summarizeWorkout);
  });

  route('POST', '/api/workouts', (req) => {
    const { text } = req.body;
    const parsed = parseWorkoutText(text, { defaultUnit: unit(), today: today(req) });
    const usable = parsed.workouts.filter((w) => w.exercises.length);
    if (!usable.length) throw new HttpError(400, 'No exercises found in that text.');
    // Each workout keeps only its own slice of the pasted text so it can be
    // edited later on its own.
    const chunks = usable.length === 1 ? [text] : splitByWorkout(text, usable.length);
    const ids = store.transaction(() => usable.map((w, i) => store.insertWorkout(w, chunks[i] ?? text)));
    return { ids, warnings: parsed.warnings };
  });

  route('GET', '/api/workouts/:id', (req) => {
    const w = store.getWorkout(+req.params.id);
    if (!w) throw new HttpError(404, 'Workout not found');
    return w;
  });

  route('PUT', '/api/workouts/:id', (req) => {
    const parsed = parseWorkoutText(req.body.text, { defaultUnit: unit(), today: today(req) });
    const usable = parsed.workouts.filter((w) => w.exercises.length);
    if (usable.length !== 1) throw new HttpError(400, usable.length ? 'Edit one workout at a time.' : 'No exercises found in that text.');
    const ok = store.transaction(() => store.replaceWorkout(+req.params.id, usable[0], req.body.text));
    if (!ok) throw new HttpError(404, 'Workout not found');
    return { id: +req.params.id, warnings: parsed.warnings };
  });

  route('DELETE', '/api/workouts/:id', (req) => {
    if (!store.deleteWorkout(+req.params.id)) throw new HttpError(404, 'Workout not found');
    return { ok: true };
  });

  route('GET', '/api/analytics', (req) => computeAnalytics(store.allWorkouts(), { unit: unit(), today: today(req) }));

  route('GET', '/api/exercises/:name', (req) => {
    return exerciseHistory(store.allWorkouts(), decodeURIComponent(req.params.name), { unit: unit(), today: today(req) });
  });

  route('POST', '/api/exercises/rename', (req) => {
    const from = String(req.body.from || '');
    const to = normalizeExerciseName(String(req.body.to || ''));
    if (!from || !to) throw new HttpError(400, 'from and to are required');
    return { changed: store.renameExercise(from, to), to };
  });

  route('GET', '/api/coach/summary', (req) => {
    const a = computeAnalytics(store.allWorkouts(), { unit: unit(), today: today(req) });
    return { summary: coachingSummary(a, store.getSettings()) };
  });

  route('POST', '/api/coach/plan', async (req) => {
    const settings = store.getSettings();
    const a = computeAnalytics(store.allWorkouts(), { unit: settings.unit, today: today(req) });
    if (!a.overview.totalWorkouts) throw new HttpError(400, 'Log a few workouts first.');
    const plan = await generatePlan(coachingSummary(a, settings), req.body.goals || '');
    return { plan };
  });

  route('POST', '/api/scan', async (req) => {
    const m = String(req.body.image || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!m) throw new HttpError(400, 'Expected a base64 image data URL');
    return { text: await transcribeImage(m[2], m[1]) };
  });

  route('GET', '/api/export.json', () => {
    const data = {
      app: 'liftlog',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: store.getSettings(),
      workouts: store.allWorkouts().map(({ id, createdAt, ...w }) => w),
    };
    return { __download: { name: `liftlog-${isoToday()}.json`, type: 'application/json', body: JSON.stringify(data, null, 2) } };
  });

  route('GET', '/api/export.csv', () => {
    const rows = [['date', 'title', 'exercise', 'muscle_group', 'set', 'weight', 'unit', 'reps', 'duration_s', 'bodyweight', 'rpe', 'note']];
    for (const w of store.allWorkouts()) {
      for (const ex of w.exercises) {
        ex.sets.forEach((s, i) => rows.push([w.date, w.title, ex.name, ex.group, i + 1, s.weight ?? '', s.unit, s.reps ?? '', s.durationS ?? '', s.bodyweight ? 1 : 0, s.rpe ?? '', ex.note]));
      }
    }
    const body = rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    return { __download: { name: `liftlog-${isoToday()}.csv`, type: 'text/csv', body } };
  });

  route('POST', '/api/import', (req) => {
    const workouts = req.body?.workouts;
    if (!Array.isArray(workouts)) throw new HttpError(400, 'Expected a LiftLog JSON export with a "workouts" array');
    const existing = new Set(store.allWorkouts().map(fingerprint));
    let added = 0;
    let skipped = 0;
    store.transaction(() => {
      for (const w of workouts) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date || '') || !Array.isArray(w.exercises)) { skipped++; continue; }
        const clean = {
          date: w.date,
          title: String(w.title || ''),
          notes: String(w.notes || ''),
          exercises: w.exercises.map((ex) => ({
            name: normalizeExerciseName(String(ex.name || '')) || 'Unknown',
            note: String(ex.note || ''),
            sets: (ex.sets || []).map((s) => ({
              weight: num(s.weight),
              unit: s.unit === 'kg' ? 'kg' : 'lb',
              reps: num(s.reps),
              durationS: num(s.durationS),
              bodyweight: !!s.bodyweight,
              rpe: num(s.rpe),
            })),
          })),
        };
        if (existing.has(fingerprint(clean))) { skipped++; continue; }
        store.insertWorkout(clean, String(w.rawText || ''));
        existing.add(fingerprint(clean));
        added++;
      }
    });
    if (req.body.settings) store.updateSettings(req.body.settings);
    return { added, skipped };
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return sendJson(res, 404, { error: 'Not found' });
    const m = url.pathname.match(r.re);
    req.params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    req.query = url.searchParams;
    try {
      req.body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const out = await r.handler(req);
      if (out && out.__download) {
        const d = out.__download;
        res.writeHead(200, { 'Content-Type': d.type, 'Content-Disposition': `attachment; filename="${d.name}"` });
        return res.end(d.body);
      }
      sendJson(res, 200, out);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof AiError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  }

  return { handle };
}

function summarizeWorkout(w) {
  let sets = 0;
  for (const ex of w.exercises) sets += ex.sets.length;
  return {
    id: w.id,
    date: w.date,
    title: w.title,
    notes: w.notes,
    exerciseCount: w.exercises.length,
    setCount: sets,
    exercises: w.exercises.map((ex) => ({ name: ex.name, group: ex.group, note: ex.note, sets: ex.sets })),
  };
}

// Split pasted text into per-workout chunks at date-header lines.
function splitByWorkout(text, expected) {
  const lines = String(text).split(/\r?\n/);
  const chunks = [];
  let cur = [];
  for (const line of lines) {
    if (cur.some((l) => l.trim()) && isDateLine(line)) {
      chunks.push(cur.join('\n'));
      cur = [];
    }
    cur.push(line);
  }
  chunks.push(cur.join('\n'));
  const nonEmpty = chunks.filter((c) => parseWorkoutText(c).workouts.some((w) => w.exercises.length));
  return nonEmpty.length === expected ? nonEmpty : [];
}

function isDateLine(line) {
  const r = parseWorkoutText(line, { today: '2000-01-01' });
  return r.workouts.length === 1 && r.workouts[0].date !== '2000-01-01' && !r.workouts[0].exercises.length;
}

function fingerprint(w) {
  return JSON.stringify([w.date, w.exercises.map((ex) => [ex.name, ex.sets.map((s) => [s.weight, s.reps, s.durationS])])]);
}

function num(v) {
  const n = Number(v);
  return v == null || v === '' || Number.isNaN(n) ? null : n;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] });
        res.end(e2 ? 'Not found' : html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dbFlag = process.argv.indexOf('--db');
  const dbPath = (dbFlag > -1 && process.argv[dbFlag + 1]) || process.env.LIFTLOG_DB || path.join(here, '..', 'data', 'liftlog.db');
  const store = openDb(dbPath);
  const app = createApp(store);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  http.createServer(app.handle).listen(port, host, () => {
    console.log(`LiftLog running at http://localhost:${port}  (db: ${dbPath}, AI: ${aiEnabled() ? 'on' : 'off'})`);
  });
}
