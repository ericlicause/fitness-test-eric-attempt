// Small dependency-free SVG charts with hover tooltips.

const NS = 'http://www.w3.org/2000/svg';
const tooltip = () => document.getElementById('tooltip');

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

export function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 10;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}

export function hideTip() {
  tooltip().hidden = true;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { lo, hi, ticks };
}

function fmt(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n * 10) / 10);
}

const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Re-render a chart whenever its container changes width.
function responsive(container, draw) {
  container.classList.add('chart');
  let lastW = 0;
  const render = () => {
    const w = Math.round(container.clientWidth || 600);
    if (w === lastW) return;
    lastW = w;
    container.innerHTML = '';
    draw(w);
  };
  render();
  if (container._ro) container._ro.disconnect();
  container._ro = new ResizeObserver(render);
  container._ro.observe(container);
}

function roundedTop(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function roundedRight(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// points: [{ date, y, pr?, tip }]
export function lineChart(container, { points, height = 230, valueSuffix = '' }) {
  responsive(container, (W) => {
    const m = { t: 16, r: 56, b: 28, l: 44 };
    const H = height;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Progress over time' }, container);
    const ys = points.map((p) => p.y);
    const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys));
    const xs = points.map((p) => dayNum(p.date));
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const sx = (d) => (x1 === x0 ? (m.l + W - m.r) / 2 : m.l + ((d - x0) / (x1 - x0)) * (W - m.l - m.r));
    const sy = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

    for (const t of ticks) {
      el('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, svg);
      el('text', { class: 'axis-label', x: m.l - 8, y: sy(t) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(t);
    }
    // ~4 date labels
    const labelCount = Math.min(points.length, Math.max(2, Math.floor((W - m.l - m.r) / 90)));
    const seen = new Set();
    for (let i = 0; i < labelCount; i++) {
      const idx = labelCount === 1 ? 0 : Math.round((i * (points.length - 1)) / (labelCount - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      const p = points[idx];
      const anchor = idx === 0 ? 'start' : idx === points.length - 1 ? 'end' : 'middle';
      el('text', { class: 'axis-label', x: sx(dayNum(p.date)), y: H - 8, 'text-anchor': points.length === 1 ? 'middle' : anchor }, svg).textContent = shortDate(p.date);
    }

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${sx(dayNum(p.date)).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    el('path', { class: 'line', d }, svg);
    for (const p of points) {
      el('circle', { class: p.pr ? 'dot pr' : 'dot', cx: sx(dayNum(p.date)), cy: sy(p.y), r: p.pr ? 5 : 4 }, svg);
    }
    const last = points[points.length - 1];
    el('text', { class: 'label-end', x: sx(dayNum(last.date)) + 9, y: sy(last.y) + 4 }, svg).textContent = `${fmt(last.y)}${valueSuffix}`;

    // hover layer
    const cross = el('line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' }, svg);
    const hit = el('rect', { class: 'hit', x: m.l - 10, y: 0, width: W - m.l - m.r + 20, height: H }, svg);
    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      let best = points[0];
      let bestD = Infinity;
      for (const p of points) {
        const dd = Math.abs(sx(dayNum(p.date)) - px);
        if (dd < bestD) { bestD = dd; best = p; }
      }
      const cx = sx(dayNum(best.date));
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      showTip(best.tip, box.left + (cx / W) * box.width, box.top + (sy(best.y) / H) * box.height);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  });
}

// bars: [{ label, value, tip, muted? }]
export function barChart(container, { bars, height = 190 }) {
  responsive(container, (W) => {
    const m = { t: 12, r: 8, b: 26, l: 40 };
    const H = height;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' }, container);
    const max = Math.max(1, ...bars.map((b) => b.value));
    const { hi, ticks } = niceTicks(0, max, 3);
    const sy = (v) => m.t + (1 - v / hi) * (H - m.t - m.b);
    for (const t of ticks) {
      el('line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t) }, svg);
      el('text', { class: 'axis-label', x: m.l - 8, y: sy(t) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(t);
    }
    const slot = (W - m.l - m.r) / bars.length;
    const bw = Math.max(3, Math.min(28, slot - 2));
    const every = Math.ceil(bars.length / Math.max(1, Math.floor((W - m.l - m.r) / 56)));
    bars.forEach((b, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      const y = sy(b.value);
      el('path', { class: b.muted ? 'bar muted' : 'bar', d: roundedTop(x, y, bw, sy(0) - y) }, svg);
      if ((bars.length - 1 - i) % every === 0) {
        el('text', { class: 'axis-label', x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, svg).textContent = b.label;
      }
      const hit = el('rect', { class: 'hit', x: m.l + i * slot, y: m.t, width: slot, height: H - m.t - m.b }, svg);
      hit.addEventListener('pointermove', (ev) => showTip(b.tip, ev.clientX, ev.clientY));
      hit.addEventListener('pointerdown', (ev) => showTip(b.tip, ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', hideTip);
    });
  });
}

// rows: [{ label, value, tip }], band: [lo, hi] target zone
export function hbarChart(container, { rows, band, rowHeight = 26 }) {
  responsive(container, (W) => {
    const labelW = Math.min(110, W * 0.3);
    const m = { t: 4, r: 40, b: 22, l: labelW };
    const H = m.t + m.b + rows.length * rowHeight;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' }, container);
    const max = Math.max(band ? band[1] * 1.2 : 1, ...rows.map((r) => r.value));
    const { hi, ticks } = niceTicks(0, max, 4);
    const sx = (v) => m.l + (v / hi) * (W - m.l - m.r);
    if (band) {
      el('rect', { class: 'band', x: sx(band[0]), y: m.t, width: sx(band[1]) - sx(band[0]), height: H - m.t - m.b }, svg);
    }
    for (const t of ticks) {
      el('line', { class: 'gridline', x1: sx(t), x2: sx(t), y1: m.t, y2: H - m.b }, svg);
      el('text', { class: 'axis-label', x: sx(t), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = fmt(t);
    }
    rows.forEach((r, i) => {
      const y = m.t + i * rowHeight;
      const bh = rowHeight - 10;
      el('text', { class: 'axis-label', x: m.l - 8, y: y + rowHeight / 2 + 4, 'text-anchor': 'end', style: 'fill: var(--text-2); font-size: 12px' }, svg).textContent = r.label;
      el('path', { class: 'bar', d: roundedRight(m.l, y + 5, sx(r.value) - m.l, bh) }, svg);
      el('text', { class: 'axis-label', x: sx(r.value) + 6, y: y + rowHeight / 2 + 4 }, svg).textContent = fmt(r.value);
      const hit = el('rect', { class: 'hit', x: 0, y, width: W, height: rowHeight }, svg);
      hit.addEventListener('pointermove', (ev) => showTip(r.tip, ev.clientX, ev.clientY));
      hit.addEventListener('pointerdown', (ev) => showTip(r.tip, ev.clientX, ev.clientY));
      hit.addEventListener('pointerleave', hideTip);
    });
  });
}

export function sparkline(values) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return '';
  const w = 80;
  const h = 24;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pts = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * (w - 4) + 2).toFixed(1)},${(hi === lo ? h / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${pts.join('')}"/></svg>`;
}
