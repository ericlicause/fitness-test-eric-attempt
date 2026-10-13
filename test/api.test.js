import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';

let server;
let base;
let store;

before(async () => {
  store = openDb(':memory:');
  server = http.createServer(createApp(store).handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  store.close();
});

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}

test('log, list, edit, analyze, export, import, delete', async () => {
  let r = await call('POST', '/api/workouts', { text: 'Push\nBench 135x10, 155x8', today: '2026-10-12' });
  assert.equal(r.status, 200);
  const [id] = r.data.ids;

  r = await call('POST', '/api/workouts', { text: '10/5 Legs\nSquat 225x5x3\n10/8\nSquat 235x5x3', today: '2026-10-13' });
  assert.equal(r.data.ids.length, 2);

  r = await call('GET', '/api/workouts');
  assert.equal(r.data.length, 3);
  assert.equal(r.data[0].date, '2026-10-12', 'newest first');
  const legs = r.data.find((w) => w.date === '2026-10-05');
  r = await call('GET', `/api/workouts/${legs.id}`);
  assert.match(r.data.rawText, /^10\/5 Legs/);
  assert.doesNotMatch(r.data.rawText, /235/, 'each workout keeps only its slice of the paste');

  r = await call('PUT', `/api/workouts/${id}`, { text: 'Push\nBench 135x10, 160x8', today: '2026-10-12' });
  assert.equal(r.status, 200);
  r = await call('GET', `/api/workouts/${id}`);
  assert.equal(r.data.exercises[0].sets[1].weight, 160);

  r = await call('GET', '/api/analytics?today=2026-10-13');
  assert.equal(r.data.overview.totalWorkouts, 3);
  assert.equal(r.data.exercises.find((e) => e.name === 'Squat').sessions, 2);

  r = await call('GET', `/api/exercises/${encodeURIComponent('Bench Press')}`);
  assert.equal(r.data.sessions.length, 1);

  r = await call('GET', '/api/coach/summary');
  assert.match(r.data.summary, /Squat/);

  const exported = await call('GET', '/api/export.json');
  const csv = await call('GET', '/api/export.csv');
  assert.match(csv.data, /^date,title,exercise/);
  assert.equal(csv.data.trim().split('\n').length, 1 + 2 + 3 + 3);

  r = await call('POST', '/api/import', exported.data);
  assert.deepEqual(r.data, { added: 0, skipped: 3 }, 'duplicates are skipped');

  r = await call('DELETE', `/api/workouts/${id}`);
  assert.equal(r.status, 200);
  r = await call('POST', '/api/import', exported.data);
  assert.equal(r.data.added, 1);
});

test('validation errors', async () => {
  let r = await call('POST', '/api/workouts', { text: 'just some words' });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/workouts/99999', { text: 'Bench 135x5' });
  assert.equal(r.status, 404);
  r = await call('PUT', '/api/settings', { unit: 'stone' });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/scan', { image: 'nope' });
  assert.equal(r.status, 400);
});

test('settings round-trip and static files', async () => {
  let r = await call('PUT', '/api/settings', { unit: 'kg', bodyweight: '80' });
  assert.equal(r.data.unit, 'kg');
  r = await call('GET', '/');
  assert.match(r.data, /<title>LiftLog<\/title>/);
  r = await call('GET', '/../package.json');
  assert.doesNotMatch(String(r.data), /"dependencies"/);
});
