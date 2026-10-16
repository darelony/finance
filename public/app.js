/** Finansije - klijentska logika */
'use strict';

import { donut, columns, groupedColumns, areaLine, money, escapeHtml, hideTip } from './charts.js';

/* ---------------------------------------------------------------- opste --- */

const MESECI = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
                'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];
const MESECI_KRATKO = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun',
                       'Jul', 'Avg', 'Sep', 'Okt', 'Nov', 'Dec'];

const KIND = {
  prihod: { naziv: 'Primio',   slot: 1, znak: '+' },
  trosak: { naziv: 'Potrošio', slot: 2, znak: '−' },
  stek:   { naziv: 'Štek',     slot: 3, znak: '→' },
};

const PREDLOZI = {
  prihod: ['Plata', 'Honorar', 'Freelance', 'Bonus', 'Prodaja', 'Ostalo'],
  trosak: ['Hrana', 'Stanovanje', 'Računi', 'Transport', 'Zabava', 'Zdravlje', 'Odeća', 'Ostalo'],
  stek:   ['Ušteđevina', 'Investicije', 'Rezerva', 'Keš'],
};

/**
 * Vrednost tokena se cita iz CSS-a i vraca kao pravi hex.
 * SVG presentation atributi ne podnose var() svuda pouzdano, a ceo prikaz se
 * ionako ponovo iscrtava pri promeni teme - pa je resavanje u trenutku
 * iscrtavanja i najsigurnije i najjednostavnije.
 */
const FALLBACK = ['#3987e5', '#d95926', '#199e70', '#c98500',
                  '#d55181', '#008300', '#9085e9', '#e66767'];

function slot(n) {
  const i = ((n - 1) % 8 + 8) % 8;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(`--series-${i + 1}`).trim();
  return v || FALLBACK[i];
}
const kindColor = (k) => slot(KIND[k].slot);

const $ = (sel, root = document) => root.querySelector(sel);
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const pad2 = (n) => String(n).padStart(2, '0');

/* -------------------------------------------- stabilne boje kategorija --- */
/* Kategorija zadrzava svoju boju zauvek - boja prati stvar, ne njen rang.  */

const REG_KEY = 'fin.catColorSlots';
let registry = {};
try { registry = JSON.parse(localStorage.getItem(REG_KEY) || '{}'); } catch { registry = {}; }

// Podrazumevane kategorije dobijaju fiksne slotove, da izgled bude stabilan od starta.
PREDLOZI.trosak.forEach((name, i) => {
  if (registry[name] == null) registry[name] = i + 1;
});

/** Slot koji kategorija "poseduje" - upisuje se jednom i vise se ne menja. */
function catSlot(name) {
  const key = String(name || 'Bez kategorije');
  if (registry[key] == null) {
    const used = new Set(Object.values(registry));
    let free = 1;
    while (free <= 8 && used.has(free)) free += 1;
    registry[key] = free <= 8 ? free : (Object.keys(registry).length % 8) + 1;
    try { localStorage.setItem(REG_KEY, JSON.stringify(registry)); } catch { /* nema veze */ }
  }
  return registry[key];
}

const catColor = (name) => slot(catSlot(name));

/**
 * Boje za jedan graf: svaka kategorija prvo dobija svoj slot, a ako je taj
 * slot u ovom grafu vec zauzet (ima ih preko osam u bazi), uzima najblizi
 * slobodan - da dva susedna segmenta nikad ne budu iste boje.
 */
function assignColors(labels) {
  const taken = new Set();
  const out = new Map();

  for (const label of labels) {
    let s = catSlot(label);
    if (taken.has(s)) {
      for (let d = 1; d <= 8 && taken.has(s); d += 1) s = ((catSlot(label) - 1 + d) % 8) + 1;
    }
    taken.add(s);
    out.set(label, slot(s));
  }
  return out;
}

/* ----------------------------------------------------------------- api --- */

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !locked()) {
    // Prijava je istekla (server je bio ugašen) - traži šifru ispočetka.
    location.reload();
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Greška u komunikaciji sa bazom.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* -------------------------------------------------------------- prijava --- */

const locked = () => document.documentElement.hasAttribute('data-locked');

/** Da li vec vazi prijava iz ovog prozora. */
const prijavljen = () => api('GET', 'session').then((r) => r.ulogovan).catch(() => false);

/** Ceka na tacnu sifru; vraca se tek kad je ulaz otvoren. */
function otkljucaj() {
  return new Promise((resolve) => {
    const form = $('#gateForm');
    const polje = $('#f-pin');
    const greska = $('#gateError');
    const dugme = $('#gateBtn');

    polje.focus();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      greska.textContent = '';
      dugme.disabled = true;
      try {
        await api('POST', 'login', { sifra: polje.value });
        document.documentElement.removeAttribute('data-locked');
        resolve();
      } catch (err) {
        greska.textContent = err.status === 401
          ? 'Šifra nije tačna.'
          : (err.message || 'Server nije dostupan.');
        polje.value = '';
        polje.focus();
      } finally {
        dugme.disabled = false;
      }
    });
  });
}

/* --------------------------------------------------------------- stanje --- */

const state = {
  months: [],
  route: 'overview',      // 'overview' | broj (id meseca)
  data: null,             // payload aktivnog meseca
  overview: null,
  settings: { currency: 'RSD' },
  categories: { prihod: [], trosak: [], stek: [] },
  filter: 'sve',
  search: '',
};

const cur = () => state.settings.currency || 'RSD';
const fmt = (n, exact = false) => money(n, cur(), exact);

/* --------------------------------------------------------------- toast --- */

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
}

/* ------------------------------------------------------------------ nav --- */

function renderNav() {
  const nav = $('#nav');
  const parts = [
    `<button class="pill ${state.route === 'overview' ? 'is-active' : ''}" data-route="overview">
       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
         <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
       </svg>
       Pregled
     </button>`,
  ];

  for (const m of state.months) {
    parts.push(
      `<button class="pill ${state.route === m.id ? 'is-active' : ''}" data-route="${m.id}">
         <span class="dot" style="background:${state.route === m.id ? 'currentColor' : slot(1)}"></span>
         ${MESECI_KRATKO[m.month - 1]} ${m.year}
       </button>`,
    );
  }

  parts.push(
    `<button class="pill is-add" id="addMonthPill">
       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
       Dodaj mesec
     </button>`,
  );

  nav.innerHTML = parts.join('');
}

/* ---------------------------------------------------------- stat tiles --- */

function tile({ label, value, meta, accent }) {
  return `
    <div class="tile" style="--accent:${accent}">
      <div class="label"><i></i>${escapeHtml(label)}</div>
      <div class="value num">${escapeHtml(value)}</div>
      <div class="meta">${meta || ''}</div>
    </div>`;
}

/* --------------------------------------------------- prikaz jednog meseca --- */

function renderMonth() {
  const d = state.data;
  const m = d.month;
  const dim = daysInMonth(m.year, m.month);
  const stopa = d.totals.prihod > 0 ? (d.totals.stek / d.totals.prihod) * 100 : 0;
  const odnos = d.totals.prihod > 0 ? (d.totals.trosak / d.totals.prihod) * 100 : 0;

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>${MESECI[m.month - 1]} ${m.year}</h1>
        <p class="sub">
          ${d.entries.length} ${d.entries.length === 1 ? 'unos' : 'unosa'} · ${dim} dana
          ${m.note ? ` · ${escapeHtml(m.note)}` : ''}
        </p>
      </div>
      <div class="head-actions">
        <button class="btn btn-primary" id="newEntryBtn">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          Novi unos
        </button>
        <button class="btn btn-danger" id="delMonthBtn" title="Obriši ovaj mesec">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
          </svg>
        </button>
      </div>
    </div>

    <section class="tiles">
      ${tile({
        label: 'Primio', accent: kindColor('prihod'),
        value: fmt(d.totals.prihod),
        meta: `${d.counts.prihod} ${d.counts.prihod === 1 ? 'uplata' : 'uplata'}`,
      })}
      ${tile({
        label: 'Potrošio', accent: kindColor('trosak'),
        value: fmt(d.totals.trosak),
        meta: d.totals.prihod > 0
          ? `${odnos.toFixed(0)}% od prihoda`
          : `${d.counts.trosak} ${d.counts.trosak === 1 ? 'trošak' : 'troška'}`,
      })}
      ${tile({
        label: 'U štek', accent: kindColor('stek'),
        value: fmt(d.totals.stek),
        meta: d.totals.prihod > 0 ? `stopa štednje ${stopa.toFixed(0)}%` : 'nema prihoda za odnos',
      })}
      ${tile({
        label: 'Slobodno', accent: slot(7),
        value: fmt(d.slobodno),
        meta: d.slobodno < 0 ? 'u minusu za ovaj mesec' : 'nije potrošeno ni ostavljeno',
      })}
    </section>

    <div class="grid two">
      <section class="card">
        <div class="card-head">
          <h2>Na šta je otišlo</h2>
          <span class="hint">${d.troskoviPoKategoriji.length} ${d.troskoviPoKategoriji.length === 1 ? 'kategorija' : 'kategorija'}</span>
        </div>
        <div class="donut-wrap">
          <div class="chart" id="donutHost" style="height:210px" data-height="210"></div>
          <div class="cat-list" id="catList"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Koliko ti ostaje kroz mesec</h2>
          <span class="hint">Primljeno minus potrošeno i štek, dan po dan</span>
        </div>
        <div class="chart" id="areaHost" style="height:246px" data-height="246"></div>
      </section>
    </div>

    <div class="grid">
      <section class="card">
        <div class="card-head">
          <h2>Dnevna potrošnja</h2>
          <span class="hint">Svaki dan u ${MESECI[m.month - 1].toLowerCase()}u</span>
        </div>
        <div class="chart" id="dailyHost" style="height:210px" data-height="210"></div>
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>Svi unosi</h2></div>
      <div class="table-tools">
        <div class="seg" id="filterSeg">
          <button data-f="sve" class="${state.filter === 'sve' ? 'is-active' : ''}">Sve</button>
          <button data-f="prihod" class="${state.filter === 'prihod' ? 'is-active' : ''}">Primio</button>
          <button data-f="trosak" class="${state.filter === 'trosak' ? 'is-active' : ''}">Potrošio</button>
          <button data-f="stek" class="${state.filter === 'stek' ? 'is-active' : ''}">Štek</button>
        </div>
        <input class="search" id="searchBox" placeholder="Traži po kategoriji ili napomeni…"
               value="${escapeHtml(state.search)}">
      </div>
      <div class="table-scroll" id="tableHost"></div>
    </section>
  `;

  drawMonthCharts();
  renderTable();

  $('#newEntryBtn').addEventListener('click', () => openEntry());
  $('#delMonthBtn').addEventListener('click', deleteMonth);
  $('#filterSeg').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-f]');
    if (!b) return;
    state.filter = b.dataset.f;
    for (const x of $('#filterSeg').children) x.classList.toggle('is-active', x === b);
    renderTable();
  });
  $('#searchBox').addEventListener('input', (ev) => {
    state.search = ev.target.value;
    renderTable();
  });
}

function drawMonthCharts() {
  const d = state.data;
  const m = d.month;
  const dim = daysInMonth(m.year, m.month);

  /* --- donut: najvece 6 kategorija + Ostalo (najvise 7 segmenata) --- */
  const cats = [...d.troskoviPoKategoriji].map((c) => ({
    label: c.category || 'Bez kategorije',
    value: c.total,
  }));
  let segments = cats;
  if (cats.length > 7) {
    const top = cats.slice(0, 6);
    const rest = cats.slice(6).reduce((a, c) => a + c.value, 0);
    segments = [...top, { label: 'Ostalo', value: rest }];
  }
  const paint = assignColors(segments.map((s) => s.label));
  segments = segments.map((s) => ({ ...s, color: paint.get(s.label) }));

  donut($('#donutHost'), { data: segments, currency: cur(), centerLabel: 'potrošeno' });

  // Legenda uz donut: naziv + iznos + procenat (identitet nikad ne pociva samo na boji).
  const totalTrosak = cats.reduce((a, c) => a + c.value, 0);
  $('#catList').innerHTML = segments.length
    ? segments.map((s) => {
        const pct = totalTrosak > 0 ? (s.value / totalTrosak) * 100 : 0;
        return `
          <div class="cat-row">
            <i style="background:${s.color}"></i>
            <span class="name">${escapeHtml(s.label)}</span>
            <span><span class="amt num">${escapeHtml(fmt(s.value))}</span><span class="pct num">${pct.toFixed(0)}%</span></span>
            <div class="cat-bar"><span style="width:${pct.toFixed(1)}%;background:${s.color}"></span></div>
          </div>`;
      }).join('')
    : '<p class="chart-empty">Još nema troškova u ovom mesecu.</p>';

  /* --- dnevna potrosnja --- */
  const perDay = new Map();
  for (const row of d.poDanima) {
    const day = Number(row.date.slice(8, 10));
    if (!perDay.has(day)) perDay.set(day, { prihod: 0, trosak: 0, stek: 0 });
    perDay.get(day)[row.kind] = row.total;
  }
  const daily = [];
  for (let day = 1; day <= dim; day += 1) {
    const v = perDay.get(day) || { prihod: 0, trosak: 0, stek: 0 };
    daily.push({
      label: String(day),
      value: v.trosak,
      hint: `${day}. ${MESECI[m.month - 1].toLowerCase()} ${m.year}`,
    });
  }
  columns($('#dailyHost'), { data: daily, color: kindColor('trosak'), currency: cur() });

  /* --- kumulativno "koliko ti ostaje" --- */
  let running = 0;
  const points = [];
  for (let day = 1; day <= dim; day += 1) {
    const v = perDay.get(day) || { prihod: 0, trosak: 0, stek: 0 };
    running += v.prihod - v.trosak - v.stek;
    points.push({
      label: String(day),
      value: running,
      hint: `${day}. ${MESECI[m.month - 1].toLowerCase()} - stanje`,
    });
  }
  // Jedna serija - jedna boja. Minus se cita sa nulte linije i iz predznaka,
  // ne iz promene boje.
  areaLine($('#areaHost'), {
    points: d.entries.length ? points : [],
    color: slot(7),
    currency: cur(),
    zeroLine: true,
  });
}

function renderTable() {
  const d = state.data;
  const term = state.search.trim().toLowerCase();
  const rows = d.entries.filter((e) => {
    if (state.filter !== 'sve' && e.kind !== state.filter) return false;
    if (!term) return true;
    return `${e.category} ${e.description}`.toLowerCase().includes(term);
  });

  if (!rows.length) {
    $('#tableHost').innerHTML = `<p class="chart-empty">${
      d.entries.length ? 'Nema unosa koji odgovaraju filteru.' : 'Još nema unosa - klikni „Novi unos“.'
    }</p>`;
    return;
  }

  $('#tableHost').innerHTML = `
    <table class="data">
      <thead>
        <tr>
          <th style="width:96px">Datum</th>
          <th style="width:118px">Tip</th>
          <th style="width:150px">Kategorija</th>
          <th>Napomena</th>
          <th class="t-right" style="width:140px">Iznos</th>
          <th style="width:70px"></th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((e) => {
          const k = KIND[e.kind];
          const dt = e.date.split('-');
          return `
            <tr>
              <td class="num">${dt[2]}.${dt[1]}.</td>
              <td><span class="chip"><i style="background:${kindColor(e.kind)}"></i>${k.naziv}</span></td>
              <td>${e.category
                ? `<span class="chip"><i style="background:${catColor(e.category)}"></i>${escapeHtml(e.category)}</span>`
                : '<span style="color:var(--text-muted)">—</span>'}</td>
              <td>${escapeHtml(e.description) || '<span style="color:var(--text-muted)">—</span>'}</td>
              <td class="t-right num" style="font-weight:600">${k.znak} ${escapeHtml(fmt(e.amount, true))}</td>
              <td>
                <div class="row-actions">
                  <button class="mini" data-edit="${e.id}" title="Izmeni" aria-label="Izmeni unos">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                  </button>
                  <button class="mini del" data-del="${e.id}" title="Obriši" aria-label="Obriši unos">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                  </button>
                </div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

/** Akcije u redovima tabele - jedan delegirani hendler za ceo dokument. */
async function handleRowAction(ev) {
  const edit = ev.target.closest('[data-edit]');
  const del = ev.target.closest('[data-del]');
  if (!edit && !del) return;

  const d = state.data;
  if (!d) return;

  if (edit) {
    const entry = d.entries.find((x) => x.id === Number(edit.dataset.edit));
    if (entry) openEntry(entry);
    return;
  }

  const id = Number(del.dataset.del);
  const entry = d.entries.find((x) => x.id === id);
  if (!entry || !confirm(`Obrisati unos na ${fmt(entry.amount, true)}?`)) return;
  try {
    state.data = await api('DELETE', `entries/${id}`, { month_id: d.month.id });
    state.overview = null;
    renderMonth();
    toast('Unos obrisan.');
  } catch (err) { toast(err.message); }
}

/* ---------------------------------------------------- godisnji pregled --- */

function renderOverview() {
  const o = state.overview;
  const list = [...o.months].sort((a, b) => (a.year - b.year) || (a.month - b.month));

  if (!state.months.length) {
    $('#view').innerHTML = `
      <div class="blank">
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/>
          <path d="M8 14h3M8 17.5h6"/>
        </svg>
        <h2>Počni od prvog meseca</h2>
        <p>Dodaj mesec i dobićeš dashboard na koji unosiš koliko si primio,
           koliko i na šta si potrošio i koliko si stavio u štek.</p>
        <button class="btn btn-primary" id="blankAdd">Dodaj prvi mesec</button>
      </div>`;
    $('#blankAdd').addEventListener('click', openMonth);
    return;
  }

  const u = o.ukupno;
  const stopa = u.prihod > 0 ? (u.stek / u.prihod) * 100 : 0;
  const prosek = list.length ? u.trosak / list.length : 0;
  const najskuplji = list.reduce((a, b) => (b.trosak > (a?.trosak ?? -1) ? b : a), null);

  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <h1>Pregled</h1>
        <p class="sub">${list.length} ${list.length === 1 ? 'mesec' : 'meseci'} u bazi ·
          ${list[0] ? `${MESECI_KRATKO[list[0].month - 1]} ${list[0].year}` : ''}
          ${list.length > 1 ? `– ${MESECI_KRATKO[list[list.length - 1].month - 1]} ${list[list.length - 1].year}` : ''}
        </p>
      </div>
      <div class="head-actions">
        <button class="btn btn-primary" id="ovAddMonth">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          Dodaj mesec
        </button>
      </div>
    </div>

    <section class="tiles">
      ${tile({ label: 'Ukupno primljeno', accent: kindColor('prihod'), value: fmt(u.prihod),
               meta: 'kroz sve mesece' })}
      ${tile({ label: 'Ukupno potrošeno', accent: kindColor('trosak'), value: fmt(u.trosak),
               meta: `prosek ${fmt(prosek)} mesečno` })}
      ${tile({ label: 'Ukupno u šteku', accent: kindColor('stek'), value: fmt(u.stek),
               meta: `stopa štednje ${stopa.toFixed(0)}%` })}
      ${tile({ label: 'Slobodno', accent: slot(7), value: fmt(u.slobodno),
               meta: najskuplji ? `najskuplji: ${MESECI_KRATKO[najskuplji.month - 1]} ${najskuplji.year}` : '' })}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Mesec po mesec</h2>
        <div class="legend">
          <span class="item"><i style="background:${kindColor('prihod')}"></i>Primio</span>
          <span class="item"><i style="background:${kindColor('trosak')}"></i>Potrošio</span>
          <span class="item"><i style="background:${kindColor('stek')}"></i>Štek</span>
        </div>
      </div>
      <div class="chart" id="ovChart" style="height:280px" data-height="280"></div>
    </section>

    <section class="card" style="margin-top:14px">
      <div class="card-head"><h2>Tabela po mesecima</h2></div>
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Mesec</th>
              <th class="t-right">Primio</th>
              <th class="t-right">Potrošio</th>
              <th class="t-right">Štek</th>
              <th class="t-right">Slobodno</th>
              <th class="t-right">Stopa štednje</th>
              <th style="width:56px"></th>
            </tr>
          </thead>
          <tbody>
            ${[...list].reverse().map((r) => {
              const free = r.prihod - r.trosak - r.stek;
              const s = r.prihod > 0 ? (r.stek / r.prihod) * 100 : 0;
              return `
                <tr>
                  <td style="font-weight:580">${MESECI[r.month - 1]} ${r.year}</td>
                  <td class="t-right num">${escapeHtml(fmt(r.prihod))}</td>
                  <td class="t-right num">${escapeHtml(fmt(r.trosak))}</td>
                  <td class="t-right num">${escapeHtml(fmt(r.stek))}</td>
                  <td class="t-right num" style="font-weight:600">${escapeHtml(fmt(free))}</td>
                  <td class="t-right num">${r.prihod > 0 ? `${s.toFixed(0)}%` : '—'}</td>
                  <td class="t-right">
                    <button class="mini" data-open="${r.id}" title="Otvori dashboard" aria-label="Otvori mesec">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9 6l6 6-6 6"/></svg>
                    </button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  groupedColumns($('#ovChart'), {
    categories: list.map((r) => `${MESECI_KRATKO[r.month - 1]} ${String(r.year).slice(2)}`),
    series: [
      { name: 'Primio',   color: kindColor('prihod'), values: list.map((r) => r.prihod) },
      { name: 'Potrošio', color: kindColor('trosak'), values: list.map((r) => r.trosak) },
      { name: 'Štek',     color: kindColor('stek'),   values: list.map((r) => r.stek) },
    ],
    currency: cur(),
  });

  $('#ovAddMonth').addEventListener('click', openMonth);
}

/* -------------------------------------------------------------- rutiranje --- */

const hashFor = (route) => (route === 'overview' ? '#/pregled' : `#/mesec/${route}`);

function routeFromHash() {
  const m = /^#\/mesec\/(\d+)$/.exec(location.hash);
  if (m) return Number(m[1]);
  return location.hash === '#/pregled' ? 'overview' : null;
}

/** Menja rutu preko hash-a, tako da Back/Forward u prozoru rade normalno. */
function go(route) {
  const target = hashFor(route);
  if (location.hash === target) return render(route);
  location.hash = target;   // hashchange pokrece render
  return undefined;
}

async function render(route) {
  hideTip();
  state.route = route;
  state.filter = 'sve';
  state.search = '';
  renderNav();

  try {
    if (route === 'overview') {
      state.overview = await api('GET', 'overview');
      renderOverview();
    } else {
      state.data = await api('GET', `months/${route}`);
      renderMonth();
    }
    localStorage.setItem('fin.route', String(route));
  } catch (err) {
    toast(err.message);
    if (route !== 'overview') go('overview');
  }
}

window.addEventListener('hashchange', () => {
  const route = routeFromHash();
  if (route !== null) render(route);
});

/* ---------------------------------------------------------- modal: unos --- */

const entryModal = $('#entryModal');
let editingId = null;

function openEntry(entry = null) {
  const m = state.data.month;
  editingId = entry ? entry.id : null;

  $('#entryTitle').textContent = entry ? 'Izmeni unos' : 'Novi unos';
  $('#entrySubmit').textContent = entry ? 'Sačuvaj izmene' : 'Sačuvaj unos';
  $('#entryError').textContent = '';

  const kind = entry ? entry.kind : 'trosak';
  $(`input[name="kind"][value="${kind}"]`).checked = true;
  $('#f-amount').value = entry ? String(entry.amount).replace('.', ',') : '';
  $('#f-category').value = entry ? entry.category : '';
  $('#f-desc').value = entry ? entry.description : '';

  // Podrazumevani datum: danas ako je danas u tom mesecu, inace prvi dan meseca.
  const now = new Date();
  const inThisMonth = now.getFullYear() === m.year && now.getMonth() + 1 === m.month;
  const defDate = inThisMonth
    ? `${m.year}-${pad2(m.month)}-${pad2(now.getDate())}`
    : `${m.year}-${pad2(m.month)}-01`;
  $('#f-date').value = entry ? entry.date : defDate;
  $('#f-date').min = `${m.year}-${pad2(m.month)}-01`;
  $('#f-date').max = `${m.year}-${pad2(m.month)}-${pad2(daysInMonth(m.year, m.month))}`;

  refreshCatSuggestions();
  entryModal.showModal();
  setTimeout(() => $('#f-amount').focus(), 30);
}

function refreshCatSuggestions() {
  const kind = $('input[name="kind"]:checked').value;
  const seen = state.categories[kind] || [];
  const all = [...new Set([...seen, ...PREDLOZI[kind]])];

  $('#entryCatList').innerHTML = all.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');

  $('#catChips').innerHTML = all.slice(0, 8)
    .map((c) => `<button type="button" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
    .join('');
}

$('#entryForm').addEventListener('change', (ev) => {
  if (ev.target.name === 'kind') refreshCatSuggestions();
});

$('#catChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-cat]');
  if (b) $('#f-category').value = b.dataset.cat;
});

$('#entryForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = {
    month_id: state.data.month.id,
    kind: $('input[name="kind"]:checked').value,
    amount: $('#f-amount').value.trim(),
    date: $('#f-date').value,
    category: $('#f-category').value.trim(),
    description: $('#f-desc').value.trim(),
  };

  try {
    state.data = editingId
      ? await api('PUT', `entries/${editingId}`, payload)
      : await api('POST', 'entries', payload);
    state.overview = null;
    state.categories = await api('GET', 'categories');
    entryModal.close();
    renderMonth();
    toast(editingId ? 'Unos izmenjen.' : 'Unos sačuvan.');
  } catch (err) {
    $('#entryError').textContent = err.message;
  }
});

/* --------------------------------------------------------- modal: mesec --- */

const monthModal = $('#monthModal');

function openMonth() {
  const now = new Date();
  const sel = $('#f-month');
  sel.innerHTML = MESECI.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('');
  sel.value = String(now.getMonth() + 1);
  $('#f-year').value = String(now.getFullYear());
  $('#f-note').value = '';
  $('#monthError').textContent = '';
  monthModal.showModal();
}

$('#monthForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const res = await api('POST', 'months', {
      year: $('#f-year').value,
      month: $('#f-month').value,
      note: $('#f-note').value.trim(),
    });
    state.months = (await api('GET', 'months')).months;
    state.overview = null;
    monthModal.close();
    go(res.month.id);
    toast(`Dashboard za ${MESECI[res.month.month - 1]} ${res.month.year} je spreman.`);
  } catch (err) {
    $('#monthError').textContent = err.message;
  }
});

async function deleteMonth() {
  const m = state.data.month;
  const n = state.data.entries.length;
  const txt = `Obrisati ${MESECI[m.month - 1]} ${m.year}?`
    + (n ? `\n\nSa njim se briše i ${n} ${n === 1 ? 'unos' : 'unosa'}. Ovo se ne može vratiti.` : '');
  if (!confirm(txt)) return;
  try {
    await api('DELETE', `months/${m.id}`);
    state.months = (await api('GET', 'months')).months;
    state.overview = null;
    go('overview');
    toast('Mesec obrisan.');
  } catch (err) { toast(err.message); }
}

/* --------------------------------------------------- modal: podesavanja --- */

const settingsModal = $('#settingsModal');

$('#settingsBtn').addEventListener('click', () => {
  $('#f-currency').value = cur();
  settingsModal.showModal();
});

$('#settingsForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const currency = $('#f-currency').value.trim() || 'RSD';
  try {
    state.settings = await api('PUT', 'settings', { currency });
    settingsModal.close();
    go(state.route);
    toast('Sačuvano.');
  } catch (err) { toast(err.message); }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const data = await api('GET', 'export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `finansije-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Izvezeno u Downloads.');
  } catch (err) { toast(err.message); }
});

/* ---------------------------------------------------------------- opste --- */

document.addEventListener('click', (ev) => {
  const close = ev.target.closest('[data-close]');
  if (close) { close.closest('dialog').close(); return; }

  const pill = ev.target.closest('.pill[data-route]');
  if (pill) { go(pill.dataset.route === 'overview' ? 'overview' : Number(pill.dataset.route)); return; }

  if (ev.target.closest('#addMonthPill')) { openMonth(); return; }

  const open = ev.target.closest('[data-open]');
  if (open) { go(Number(open.dataset.open)); return; }

  handleRowAction(ev);
});

$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('fin.theme', next);
  go(state.route); // grafovi se prekrsavaju sa novim tokenima
});

document.addEventListener('keydown', (ev) => {
  if (locked()) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n' && state.route !== 'overview') {
    ev.preventDefault();
    openEntry();
  }
});

window.addEventListener('scroll', hideTip, { passive: true });

// Znak zivota serveru - kad se prozor zatvori, server se sam gasi.
const ping = () => fetch('/api/ping').catch(() => {});
ping();
setInterval(ping, 25_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ping();
});

/* -------------------------------------------------------------- pokreni --- */

(async function init() {
  // Bez izricitog izbora - prati temu sistema.
  const storedTheme = localStorage.getItem('fin.theme');
  document.documentElement.dataset.theme = storedTheme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  // Ulaz je zakljucan sifrom - bez nje server ne daje nijedan podatak.
  if (await prijavljen()) document.documentElement.removeAttribute('data-locked');
  else await otkljucaj();

  try {
    const [months, settings, categories] = await Promise.all([
      api('GET', 'months'),
      api('GET', 'settings'),
      api('GET', 'categories'),
    ]);
    state.months = months.months;
    state.settings = settings;
    state.categories = categories;
  } catch (err) {
    $('#view').innerHTML = `<div class="blank"><h2>Baza nije dostupna</h2><p>${escapeHtml(err.message)}</p></div>`;
    return;
  }

  // Prednost ima ruta iz adrese, pa poslednja otvorena iz prethodnog pokretanja.
  const known = (r) => r === 'overview' || state.months.some((m) => m.id === r);
  const fromHash = routeFromHash();
  const fromStore = localStorage.getItem('fin.route') === 'overview'
    ? 'overview'
    : Number(localStorage.getItem('fin.route'));

  let start = 'overview';
  if (fromHash !== null && known(fromHash)) start = fromHash;
  else if (known(fromStore)) start = fromStore;

  // Adresa i prikaz idu u isto stanje, ali bez dvostrukog iscrtavanja:
  // ako hash treba da se promeni, render pokrece hashchange.
  if (location.hash === hashFor(start)) render(start);
  else location.hash = hashFor(start);
})();
