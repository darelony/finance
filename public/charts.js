/**
 * Mali SVG chart set - bez biblioteka, radi offline.
 * Specifikacije: 2px hairline linije, <=24px debele kolone, 4px zaobljen vrh,
 * 2px razmak u boji podloge izmedju dodirujucih markera, recesivna mreza.
 */
'use strict';

const NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------- helperi --- */

const nf0 = new Intl.NumberFormat('sr-RS', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(n, currency = 'RSD', exact = false) {
  const v = Number(n) || 0;
  return `${(exact ? nf2 : nf0).format(v)} ${currency}`;
}
export function compact(n) {
  const raw = Number(n) || 0;
  const v = Math.abs(raw);
  const sign = raw < 0 ? '−' : '';   // pravi minus, ne crtica
  if (v >= 1e9) return `${sign}${nf0.format(Math.round(v / 1e8) / 10)} mlrd`;
  if (v >= 1e6) return `${sign}${nf0.format(Math.round(v / 1e5) / 10)} mil`;
  if (v >= 1e4) return `${sign}${nf0.format(Math.round(v / 1e3))}k`;
  return `${sign}${nf0.format(v)}`;
}

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function theme() {
  return {
    surface: cssVar('--surface-1', '#1a1a19'),
    grid: cssVar('--grid', '#2e2e2b'),
    text: cssVar('--text-primary', '#fff'),
    sub: cssVar('--text-secondary', '#c3c2b7'),
    muted: cssVar('--text-muted', '#8a897f'),
  };
}

/** Okrugao korak za dati raspon. */
function niceStep(range, count = 4) {
  const raw = (range || 1) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
}

/** Okrugle vrednosti za y-osu koja pocinje od nule. */
function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max, count);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

/**
 * Skala koja moze da ide i u minus, ali bez simetricnog trosenja prostora:
 * gornja i donja granica se zaokrugljuju nezavisno, na isti korak.
 */
function niceScale(min, max, count = 4) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const step = niceStep(hi - lo || Math.abs(hi) || 1, count);
  const bottom = Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, bottom, top: top === bottom ? bottom + step : top };
}

/* ------------------------------------------------------------- tooltip --- */

let tipNode = null;
function tip() {
  if (!tipNode) {
    tipNode = document.createElement('div');
    tipNode.className = 'chart-tip';
    tipNode.setAttribute('role', 'status');
    document.body.appendChild(tipNode);
  }
  return tipNode;
}
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('is-on');
  const r = t.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), window.innerWidth - r.width - 8);
  const top = y - r.height - 14 < 8 ? y + 18 : y - r.height - 14;
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
export function hideTip() {
  if (tipNode) tipNode.classList.remove('is-on');
}

/**
 * Prati velicinu kontejnera i ponovo iscrtava graf pravim pikselima
 * (bez razvlacenja viewBox-a, da tekst ostane oster).
 */
function autoDraw(host, draw) {
  if (host._finObserver) host._finObserver.disconnect();
  let lastW = 0;
  let lastH = 0;
  let first = true;
  const run = () => {
    const w = host.clientWidth;
    const h = host.clientHeight || Number(host.dataset.height) || 240;
    if (w < 40 || (w === lastW && h === lastH)) return;
    lastW = w;
    lastH = h;
    // Ulazna animacija se pusta samo pri prvom crtanju - inace bi se
    // ponavljala na svaku promenu velicine prozora.
    host.classList.toggle('is-redraw', !first);
    first = false;
    host.replaceChildren();
    draw(host, w, h);
  };
  const ro = new ResizeObserver(run);
  ro.observe(host);
  host._finObserver = ro;
  run();
}

function emptyState(host, text) {
  if (host._finObserver) {
    host._finObserver.disconnect();
    host._finObserver = null;
  }
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = text;
  host.replaceChildren(p);
  return true;
}

/* --------------------------------------------------------------- donut --- */

/**
 * Prstenasti graf za odnos delova prema celini.
 * data: [{ label, value, color }] - najvise 7 segmenata (ostalo spojiti u "Ostalo").
 */
export function donut(host, { data, currency = 'RSD', centerLabel = '' }) {
  const items = (data || []).filter((d) => d.value > 0);
  if (!items.length) return emptyState(host, 'Nema podataka za ovaj prikaz.');

  autoDraw(host, (root, w, h) => {
    const t = theme();
    const total = items.reduce((a, d) => a + d.value, 0);
    const size = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    const rOut = size / 2 - 4;
    const band = Math.max(16, Math.min(30, size * 0.13));
    const rIn = rOut - band;
    const rMid = (rOut + rIn) / 2;
    const gap = items.length > 1 ? 2 / rMid : 0; // 2px razmak u boji podloge

    const svg = el('svg', { width: w, height: h, role: 'img' }, root);
    el('title', {}, svg).textContent = centerLabel || 'Struktura';

    let angle = -Math.PI / 2;
    items.forEach((d, i) => {
      const sweep = (d.value / total) * Math.PI * 2;
      const a0 = angle + gap / 2;
      const a1 = angle + sweep - gap / 2;
      angle += sweep;
      if (a1 <= a0) return;

      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
      const path = el('path', {
        d: `M ${p(rOut, a0)} A ${rOut} ${rOut} 0 ${large} 1 ${p(rOut, a1)}`
         + ` L ${p(rIn, a1)} A ${rIn} ${rIn} 0 ${large} 0 ${p(rIn, a0)} Z`,
        fill: d.color,
        class: 'donut-seg',
        tabindex: 0,
      }, svg);

      const pct = ((d.value / total) * 100).toFixed(1).replace('.', ',');
      const label = `<strong>${escapeHtml(d.label)}</strong><span>${money(d.value, currency)} · ${pct}%</span>`;
      const move = (ev) => {
        const box = path.getBoundingClientRect();
        showTip(label, ev.clientX ?? box.x + box.width / 2, ev.clientY ?? box.y);
      };
      path.addEventListener('pointermove', move);
      path.addEventListener('focus', move);
      path.addEventListener('pointerleave', hideTip);
      path.addEventListener('blur', hideTip);
      path.style.setProperty('--i', i);
    });

    // Hero broj u sredini - ukupan iznos.
    el('text', {
      x: cx, y: cy - 4, 'text-anchor': 'middle', fill: t.text,
      'font-size': Math.max(15, Math.min(24, size * 0.11)), 'font-weight': 650,
      class: 'donut-total',
    }, svg).textContent = compact(total);

    if (centerLabel) {
      el('text', {
        x: cx, y: cy + 15, 'text-anchor': 'middle', fill: t.muted,
        'font-size': 11, 'letter-spacing': '.06em',
      }, svg).textContent = centerLabel.toUpperCase();
    }
  });
  return false;
}

/* ------------------------------------------------------------- kolone --- */

/**
 * Kolone (jedna serija). data: [{ label, value, hint }]
 */
export function columns(host, { data, color, currency = 'RSD', labelEvery = 0 }) {
  const items = data || [];
  if (!items.length || items.every((d) => !d.value)) {
    return emptyState(host, 'Nema unosa za ovaj mesec.');
  }

  autoDraw(host, (root, w, h) => {
    const t = theme();
    const max = Math.max(...items.map((d) => d.value));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];

    const padL = 46;
    const padR = 8;
    const padT = 12;
    const padB = 26;
    const iw = Math.max(10, w - padL - padR);
    const ih = Math.max(10, h - padT - padB);
    const svg = el('svg', { width: w, height: h, role: 'img' }, root);
    const y = (v) => padT + ih - (v / top) * ih;

    // Recesivna mreza + y-ose.
    for (const tk of ticks) {
      el('line', {
        x1: padL, x2: w - padR, y1: y(tk).toFixed(1), y2: y(tk).toFixed(1),
        stroke: t.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, svg);
      el('text', {
        x: padL - 8, y: y(tk) + 4, 'text-anchor': 'end', fill: t.muted, 'font-size': 10,
      }, svg).textContent = compact(tk);
    }

    const band = iw / items.length;
    const bw = Math.min(24, Math.max(3, band - 2)); // 2px razmak izmedju suseda
    const every = labelEvery || Math.max(1, Math.ceil(items.length / 12));

    items.forEach((d, i) => {
      const cx = padL + band * i + band / 2;
      const bh = d.value > 0 ? Math.max(2, ih - (y(d.value) - padT)) : 0;

      if (bh > 0) {
        const r = Math.min(4, bw / 2, bh); // 4px zaobljen vrh, pravo dno
        const x0 = cx - bw / 2;
        const y0 = padT + ih - bh;
        const bar = el('path', {
          d: `M ${x0} ${y0 + bh} L ${x0} ${y0 + r} Q ${x0} ${y0} ${x0 + r} ${y0}`
           + ` L ${x0 + bw - r} ${y0} Q ${x0 + bw} ${y0} ${x0 + bw} ${y0 + r}`
           + ` L ${x0 + bw} ${y0 + bh} Z`,
          fill: color, class: 'bar-mark',
        }, svg);
        bar.style.setProperty('--i', i);
      }

      // Zona za hover je siroka kao ceo band, ne kao tanka kolona.
      const hit = el('rect', {
        x: cx - band / 2, y: padT, width: band, height: ih,
        fill: 'transparent', tabindex: 0, class: 'hit',
      }, svg);
      const label = `<strong>${escapeHtml(d.hint || d.label)}</strong><span>${money(d.value, currency)}</span>`;
      const move = (ev) => showTip(label, ev.clientX ?? 0, ev.clientY ?? 0);
      hit.addEventListener('pointermove', move);
      hit.addEventListener('focus', () => {
        const b = hit.getBoundingClientRect();
        showTip(label, b.x + b.width / 2, b.y);
      });
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);

      if (i % every === 0) {
        el('text', {
          x: cx, y: h - 8, 'text-anchor': 'middle', fill: t.muted, 'font-size': 10,
        }, svg).textContent = d.label;
      }
    });
  });
  return false;
}

/* ----------------------------------------------------- grupisane kolone --- */

/**
 * Vise serija jedna do druge. categories: [string], series: [{ name, color, values: [] }]
 */
export function groupedColumns(host, { categories, series, currency = 'RSD' }) {
  const cats = categories || [];
  if (!cats.length) return emptyState(host, 'Dodaj mesec pa ce se ovde pojaviti poredjenje.');

  autoDraw(host, (root, w, h) => {
    const t = theme();
    const max = Math.max(0, ...series.flatMap((s) => s.values));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1];

    const padL = 52;
    const padR = 10;
    const padT = 12;
    const padB = 28;
    const iw = Math.max(10, w - padL - padR);
    const ih = Math.max(10, h - padT - padB);
    const svg = el('svg', { width: w, height: h, role: 'img' }, root);
    const y = (v) => padT + ih - (v / top) * ih;

    for (const tk of ticks) {
      el('line', {
        x1: padL, x2: w - padR, y1: y(tk).toFixed(1), y2: y(tk).toFixed(1),
        stroke: t.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, svg);
      el('text', {
        x: padL - 8, y: y(tk) + 4, 'text-anchor': 'end', fill: t.muted, 'font-size': 10,
      }, svg).textContent = compact(tk);
    }

    // Kad je meseci malo, band se ogranicava da kolone ne lebde u praznini.
    const band = Math.min(iw / cats.length, 200);
    const offset = (iw - band * cats.length) / 2;
    const groupW = Math.min(band * 0.72, 24 * series.length + 2 * (series.length - 1));
    const bw = Math.max(3, (groupW - 2 * (series.length - 1)) / series.length);

    cats.forEach((cat, ci) => {
      const bandX = padL + offset + band * ci;
      const gx = bandX + (band - groupW) / 2;

      series.forEach((s, si) => {
        const v = s.values[ci] || 0;
        const x0 = gx + si * (bw + 2); // 2px razmak u boji podloge
        const bh = v > 0 ? Math.max(2, ih - (y(v) - padT)) : 0;
        if (bh > 0) {
          const r = Math.min(4, bw / 2, bh);
          const y0 = padT + ih - bh;
          el('path', {
            d: `M ${x0} ${y0 + bh} L ${x0} ${y0 + r} Q ${x0} ${y0} ${x0 + r} ${y0}`
             + ` L ${x0 + bw - r} ${y0} Q ${x0 + bw} ${y0} ${x0 + bw} ${y0 + r}`
             + ` L ${x0 + bw} ${y0 + bh} Z`,
            fill: s.color, class: 'bar-mark',
          }, svg).style.setProperty('--i', ci);
        }
      });

      const hit = el('rect', {
        x: bandX, y: padT, width: band, height: ih,
        fill: 'transparent', tabindex: 0, class: 'hit',
      }, svg);
      const rows = series
        .map((s) => `<span class="tip-row"><i style="background:${s.color}"></i>${s.name}
                     <b>${money(s.values[ci] || 0, currency)}</b></span>`)
        .join('');
      const label = `<strong>${escapeHtml(cat)}</strong>${rows}`;
      hit.addEventListener('pointermove', (ev) => showTip(label, ev.clientX, ev.clientY));
      hit.addEventListener('focus', () => {
        const b = hit.getBoundingClientRect();
        showTip(label, b.x + b.width / 2, b.y);
      });
      hit.addEventListener('pointerleave', hideTip);
      hit.addEventListener('blur', hideTip);

      el('text', {
        x: bandX + band / 2, y: h - 9,
        'text-anchor': 'middle', fill: t.muted, 'font-size': 10,
      }, svg).textContent = cat;
    });
  });
  return false;
}

/* ------------------------------------------------------- linija/povrsina --- */

/**
 * Linija sa washom (10% boje) i krstom pri hoveru. points: [{ label, value, hint }]
 */
export function areaLine(host, { points, color, currency = 'RSD', zeroLine = false }) {
  const pts = points || [];
  if (pts.length < 2) return emptyState(host, 'Potrebna su najmanje dva dana sa unosima.');

  autoDraw(host, (root, w, h) => {
    const t = theme();
    const vals = pts.map((p) => p.value);
    const { ticks, bottom, top } = niceScale(Math.min(...vals), Math.max(...vals));
    const hasNeg = bottom < 0;

    const padL = 52;
    const padR = 14;
    const padT = 14;
    const padB = 26;
    const iw = Math.max(10, w - padL - padR);
    const ih = Math.max(10, h - padT - padB);
    const svg = el('svg', { width: w, height: h, role: 'img' }, root);

    const x = (i) => padL + (iw * i) / (pts.length - 1);
    const y = (v) => padT + ih - ((v - bottom) / (top - bottom)) * ih;

    for (const tk of ticks) {
      el('line', {
        x1: padL, x2: w - padR, y1: y(tk).toFixed(1), y2: y(tk).toFixed(1),
        stroke: t.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, svg);
      el('text', {
        x: padL - 8, y: y(tk) + 4, 'text-anchor': 'end', fill: t.muted, 'font-size': 10,
      }, svg).textContent = compact(tk);
    }

    if (zeroLine && hasNeg) {
      el('line', {
        x1: padL, x2: w - padR, y1: y(0).toFixed(1), y2: y(0).toFixed(1),
        stroke: t.sub, 'stroke-width': 1, 'shape-rendering': 'crispEdges', opacity: 0.55,
      }, svg);
    }

    const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`).join(' ');
    el('path', {
      d: `${line} L ${x(pts.length - 1).toFixed(2)} ${y(0).toFixed(2)} L ${x(0).toFixed(2)} ${y(0).toFixed(2)} Z`,
      fill: color, opacity: 0.1, class: 'area-wash',
    }, svg);
    el('path', {
      d: line, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'area-line',
    }, svg);

    // Krajnja tacka: 2px prsten u boji podloge.
    const last = pts.length - 1;
    el('circle', {
      cx: x(last), cy: y(pts[last].value), r: 4.5,
      fill: color, stroke: t.surface, 'stroke-width': 2,
    }, svg);

    // Direktna oznaka samo na kraju.
    const endLabel = el('text', {
      x: Math.min(w - 4, x(last)), y: Math.max(12, y(pts[last].value) - 12),
      'text-anchor': 'end', fill: t.text, 'font-size': 11, 'font-weight': 600,
    }, svg);
    endLabel.textContent = compact(pts[last].value);

    // Krst + tooltip.
    const cross = el('line', {
      x1: 0, x2: 0, y1: padT, y2: padT + ih,
      stroke: t.sub, 'stroke-width': 1, opacity: 0, 'shape-rendering': 'crispEdges',
    }, svg);
    const dot = el('circle', {
      r: 4.5, fill: color, stroke: t.surface, 'stroke-width': 2, opacity: 0,
    }, svg);

    const overlay = el('rect', {
      x: padL, y: padT, width: iw, height: ih, fill: 'transparent', tabindex: 0,
    }, svg);
    const at = (i, clientX, clientY) => {
      const p = pts[i];
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('opacity', 0.5);
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(p.value));
      dot.setAttribute('opacity', 1);
      showTip(
        `<strong>${escapeHtml(p.hint || p.label)}</strong><span>${money(p.value, currency)}</span>`,
        clientX, clientY,
      );
    };
    overlay.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const rel = (ev.clientX - box.left - padL) / iw;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(rel * (pts.length - 1))));
      at(i, ev.clientX, ev.clientY);
    });
    overlay.addEventListener('pointerleave', () => {
      cross.setAttribute('opacity', 0);
      dot.setAttribute('opacity', 0);
      hideTip();
    });
  });
  return false;
}

/* ---------------------------------------------------------- sparkline --- */

export function sparkline(host, { values, color }) {
  const vals = values || [];
  host.replaceChildren();
  if (vals.length < 2) return;

  const w = 96;
  const h = 28;
  const max = Math.max(...vals);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}`, 'aria-hidden': 'true' }, host);
  const d = vals
    .map((v, i) => {
      const x = (w * i) / (vals.length - 1);
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
