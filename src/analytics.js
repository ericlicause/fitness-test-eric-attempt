// Progress analytics and coaching insights computed from the workout log.
//
// Everything is derived on read from the full history, so changing a parser
// rule or editing an old workout immediately reflows every chart and insight.

import { muscleGroupFor, isLowerBody, PUSH_GROUPS, PULL_GROUPS, LEG_GROUPS } from './exercises.js';

const KG_PER_LB = 0.45359237;
const DAY_MS = 86400000;
const MAJOR_GROUPS = ['Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings', 'Biceps', 'Triceps'];

export const REP_RANGES = [
  { key: 'strength', label: 'Strength (1–5)', min: 1, max: 5 },
  { key: 'hypertrophy', label: 'Hypertrophy (6–12)', min: 6, max: 12 },
  { key: 'endurance', label: 'Endurance (13+)', min: 13, max: Infinity },
];

// ---------------------------------------------------------------- helpers

export function convert(weight, from, to) {
  if (weight == null || from === to) return weight;
  return from === 'kg' ? weight / KG_PER_LB : weight * KG_PER_LB;
}

// Epley estimated one-rep max. Sets above 12 reps say little about max
// strength, so they don't produce an estimate.
export function estimate1RM(weight, reps) {
  if (!weight || !reps || reps < 1 || reps > 12) return null;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

function round(n, step = 0.1) {
  return n == null ? null : Math.round(n / step) * step;
}

function r1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function dayNum(iso) {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS;
}

function isoFromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function weekStart(iso) {
  const n = dayNum(iso);
  const dow = (new Date(n * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0
  return isoFromDay(n - dow);
}

export function repRangeOf(reps) {
  if (!reps) return null;
  return REP_RANGES.find((r) => reps >= r.min && reps <= r.max)?.key ?? null;
}

// --------------------------------------------------------- per-exercise

// Summarize one exercise's sets in one workout.
function sessionStats(ex, unit) {
  let topSet = null;
  let bestE1rm = null;
  let highRepBest = null; // Epley on 13+ rep sets: rough, but tracks progress on accessories
  let volume = 0;
  let totalReps = 0;
  let maxReps = 0;
  let maxDuration = 0;
  let weighted = false;

  for (const s of ex.sets) {
    const load = s.weight ? convert(s.weight, s.unit, unit) : 0;
    if (s.reps) {
      totalReps += s.reps;
      maxReps = Math.max(maxReps, s.reps);
    }
    if (s.durationS) maxDuration = Math.max(maxDuration, s.durationS);
    if (load > 0 && !s.bodyweight) weighted = true;
    if (load > 0 && s.reps) {
      volume += load * s.reps;
      const e = estimate1RM(load, s.reps);
      if (e && (bestE1rm == null || e > bestE1rm)) bestE1rm = e;
      if (!e && s.reps > 12) {
        const rough = load * (1 + Math.min(s.reps, 30) / 30);
        if (highRepBest == null || rough > highRepBest) highRepBest = rough;
      }
      if (!topSet || load > topSet.weight || (load === topSet.weight && s.reps > topSet.reps)) {
        topSet = { weight: round(load, 0.5), reps: s.reps, rpe: s.rpe, bodyweight: s.bodyweight };
      }
    }
  }

  // Which number tracks progress for this movement.
  let kind = 'reps';
  if (weighted) kind = 'load';
  else if (!totalReps && maxDuration) kind = 'time';

  const metric = kind === 'load' ? (bestE1rm ?? highRepBest) : kind === 'time' ? maxDuration : maxReps;
  return {
    sets: ex.sets.length,
    topSet,
    e1rm: r1(bestE1rm),
    volume: Math.round(volume),
    totalReps,
    maxReps,
    maxDuration,
    kind,
    metric: metric || null,
  };
}

function exerciseSessions(workouts, unit) {
  const map = new Map();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      if (!map.has(ex.name)) map.set(ex.name, []);
      const list = map.get(ex.name);
      const stats = sessionStats(ex, unit);
      const prev = list[list.length - 1];
      // Same exercise twice in one workout: merge into one session.
      if (prev && prev.workoutId === w.id) {
        const merged = sessionStats({ sets: [...prev.rawSets, ...ex.sets] }, unit);
        Object.assign(prev, merged, { rawSets: [...prev.rawSets, ...ex.sets] });
      } else {
        list.push({ date: w.date, workoutId: w.id, rawSets: ex.sets, ...stats });
      }
    }
  }
  return map;
}

// Least-squares slope of metric vs. day, as % of the mean per 30 days.
function trendPctPerMonth(sessions) {
  const pts = sessions.filter((s) => s.metric != null).map((s) => [dayNum(s.date), s.metric]);
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  if (!den || !my) return null;
  return r1(((num / den) * 30 / my) * 100);
}

function nextTarget(name, last, status, unit) {
  if (!last) return null;
  if (last.kind === 'time') {
    return { text: `Hold ${last.maxDuration + 10}s`, reason: 'Add ~10 seconds to your best hold.' };
  }
  if (last.kind === 'reps' || !last.topSet) {
    const goal = last.maxReps + 1;
    if (last.maxReps >= 15) {
      return { text: `Add load: +${unit === 'kg' ? 5 : 10} ${unit} x ${Math.max(6, last.maxReps - 6)}`, reason: '15+ reps per set — add weight (vest/belt) to keep building strength.' };
    }
    return { text: `${goal} reps on your top set`, reason: 'Add a rep before anything else.' };
  }

  const { weight, reps } = last.topSet;
  const lower = isLowerBody(name);
  const inc = unit === 'kg' ? (lower ? 5 : 2.5) : (lower ? 10 : 5);
  const range = reps <= 5 ? [3, 5] : reps <= 8 ? [6, 8] : reps <= 12 ? [8, 12] : [12, 20];

  if (status === 'stalled') {
    const deload = round(weight * 0.9, unit === 'kg' ? 2.5 : 5);
    return {
      text: `Deload: ${deload} ${unit} x ${range[1]}`,
      reason: 'Drop ~10% for a week, then build back up — or switch to a different rep range for a block.',
    };
  }
  if (reps >= range[1]) {
    return {
      text: `${round(weight + inc, 0.5)} ${unit} x ${range[0]}`,
      reason: `You hit the top of the ${range[0]}–${range[1]} range at ${weight} ${unit} — add weight, restart at ${range[0]} reps.`,
    };
  }
  return {
    text: `${weight} ${unit} x ${reps + 1}`,
    reason: `Same weight, one more rep (double progression in the ${range[0]}–${range[1]} range).`,
  };
}

// Sessions since the last new best (0 = the latest session set one).
function sessionsSinceBest(sessions) {
  let best = -Infinity;
  let bestIdx = -1;
  sessions.forEach((s, i) => {
    if (s.metric != null && s.metric > best) {
      best = s.metric;
      bestIdx = i;
    }
  });
  return bestIdx < 0 ? 0 : sessions.length - 1 - bestIdx;
}

function classify(sessions, today) {
  if (sessions.length < 3) return 'new';
  const last = sessions[sessions.length - 1];
  if (dayNum(today) - dayNum(last.date) > 28) return 'inactive';
  const window = sessions.filter((s) => dayNum(last.date) - dayNum(s.date) <= 56);
  const trend = trendPctPerMonth(window);
  const since = sessionsSinceBest(sessions);
  // Stalled: 4+ sessions without a new best, or 3 with a flat trend line.
  if (sessions.length >= 5 && (since >= 4 || (since >= 3 && (trend == null || trend < 1)))) {
    return trend != null && trend <= -3 ? 'regressing' : 'stalled';
  }
  if (trend != null && trend <= -3) return 'regressing';
  return 'progressing';
}

export function exerciseHistory(workouts, name, { unit = 'lb', today } = {}) {
  today = today || isoFromDay(Math.floor(Date.now() / DAY_MS));
  const sessions = exerciseSessions(workouts, unit).get(name) || [];
  const status = classify(sessions, today);
  const reps = Object.fromEntries(REP_RANGES.map((r) => [r.key, 0]));
  let best = null;
  const prs = [];
  for (const s of sessions) {
    for (const st of s.rawSets) {
      const k = repRangeOf(st.reps);
      if (k) reps[k]++;
    }
    if (s.metric != null) {
      if (best != null && s.metric > best) prs.push(s.date);
      if (best == null || s.metric > best) best = s.metric;
    }
  }
  return {
    name,
    group: muscleGroupFor(name),
    unit,
    kind: sessions.at(-1)?.kind ?? 'load',
    status,
    trendPctPerMonth: trendPctPerMonth(sessions.slice(-8)),
    best,
    prDates: prs,
    repRanges: reps,
    next: nextTarget(name, sessions.at(-1), status, unit),
    sessions: sessions.map(({ rawSets, ...s }) => ({
      ...s,
      sets: rawSets.map((st) => ({ ...st, weight: st.weight != null ? round(convert(st.weight, st.unit, unit), 0.5) : null, unit })),
    })),
  };
}

// ------------------------------------------------------------ dashboard

export function computeAnalytics(workouts, { unit = 'lb', today } = {}) {
  today = today || isoFromDay(Math.floor(Date.now() / DAY_MS));
  const todayN = dayNum(today);
  const sorted = [...workouts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const sessionsByExercise = exerciseSessions(sorted, unit);

  // ---- overview & weekly series
  let totalSets = 0;
  let totalVolume = 0;
  const weekMap = new Map();
  const groupSets4w = new Map();
  const pushPull4w = { push: 0, pull: 0 };
  const repRangeAll = Object.fromEntries(REP_RANGES.map((r) => [r.key, 0]));
  const repRange4w = Object.fromEntries(REP_RANGES.map((r) => [r.key, 0]));
  const rpes = [];

  for (const w of sorted) {
    const wk = weekStart(w.date);
    if (!weekMap.has(wk)) weekMap.set(wk, { week: wk, sessions: 0, sets: 0, volume: 0 });
    const bucket = weekMap.get(wk);
    bucket.sessions++;
    const age = todayN - dayNum(w.date);
    for (const ex of w.exercises) {
      for (const s of ex.sets) {
        totalSets++;
        bucket.sets++;
        const load = s.weight ? convert(s.weight, s.unit, unit) : 0;
        if (load && s.reps) {
          totalVolume += load * s.reps;
          bucket.volume += load * s.reps;
        }
        const rr = repRangeOf(s.reps);
        if (rr && load > 0) {
          repRangeAll[rr]++;
          if (age < 28) repRange4w[rr]++;
        }
        if (age < 28) {
          groupSets4w.set(ex.group, (groupSets4w.get(ex.group) || 0) + 1);
          const side = movementSide(ex.name, ex.group);
          if (side) pushPull4w[side]++;
          if (s.rpe) rpes.push(s.rpe);
        }
      }
    }
  }

  // Fill gaps so the weekly chart shows zero weeks honestly.
  const weekly = [];
  if (sorted.length) {
    const lastWeek = weekStart(today);
    const firstWeek = weekStart(isoFromDay(Math.max(dayNum(sorted[0].date), dayNum(lastWeek) - 7 * 15)));
    for (let n = dayNum(firstWeek); n <= dayNum(lastWeek); n += 7) {
      const wk = isoFromDay(n);
      const b = weekMap.get(wk) || { week: wk, sessions: 0, sets: 0, volume: 0 };
      weekly.push({ ...b, volume: Math.round(b.volume) });
    }
  }

  const firstDate = sorted[0]?.date ?? null;
  const lastDate = sorted.at(-1)?.date ?? null;
  const historyDays = firstDate ? todayN - dayNum(firstDate) + 1 : 0;
  const weeksForAvg = Math.max(1, Math.min(4, historyDays / 7));
  const last8 = weekly.slice(-8);
  const activeWeeks8 = Math.max(1, Math.min(8, Math.ceil(historyDays / 7)));
  const avgPerWeek = r1(last8.slice(-activeWeeks8).reduce((a, w) => a + w.sessions, 0) / activeWeeks8);

  let weekStreak = 0;
  for (let i = weekly.length - 1; i >= 0; i--) {
    if (weekly[i].sessions > 0) weekStreak++;
    else if (i === weekly.length - 1) continue; // current week may not have started yet
    else break;
  }

  const muscleSets = MAJOR_GROUPS.concat(['Glutes', 'Calves', 'Core'])
    .map((group) => ({ group, setsPerWeek: r1((groupSets4w.get(group) || 0) / weeksForAvg) }));
  for (const [group, n] of groupSets4w) {
    if (!muscleSets.some((m) => m.group === group)) muscleSets.push({ group, setsPerWeek: r1(n / weeksForAvg) });
  }

  // ---- per-exercise summaries & PRs
  const exercises = [];
  const prs = [];
  for (const [name, sessions] of sessionsByExercise) {
    let best = null;
    let bestDate = null;
    let heaviest = null;
    for (const s of sessions) {
      if (s.metric != null && best != null && s.metric > best) {
        prs.push({
          date: s.date,
          exercise: name,
          kind: s.kind,
          value: r1(s.metric),
          previous: r1(best),
          topSet: s.topSet,
        });
      }
      if (s.metric != null && (best == null || s.metric > best)) {
        best = s.metric;
        bestDate = s.date;
      }
      if (s.topSet && (!heaviest || s.topSet.weight > heaviest.weight)) heaviest = s.topSet;
    }
    const last = sessions.at(-1);
    const status = classify(sessions, today);
    exercises.push({
      name,
      group: muscleGroupFor(name),
      kind: last.kind,
      sessions: sessions.length,
      sessionsSinceBest: sessionsSinceBest(sessions),
      firstDate: sessions[0].date,
      lastDate: last.date,
      best: r1(best),
      bestDate,
      heaviest,
      lastTopSet: last.topSet,
      lastMetric: r1(last.metric),
      trendPctPerMonth: trendPctPerMonth(sessions.filter((s) => dayNum(last.date) - dayNum(s.date) <= 56)),
      status,
      next: nextTarget(name, last, status, unit),
      spark: sessions.slice(-12).map((s) => r1(s.metric)),
    });
  }
  exercises.sort((a, b) => b.sessions - a.sessions || (a.lastDate < b.lastDate ? 1 : -1));
  prs.sort((a, b) => (a.date < b.date ? 1 : -1));

  const overview = {
    totalWorkouts: sorted.length,
    totalSets,
    totalVolume: Math.round(totalVolume),
    workoutsLast30: sorted.filter((w) => todayN - dayNum(w.date) < 30).length,
    avgPerWeek,
    weekStreak,
    firstDate,
    lastDate,
    daysSinceLast: lastDate ? todayN - dayNum(lastDate) : null,
    prsLast30: prs.filter((p) => todayN - dayNum(p.date) < 30).length,
    avgRpe4w: rpes.length ? r1(rpes.reduce((a, b) => a + b, 0) / rpes.length) : null,
  };

  const analytics = {
    unit,
    today,
    overview,
    weekly,
    muscleSets,
    repRanges: { all: repRangeAll, last4w: repRange4w },
    pushPull4w,
    exercises,
    prs: prs.slice(0, 25),
  };
  analytics.insights = buildInsights(analytics, sorted, today);
  return analytics;
}

// ------------------------------------------------------------- insights

// Rear-delt work is a shoulder exercise but a pulling movement.
function movementSide(name, group) {
  if (/face pull|rear delt|reverse fly|reverse pec/i.test(name)) return 'pull';
  if (PUSH_GROUPS.includes(group)) return 'push';
  if (PULL_GROUPS.includes(group)) return 'pull';
  return null;
}

function buildInsights(a, workouts, today) {
  const out = [];
  const { overview: o } = a;
  if (!o.totalWorkouts) {
    return [{ level: 'info', title: 'Log your first workout', detail: 'Insights appear once you have a few sessions logged.' }];
  }

  // Consistency
  if (o.daysSinceLast != null && o.daysSinceLast > 7) {
    out.push({ level: 'warn', title: `${o.daysSinceLast} days since your last workout`, detail: 'Get one session in this week — even a short one keeps the habit alive.' });
  } else if (o.avgPerWeek >= 3) {
    out.push({ level: 'good', title: `Consistent: ${o.avgPerWeek} sessions/week`, detail: `${o.weekStreak}-week training streak. Consistency is the biggest driver of progress.` });
  } else if (o.totalWorkouts >= 3 && o.avgPerWeek < 2) {
    out.push({ level: 'warn', title: `Low frequency: ${o.avgPerWeek} sessions/week`, detail: 'Most people progress faster at 3–4 sessions a week, hitting each muscle about twice.' });
  }

  // Progressing / stalled lifts
  const progressing = a.exercises
    .filter((e) => e.status === 'progressing' && e.trendPctPerMonth > 0)
    .sort((x, y) => y.trendPctPerMonth - x.trendPctPerMonth)
    .slice(0, 3);
  for (const e of progressing) {
    const what = e.kind === 'load' ? 'estimated 1RM' : e.kind === 'time' ? 'best hold' : 'best set';
    out.push({ level: 'good', title: `${e.name} is moving up`, detail: `${what} trending +${e.trendPctPerMonth}% per month. Next: ${e.next?.text ?? 'keep going'}.`, exercise: e.name });
  }
  const stuck = a.exercises
    .filter((x) => x.status === 'stalled' || x.status === 'regressing')
    .sort((x, y) => (y.kind === 'load') - (x.kind === 'load') || y.sessions - x.sessions);
  for (const e of stuck.slice(0, 3)) {
    out.push({
      level: 'warn',
      title: `${e.name} has ${e.status === 'stalled' ? 'stalled' : 'slipped'}`,
      detail: `No new best in your last ${e.sessionsSinceBest} sessions. Next time: ${e.next?.text}. ${e.next?.reason ?? ''} Also check sleep, food and recovery.`,
      exercise: e.name,
    });
  }
  if (stuck.length > 3) {
    out.push({ level: 'info', title: `Also flat: ${stuck.slice(3).map((e) => e.name).join(', ')}`, detail: 'Accessories plateau often — add a rep or a small jump in weight when every set hits the top of the range.' });
  }

  // Recent PRs
  const recentPrs = a.prs.filter((p) => dayNum(today) - dayNum(p.date) < 14);
  if (recentPrs.length) {
    out.push({ level: 'good', title: `${recentPrs.length} PR${recentPrs.length > 1 ? 's' : ''} in the last 2 weeks`, detail: [...new Set(recentPrs.map((p) => p.exercise))].join(', ') });
  }

  // Volume balance (needs a couple of weeks of data to mean anything)
  const historyDays = dayNum(today) - dayNum(o.firstDate);
  if (o.totalWorkouts >= 4 && historyDays >= 10) {
    const sets = Object.fromEntries(a.muscleSets.map((m) => [m.group, m.setsPerWeek]));
    const low = MAJOR_GROUPS.filter((g) => (sets[g] || 0) < 4);
    const high = MAJOR_GROUPS.filter((g) => (sets[g] || 0) > 22);
    if (low.length) {
      out.push({ level: 'info', title: `Low weekly volume: ${low.join(', ')}`, detail: 'Under ~4 sets/week. 10–20 hard sets per muscle per week is a common target for growth.' });
    }
    if (high.length) {
      out.push({ level: 'info', title: `Very high volume: ${high.join(', ')}`, detail: 'Over ~22 sets/week. If recovery or joints suffer, trim some sets.' });
    }

    const { push, pull } = a.pushPull4w;
    if (push && pull) {
      const ratio = push / pull;
      if (ratio > 1.5) out.push({ level: 'warn', title: `Push-heavy (${r1(ratio)}:1 push:pull)`, detail: 'Add rows, pulldowns or face pulls — balanced pulling helps shoulder health and posture.' });
      else if (ratio < 0.67) out.push({ level: 'info', title: `Pull-heavy (1:${r1(1 / ratio)} push:pull)`, detail: 'Consider a bit more pressing to balance things out.' });
    } else if (push && !pull) {
      out.push({ level: 'warn', title: 'No back/biceps work in the last 4 weeks', detail: 'Add rows, pull-ups or pulldowns.' });
    }

    const legSets = LEG_GROUPS.reduce((s, g) => s + (sets[g] || 0), 0);
    if (!legSets) out.push({ level: 'warn', title: 'No leg training in the last 4 weeks', detail: 'Squats, lunges, RDLs or leg press — legs are half your muscle mass.' });
  }

  // Rep-range mix
  const rr = a.repRanges.last4w;
  const total = rr.strength + rr.hypertrophy + rr.endurance;
  if (total >= 20) {
    const pct = (k) => Math.round((rr[k] / total) * 100);
    if (pct('hypertrophy') >= 80) {
      out.push({ level: 'info', title: `${pct('hypertrophy')}% of sets in the 6–12 range`, detail: 'Great for muscle growth. If you want strength too, add some heavy 3–5 rep sets on your main lifts.' });
    } else if (pct('strength') >= 70) {
      out.push({ level: 'info', title: `${pct('strength')}% of sets in the 1–5 range`, detail: 'Strength-focused. Some 8–12 rep accessory work supports size and joint health.' });
    } else if (pct('endurance') >= 50) {
      out.push({ level: 'info', title: `${pct('endurance')}% of sets are 13+ reps`, detail: 'Heavier sets (5–12 reps) build strength and size more efficiently.' });
    }
  }

  if (o.avgRpe4w != null) {
    if (o.avgRpe4w < 7) out.push({ level: 'info', title: `Average RPE ${o.avgRpe4w}`, detail: 'Working sets around RPE 7–9 (1–3 reps in reserve) drive progress best.' });
    else if (o.avgRpe4w > 9.2) out.push({ level: 'warn', title: `Average RPE ${o.avgRpe4w}`, detail: 'Grinding to failure on most sets builds fatigue fast — leave a rep or two in the tank.' });
  }

  // Lifts that dropped out of the rotation
  const dropped = a.exercises.filter((e) => e.sessions >= 3 && dayNum(today) - dayNum(e.lastDate) > 21);
  if (dropped.length) {
    out.push({ level: 'info', title: `Not trained in 3+ weeks: ${dropped.slice(0, 4).map((e) => e.name).join(', ')}`, detail: 'Intentional swap? If not, work them back in — strength fades without practice.' });
  }

  const order = { warn: 0, good: 1, info: 2 };
  return out.sort((x, y) => order[x.level] - order[y.level]);
}

// --------------------------------------------------------- coach summary

// Plain-text training summary to paste to a coach or AI, or feed the plan
// generator.
export function coachingSummary(a, settings = {}) {
  const u = a.unit;
  const L = [];
  L.push('# Training summary');
  L.push(`Generated ${a.today}. Units: ${u}.`);
  if (settings.bodyweight) L.push(`Bodyweight: ${settings.bodyweight} ${u}.`);
  if (settings.goals) L.push(`Goals: ${settings.goals}`);
  L.push('');
  const o = a.overview;
  L.push('## Overview');
  L.push(`- ${o.totalWorkouts} workouts logged since ${o.firstDate ?? 'n/a'} (${o.workoutsLast30} in the last 30 days)`);
  L.push(`- Averaging ${o.avgPerWeek} sessions/week; current streak ${o.weekStreak} week(s)`);
  if (o.avgRpe4w != null) L.push(`- Average RPE (4 weeks): ${o.avgRpe4w}`);
  const rr = a.repRanges.last4w;
  const tot = rr.strength + rr.hypertrophy + rr.endurance;
  if (tot) {
    L.push(`- Rep ranges (4 weeks, loaded sets): ${REP_RANGES.map((r) => `${r.label} ${Math.round((rr[r.key] / tot) * 100)}%`).join(', ')}`);
  }
  L.push('');
  L.push('## Weekly sets per muscle group (4-week average)');
  for (const m of a.muscleSets.filter((x) => x.setsPerWeek > 0)) L.push(`- ${m.group}: ${m.setsPerWeek}`);
  L.push('');
  L.push('## Lifts');
  for (const e of a.exercises.slice(0, 20)) {
    const last = e.lastTopSet ? `${e.lastTopSet.weight} ${u} x ${e.lastTopSet.reps}` : (e.kind === 'time' ? `${e.lastMetric}s` : `${e.lastMetric} reps`);
    const best = e.kind === 'load' ? `best est. 1RM ${e.best} ${u}` : e.kind === 'time' ? `best ${e.best}s` : `best ${e.best} reps`;
    const trend = e.trendPctPerMonth != null ? `, trend ${e.trendPctPerMonth > 0 ? '+' : ''}${e.trendPctPerMonth}%/month` : '';
    L.push(`- ${e.name} (${e.group}): ${e.sessions} sessions, last ${e.lastDate} top set ${last}; ${best}${trend}; status: ${e.status}`);
  }
  L.push('');
  L.push('## Recent PRs');
  if (!a.prs.length) L.push('- none yet');
  for (const p of a.prs.slice(0, 8)) {
    L.push(`- ${p.date} ${p.exercise}: ${p.kind === 'load' ? `est. 1RM ${p.value} ${u}` : p.value} (prev ${p.previous})`);
  }
  L.push('');
  L.push('## Flags');
  for (const i of a.insights) L.push(`- [${i.level}] ${i.title} — ${i.detail}`);
  return L.join('\n');
}
