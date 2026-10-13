import { lineChart, barChart, hbarChart, sparkline, hideTip } from './charts.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  settings: { unit: 'lb' },
  ai: false,
  editingId: null,
  workouts: [],
  analytics: null,
  selectedExercise: null,
};

// ------------------------------------------------------------ utilities

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, opts);
}

function num(n) {
  return n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setChip(s) {
  let body;
  if (s.durationS) {
    body = (s.weight ? `${num(s.weight)} × ` : '') + fmtDuration(s.durationS);
  } else if (s.bodyweight) {
    body = `${s.weight ? `BW+${num(s.weight)}` : 'BW'} × ${s.reps}`;
  } else if (s.weight == null) {
    body = `× ${s.reps}`;
  } else {
    body = `${num(s.weight)}${s.unit !== state.settings.unit ? s.unit : ''} × ${s.reps}`;
  }
  const rpe = s.rpe ? ` <span class="rpe">@${s.rpe}</span>` : '';
  return `<span class="chip">${body}${rpe}</span>`;
}

function exerciseRows(exercises) {
  return exercises.map((ex) => `
    <div class="ex-line">
      <div class="ex-name">${esc(ex.name)}<span class="grp">${esc(ex.group)}</span></div>
      <div class="sets">${ex.sets.map(setChip).join('')}</div>
      ${ex.note ? `<div class="ex-note">${esc(ex.note)}</div>` : ''}
    </div>`).join('');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function setStatus(elm, msg, isError = false) {
  elm.hidden = !msg;
  elm.textContent = msg || '';
  elm.classList.toggle('error', isError);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ----------------------------------------------------------------- tabs

const loaders = {
  history: loadHistory,
  progress: loadProgress,
  insights: loadInsights,
  coach: loadCoach,
  settings: loadSettingsForm,
};

function showTab(name, push = true) {
  hideTip();
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  if (push) history.replaceState(null, '', `#${name}`);
  loaders[name]?.();
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ log

const logText = $('#log-text');
const logDate = $('#log-date');
const DRAFT_KEY = 'liftlog.draft';

function saveDraft() {
  if (state.editingId) return;
  try { localStorage.setItem(DRAFT_KEY, logText.value); } catch { /* storage unavailable */ }
}

const refreshPreview = debounce(async () => {
  const text = logText.value;
  if (!text.trim()) {
    $('#preview').innerHTML = '<p class="muted">Start typing to see the parsed workout.</p>';
    $('#warnings').innerHTML = '';
    $('#preview-count').textContent = '';
    $('#save-btn').disabled = true;
    return;
  }
  try {
    const result = await api('/api/parse', { method: 'POST', body: { text, today: logDate.value || today() } });
    renderPreview(result);
  } catch (err) {
    $('#preview').innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}, 250);

function renderPreview({ workouts, warnings }) {
  const usable = workouts.filter((w) => w.exercises.length);
  const html = usable.map((w) => {
    const sets = w.exercises.reduce((a, e) => a + e.sets.length, 0);
    return `<div class="workout">
      <div class="workout-head">
        <span><span class="date">${esc(fmtDate(w.date))}</span>${w.title ? ` · ${esc(w.title)}` : ''}</span>
        <span class="muted small">${w.exercises.length} exercises · ${sets} sets</span>
      </div>
      ${exerciseRows(w.exercises)}
      ${w.notes ? `<p class="muted small">Notes: ${esc(w.notes)}</p>` : ''}
    </div>`;
  }).join('');
  $('#preview').innerHTML = html || '<p class="muted">No exercises recognized yet.</p>';
  $('#preview-count').textContent = usable.length > 1 ? `${usable.length} workouts` : '';
  $('#warnings').innerHTML = warnings.map((w) => `<li>Line ${w.line}: ${esc(w.message)}</li>`).join('');
  const btn = $('#save-btn');
  btn.disabled = !usable.length;
  btn.textContent = state.editingId ? 'Save changes' : usable.length > 1 ? `Save ${usable.length} workouts` : 'Save workout';
}

logText.addEventListener('input', () => { saveDraft(); refreshPreview(); });
logDate.addEventListener('change', refreshPreview);

$('#save-btn').addEventListener('click', async () => {
  const btn = $('#save-btn');
  btn.disabled = true;
  try {
    // The date picker is the date for any workout without a date line.
    const body = { text: logText.value, today: logDate.value || today() };
    if (state.editingId) {
      await api(`/api/workouts/${state.editingId}`, { method: 'PUT', body });
      toast('Workout updated');
    } else {
      const res = await api('/api/workouts', { method: 'POST', body });
      toast(res.ids.length > 1 ? `Saved ${res.ids.length} workouts` : 'Workout saved 💪');
    }
    resetLog();
    state.analytics = null;
    showTab('history');
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

function resetLog() {
  state.editingId = null;
  logText.value = '';
  logDate.value = today();
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  $('#log-heading').textContent = 'Log a workout';
  $('#cancel-edit').hidden = true;
  refreshPreview();
}

$('#cancel-edit').addEventListener('click', resetLog);

async function editWorkout(id) {
  const w = await api(`/api/workouts/${id}`);
  state.editingId = id;
  logDate.value = w.date;
  logText.value = w.rawText || workoutToText(w);
  $('#log-heading').textContent = `Edit workout · ${fmtDate(w.date)}`;
  $('#cancel-edit').hidden = false;
  showTab('log');
  refreshPreview();
}

// Rebuild shorthand for workouts that were imported without their raw text.
function workoutToText(w) {
  const lines = [];
  if (w.title) lines.push(w.title);
  for (const ex of w.exercises) {
    const sets = ex.sets.map((s) => {
      const load = s.bodyweight ? (s.weight ? `bw+${s.weight}` : 'bw') : s.weight != null ? `${s.weight}${s.unit !== state.settings.unit ? s.unit : ''}` : '';
      const amount = s.durationS ? `${s.durationS}s` : s.reps;
      const rpe = s.rpe ? ` @${s.rpe}` : '';
      return (load ? `${load}x${amount}` : `${amount}`) + rpe;
    });
    lines.push(`${ex.name}: ${sets.join(', ')}${ex.note ? ` (${ex.note})` : ''}`);
  }
  if (w.notes) lines.push(`Notes: ${w.notes}`);
  return lines.join('\n');
}

// ----------------------------------------------------------- photo scan

$('#scan-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const status = $('#scan-status');
  setStatus(status, 'Reading your notepad… this takes a few seconds.');
  try {
    const image = await downscale(file, 1600);
    const { text } = await api('/api/scan', { method: 'POST', body: { image } });
    logText.value = logText.value.trim() ? `${logText.value.trim()}\n${text}` : text;
    saveDraft();
    refreshPreview();
    setStatus(status, 'Transcribed — check the text against your page before saving.');
  } catch (err) {
    setStatus(status, err.message, true);
  }
});

function downscale(file, maxDim) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that image.")); };
    img.src = url;
  });
}

// -------------------------------------------------------------- history

async function loadHistory() {
  state.workouts = await api('/api/workouts');
  renderHistory();
}

function renderHistory() {
  const q = $('#history-filter').value.trim().toLowerCase();
  const list = state.workouts.filter((w) => !q
    || w.title.toLowerCase().includes(q)
    || w.exercises.some((e) => e.name.toLowerCase().includes(q) || e.group.toLowerCase().includes(q)));
  if (!state.workouts.length) {
    $('#history-list').innerHTML = '<div class="card empty">No workouts yet. Log your first one on the <a href="#log" data-goto="log">Log</a> tab.</div>';
    return;
  }
  $('#history-list').innerHTML = list.map((w) => `
    <article class="card workout">
      <div class="workout-head">
        <span><span class="date">${esc(fmtDate(w.date))}</span>${w.title ? ` · ${esc(w.title)}` : ''}</span>
        <span class="actions">
          <button class="link" data-edit="${w.id}">Edit</button>
          <button class="link danger" data-delete="${w.id}">Delete</button>
        </span>
      </div>
      ${exerciseRows(w.exercises)}
      ${w.notes ? `<p class="muted small" style="margin:6px 0 0">Notes: ${esc(w.notes)}</p>` : ''}
    </article>`).join('') || '<p class="muted">No workouts match that filter.</p>';
}

$('#history-filter').addEventListener('input', renderHistory);
$('#history-list').addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.dataset.goto) { ev.preventDefault(); showTab(t.dataset.goto); }
  if (t.dataset.edit) editWorkout(+t.dataset.edit);
  if (t.dataset.delete) {
    if (!confirm('Delete this workout? This cannot be undone.')) return;
    await api(`/api/workouts/${t.dataset.delete}`, { method: 'DELETE' });
    state.analytics = null;
    toast('Workout deleted');
    loadHistory();
  }
});

// ------------------------------------------------------------- progress

async function getAnalytics() {
  if (!state.analytics) state.analytics = await api(`/api/analytics?today=${today()}`);
  return state.analytics;
}

async function loadProgress() {
  const a = await getAnalytics();
  const sel = $('#exercise-select');
  if (!a.exercises.length) {
    sel.hidden = true;
    $('#progress-body').innerHTML = '<div class="card empty">Log a workout to start tracking progress.</div>';
    return;
  }
  sel.hidden = false;
  if (!state.selectedExercise || !a.exercises.some((e) => e.name === state.selectedExercise)) {
    state.selectedExercise = a.exercises[0].name;
  }
  sel.innerHTML = a.exercises.map((e) => `<option value="${esc(e.name)}">${esc(e.name)} (${e.sessions})</option>`).join('');
  sel.value = state.selectedExercise;
  renderExercise(state.selectedExercise);
}

$('#exercise-select').addEventListener('change', (ev) => {
  state.selectedExercise = ev.target.value;
  renderExercise(ev.target.value);
});

const STATUS_TEXT = {
  progressing: 'Progressing', stalled: 'Stalled', regressing: 'Slipping', new: 'Building history', inactive: 'Inactive',
};

async function renderExercise(name) {
  const h = await api(`/api/exercises/${encodeURIComponent(name)}?today=${today()}`);
  const u = h.unit;
  const sessions = h.sessions.filter((s) => s.metric != null);
  const metricName = h.kind === 'load' ? 'Estimated 1RM' : h.kind === 'time' ? 'Best hold' : 'Best set (reps)';
  const suffix = h.kind === 'load' ? ` ${u}` : h.kind === 'time' ? 's' : '';
  const last = h.sessions.at(-1);
  const prSet = new Set(h.prDates);
  const rr = h.repRanges;
  const rrTotal = rr.strength + rr.hypertrophy + rr.endurance;
  const trend = h.trendPctPerMonth;

  $('#progress-body').innerHTML = `
    <div class="grid tiles">
      <div class="tile"><div class="label">${metricName} · best</div><div class="value">${num(h.best)}${suffix}</div><div class="sub">${h.prDates.length} PR${h.prDates.length === 1 ? '' : 's'} logged</div></div>
      <div class="tile"><div class="label">Last top set</div><div class="value">${last?.topSet ? `${num(last.topSet.weight)} × ${last.topSet.reps}` : h.kind === 'time' ? fmtDuration(last.maxDuration) : `${last?.maxReps ?? '—'} reps`}</div><div class="sub">${last ? fmtDate(last.date, { month: 'short', day: 'numeric' }) : ''}</div></div>
      <div class="tile"><div class="label">Trend</div><div class="value">${trend == null ? '—' : `${trend > 0 ? '+' : ''}${trend}%`}</div><div class="sub">per month · <span class="status-pill ${h.status}">${STATUS_TEXT[h.status]}</span></div></div>
      <div class="tile"><div class="label">Sessions</div><div class="value">${h.sessions.length}</div><div class="sub">${esc(h.group)}</div></div>
    </div>
    ${h.next ? `<div class="next-box"><div class="muted small">Next session target</div><strong>${esc(h.next.text)}</strong><div class="small">${esc(h.next.reason)}</div></div>` : ''}
    <div class="card">
      <h3>${metricName} over time</h3>
      ${sessions.length ? '<div id="ex-chart"></div><div class="legend"><span><span class="sw" style="background:var(--series-1)"></span>Session</span><span><span class="ring"></span>New best (PR)</span></div>' : '<p class="muted">No data to chart yet.</p>'}
      ${h.kind === 'load' ? '<p class="muted small" style="margin:8px 0 0">Estimated 1RM uses the Epley formula on your best set ≤12 reps, so heavy and light days are comparable.</p>' : ''}
    </div>
    ${rrTotal ? `<div class="card">
      <h3>Rep ranges for this lift</h3>
      ${repRangeBar(rr)}
    </div>` : ''}
    <div class="card">
      <h3>Sessions</h3>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Date</th><th>Sets</th>${h.kind === 'load' ? `<th class="num">Volume (${u})</th><th class="num">e1RM</th>` : ''}</tr></thead>
        <tbody>${[...h.sessions].reverse().map((s) => `<tr>
          <td>${fmtDate(s.date, { month: 'short', day: 'numeric', year: '2-digit' })}${prSet.has(s.date) ? ' <span class="status-pill progressing">PR</span>' : ''}</td>
          <td><div class="sets">${s.sets.map(setChip).join('')}</div></td>
          ${h.kind === 'load' ? `<td class="num">${num(s.volume)}</td><td class="num">${num(s.e1rm)}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  if (sessions.length) {
    lineChart($('#ex-chart'), {
      valueSuffix: suffix,
      points: sessions.map((s) => ({
        date: s.date,
        y: s.metric,
        pr: prSet.has(s.date),
        tip: `<strong>${fmtDate(s.date, { month: 'short', day: 'numeric', year: 'numeric' })}${prSet.has(s.date) ? ' · PR' : ''}</strong>
          ${metricName}: ${num(s.metric)}${suffix}<br>
          ${s.topSet ? `Top set: ${num(s.topSet.weight)} × ${s.topSet.reps}<br>` : ''}${s.sets.length} sets`,
      })),
    });
  }
}

function repRangeBar(rr) {
  const total = rr.strength + rr.hypertrophy + rr.endurance;
  const parts = [
    ['Strength 1–5', rr.strength, 'var(--series-1)'],
    ['Hypertrophy 6–12', rr.hypertrophy, 'var(--series-2)'],
    ['Endurance 13+', rr.endurance, 'var(--series-3)'],
  ];
  return `<div class="stackbar" role="img" aria-label="${parts.map(([l, v]) => `${l}: ${v} sets`).join(', ')}">
    ${parts.filter(([, v]) => v).map(([l, v, c]) => `<span style="width:${(v / total) * 100}%;background:${c}" title="${l}: ${v} sets"></span>`).join('')}
  </div>
  <div class="legend">${parts.map(([l, v, c]) => `<span><span class="sw" style="background:${c}"></span>${l}: <strong>${Math.round((v / total) * 100)}%</strong> <span class="muted">(${v})</span></span>`).join('')}</div>`;
}

// ------------------------------------------------------------- insights

async function loadInsights() {
  const a = await getAnalytics();
  const o = a.overview;
  const u = a.unit;
  if (!o.totalWorkouts) {
    $('#insights-body').innerHTML = '<div class="card empty">Insights appear once you have a few workouts logged.</div>';
    return;
  }
  const icon = { good: '✓', warn: '!', info: 'i' };
  const tag = { good: 'Win', warn: 'Attention', info: 'Tip' };
  const weekly = a.weekly.slice(-12);
  const rr = a.repRanges.last4w;
  const rrTotal = rr.strength + rr.hypertrophy + rr.endurance;

  $('#insights-body').innerHTML = `
    <div class="grid tiles">
      <div class="tile"><div class="label">Workouts</div><div class="value">${o.totalWorkouts}</div><div class="sub">${o.workoutsLast30} in last 30 days</div></div>
      <div class="tile"><div class="label">Per week</div><div class="value">${num(o.avgPerWeek)}</div><div class="sub">avg, last 8 weeks</div></div>
      <div class="tile"><div class="label">Week streak</div><div class="value">${o.weekStreak}</div><div class="sub">weeks in a row</div></div>
      <div class="tile"><div class="label">PRs</div><div class="value">${o.prsLast30}</div><div class="sub">last 30 days</div></div>
    </div>
    <div class="card">
      <h3>Coaching notes</h3>
      ${a.insights.map((i) => `<div class="insight ${i.level}">
        <span class="icon" aria-hidden="true">${icon[i.level]}</span>
        <div><div class="title"><span class="tag">${tag[i.level]}</span>${esc(i.title)}</div><div class="detail">${esc(i.detail)}</div></div>
      </div>`).join('')}
    </div>
    <div class="grid two">
      <div class="card"><h3>Sessions per week</h3><div id="chart-weekly"></div></div>
      <div class="card"><h3>Volume per week <span class="muted small">(${u} lifted)</span></h3><div id="chart-volume"></div></div>
    </div>
    <div class="grid two">
      <div class="card">
        <h3>Sets per muscle per week</h3>
        <p class="muted small">4-week average. Shaded zone = 10–20 sets, a common target for growth.</p>
        <div id="chart-muscles"></div>
      </div>
      <div class="card">
        <h3>Rep-range mix <span class="muted small">(last 4 weeks)</span></h3>
        ${rrTotal ? repRangeBar(rr) : '<p class="muted">No loaded sets in the last 4 weeks.</p>'}
        <h3 style="margin-top:20px">Recent PRs</h3>
        ${a.prs.length ? `<table class="data"><tbody>${a.prs.slice(0, 6).map((p) => `<tr>
          <td>${fmtDate(p.date, { month: 'short', day: 'numeric' })}</td><td>${esc(p.exercise)}</td>
          <td class="num">${p.kind === 'load' ? `${num(p.value)} ${u} e1RM` : p.kind === 'time' ? fmtDuration(p.value) : `${p.value} reps`}</td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted">PRs show up once you beat a previous best.</p>'}
      </div>
    </div>
    <div class="card">
      <h3>All lifts</h3>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Exercise</th><th>Trend</th><th class="num">Best</th><th>Status</th><th>Next session</th></tr></thead>
        <tbody>${a.exercises.map((e) => `<tr class="clickable" data-ex="${esc(e.name)}">
          <td>${esc(e.name)}<div class="muted small">${e.sessions} sessions · last ${fmtDate(e.lastDate, { month: 'short', day: 'numeric' })}</div></td>
          <td>${sparkline(e.spark)}</td>
          <td class="num">${e.kind === 'load' ? `${num(e.best)} ${u}` : e.kind === 'time' ? fmtDuration(e.best) : `${num(e.best)} reps`}</td>
          <td><span class="status-pill ${e.status}">${STATUS_TEXT[e.status]}</span></td>
          <td class="small">${esc(e.next?.text ?? '')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small" style="margin:8px 0 0">Best = estimated 1RM for loaded lifts, best set for bodyweight, longest hold for timed.</p>
    </div>`;

  const wkLabel = (w) => fmtDate(w, { month: 'numeric', day: 'numeric' });
  const thisWeek = weekly.at(-1)?.week;
  barChart($('#chart-weekly'), {
    bars: weekly.map((w) => ({ label: wkLabel(w.week), value: w.sessions, muted: w.week === thisWeek, tip: `<strong>Week of ${fmtDate(w.week, { month: 'short', day: 'numeric' })}</strong>${w.sessions} sessions · ${w.sets} sets${w.week === thisWeek ? '<br>(this week, in progress)' : ''}` })),
  });
  barChart($('#chart-volume'), {
    bars: weekly.map((w) => ({ label: wkLabel(w.week), value: w.volume, muted: w.week === thisWeek, tip: `<strong>Week of ${fmtDate(w.week, { month: 'short', day: 'numeric' })}</strong>${num(w.volume)} ${u} total (weight × reps)` })),
  });
  hbarChart($('#chart-muscles'), {
    band: [10, 20],
    rows: a.muscleSets.map((m) => ({ label: m.group, value: m.setsPerWeek, tip: `<strong>${m.group}</strong>${m.setsPerWeek} sets/week` })),
  });
}

$('#insights-body').addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-ex]');
  if (!row) return;
  state.selectedExercise = row.dataset.ex;
  showTab('progress');
});

// ---------------------------------------------------------------- coach

const PLAN_KEY = 'liftlog.plan';

async function loadCoach() {
  $('#goals').value = state.settings.goals || '';
  $('#ai-off-note').hidden = state.ai;
  $('#gen-plan').disabled = !state.ai;
  const { summary } = await api(`/api/coach/summary?today=${today()}`);
  $('#summary').textContent = summary;
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
    if (saved) showPlan(saved.plan, saved.date);
  } catch { /* ignore */ }
}

$('#goals').addEventListener('change', async () => {
  state.settings = await api('/api/settings', { method: 'PUT', body: { goals: $('#goals').value } });
});

$('#copy-summary').addEventListener('click', async () => {
  const { summary } = await api(`/api/coach/summary?today=${today()}`);
  const goals = $('#goals').value.trim();
  const text = goals && !summary.includes(goals) ? `${summary}\n\nGoals: ${goals}` : summary;
  try {
    await navigator.clipboard.writeText(text);
    toast('Summary copied — paste it to your coach or an AI chat');
  } catch {
    $('#summary').closest('details').open = true;
    toast('Copy failed — select the summary text below instead');
  }
});

$('#gen-plan').addEventListener('click', async () => {
  const btn = $('#gen-plan');
  const status = $('#coach-status');
  btn.disabled = true;
  setStatus(status, 'Building your plan from your log… this can take up to a minute.');
  try {
    if ($('#goals').value !== (state.settings.goals || '')) {
      state.settings = await api('/api/settings', { method: 'PUT', body: { goals: $('#goals').value } });
    }
    const { plan } = await api('/api/coach/plan', { method: 'POST', body: { goals: $('#goals').value } });
    const date = today();
    showPlan(plan, date);
    try { localStorage.setItem(PLAN_KEY, JSON.stringify({ plan, date })); } catch { /* ignore */ }
    setStatus(status, '');
  } catch (err) {
    setStatus(status, err.message, true);
  } finally {
    btn.disabled = !state.ai;
  }
});

function showPlan(plan, date) {
  $('#plan-card').hidden = false;
  $('#plan').innerHTML = markdown(plan);
  $('#plan-date').textContent = `generated ${fmtDate(date, { month: 'short', day: 'numeric' })}`;
}

// Minimal Markdown → HTML (input is escaped first).
function markdown(src) {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null;
  let table = null;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push('</table>'); table = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
      if (!table) { out.push('<table>'); table = true; out.push(`<tr>${cells.map((c) => `<th>${c}</th>`).join('')}</tr>`); } else out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      continue;
    }
    closeTable();
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else if (/^-{3,}$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  closeTable();
  return out.join('\n');
}

// ------------------------------------------------------------- settings

function loadSettingsForm() {
  $('#set-unit').value = state.settings.unit;
  $('#set-bw').value = state.settings.bodyweight || '';
}

$('#set-unit').addEventListener('change', async (ev) => {
  state.settings = await api('/api/settings', { method: 'PUT', body: { unit: ev.target.value } });
  state.analytics = null;
  toast(`Default unit: ${state.settings.unit}`);
});

$('#set-bw').addEventListener('change', async (ev) => {
  state.settings = await api('/api/settings', { method: 'PUT', body: { bodyweight: ev.target.value } });
  toast('Bodyweight saved');
});

$('#import-input').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const status = $('#import-status');
  try {
    const data = JSON.parse(await file.text());
    const res = await api('/api/import', { method: 'POST', body: data });
    state.analytics = null;
    state.settings = await api('/api/settings');
    setStatus(status, `Imported ${res.added} workouts${res.skipped ? `, skipped ${res.skipped} duplicates/invalid` : ''}.`);
  } catch (err) {
    setStatus(status, `Import failed: ${err.message}`, true);
  }
});

// ----------------------------------------------------------------- boot

(async function init() {
  logDate.value = today();
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) logText.value = draft;
  } catch { /* ignore */ }
  try {
    const [health, settings] = await Promise.all([api('/api/health'), api('/api/settings')]);
    state.ai = health.ai;
    state.settings = settings;
  } catch (err) {
    toast(`Can't reach the server: ${err.message}`);
  }
  $('#scan-btn').hidden = !state.ai;
  refreshPreview();
  const initial = location.hash.slice(1);
  showTab(document.getElementById(`tab-${initial}`) ? initial : 'log', false);
})();
