/**
 * Finansije - lokalni server.
 * Bez ijedne eksterne zavisnosti: koristi ugradjeni node:sqlite (Node 22+).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'finansije.db');
const PORT = Number(process.env.FIN_PORT || 4318);
const OPEN_BROWSER = process.argv.includes('--open');

/* --------------------------------------------------------------- sifra --- */
/* Ulaz u aplikaciju je zakljucan. Sifra se menja samo ovde.                */

const PIN = '0106';
const AUTH_COOKIE = 'fin_auth';

// Tokeni zive u memoriji: kad se server ugasi, prijava prestaje da vazi.
const sessions = new Set();

/* ---------------------------------------------------------------- baza --- */

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS months (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (year, month)
  );

  CREATE TABLE IF NOT EXISTS entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    month_id    INTEGER NOT NULL REFERENCES months(id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('prihod','trosak','stek')),
    amount      REAL    NOT NULL,
    category    TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    date        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_entries_month ON entries(month_id);
  CREATE INDEX IF NOT EXISTS idx_entries_date  ON entries(date);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings(key, value) VALUES ('currency', 'RSD');
`);

const q = {
  months:     db.prepare('SELECT * FROM months ORDER BY year DESC, month DESC'),
  month:      db.prepare('SELECT * FROM months WHERE id = ?'),
  monthByYM:  db.prepare('SELECT * FROM months WHERE year = ? AND month = ?'),
  addMonth:   db.prepare('INSERT INTO months (year, month, note) VALUES (?, ?, ?)'),
  setNote:    db.prepare('UPDATE months SET note = ? WHERE id = ?'),
  delMonth:   db.prepare('DELETE FROM months WHERE id = ?'),

  entries:    db.prepare('SELECT * FROM entries WHERE month_id = ? ORDER BY date DESC, id DESC'),
  addEntry:   db.prepare(`INSERT INTO entries (month_id, kind, amount, category, description, date)
                          VALUES (?, ?, ?, ?, ?, ?)`),
  updEntry:   db.prepare(`UPDATE entries SET kind = ?, amount = ?, category = ?, description = ?, date = ?
                          WHERE id = ?`),
  delEntry:   db.prepare('DELETE FROM entries WHERE id = ?'),

  totals:     db.prepare(`SELECT kind, SUM(amount) AS total, COUNT(*) AS cnt
                          FROM entries WHERE month_id = ? GROUP BY kind`),
  byCategory: db.prepare(`SELECT category, SUM(amount) AS total, COUNT(*) AS cnt
                          FROM entries WHERE month_id = ? AND kind = ?
                          GROUP BY category ORDER BY total DESC`),
  byDay:      db.prepare(`SELECT date, kind, SUM(amount) AS total
                          FROM entries WHERE month_id = ? GROUP BY date, kind ORDER BY date`),
  knownCats:  db.prepare(`SELECT DISTINCT category FROM entries
                          WHERE kind = ? AND category <> '' ORDER BY category`),

  overview:   db.prepare(`SELECT m.id, m.year, m.month, e.kind, COALESCE(SUM(e.amount), 0) AS total
                          FROM months m LEFT JOIN entries e ON e.month_id = m.id
                          GROUP BY m.id, e.kind ORDER BY m.year, m.month`),

  settings:   db.prepare('SELECT key, value FROM settings'),
  setSetting: db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
};

const KINDS = ['prihod', 'trosak', 'stek'];

function monthPayload(id) {
  const m = q.month.get(id);
  if (!m) return null;

  const totals = { prihod: 0, trosak: 0, stek: 0 };
  const counts = { prihod: 0, trosak: 0, stek: 0 };
  for (const row of q.totals.all(id)) {
    totals[row.kind] = row.total || 0;
    counts[row.kind] = row.cnt || 0;
  }

  return {
    month: m,
    entries: q.entries.all(id),
    totals,
    counts,
    slobodno: totals.prihod - totals.trosak - totals.stek,
    troskoviPoKategoriji: q.byCategory.all(id, 'trosak'),
    prihodiPoKategoriji: q.byCategory.all(id, 'prihod'),
    poDanima: q.byDay.all(id),
  };
}

function overviewPayload() {
  const map = new Map();
  for (const r of q.overview.all()) {
    if (!map.has(r.id)) {
      map.set(r.id, { id: r.id, year: r.year, month: r.month, prihod: 0, trosak: 0, stek: 0 });
    }
    if (r.kind) map.get(r.id)[r.kind] = r.total || 0;
  }
  const months = [...map.values()];
  const sum = (k) => months.reduce((a, m) => a + m[k], 0);
  return {
    months,
    ukupno: {
      prihod: sum('prihod'),
      trosak: sum('trosak'),
      stek: sum('stek'),
      slobodno: sum('prihod') - sum('trosak') - sum('stek'),
    },
  };
}

/* ------------------------------------------------------------------ api --- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const str = (v) => String(v ?? '').trim();

function validateEntry(body) {
  const month_id = num(body.month_id);
  const kind = str(body.kind);
  const amount = num(body.amount);
  const date = str(body.date);

  if (!Number.isInteger(month_id)) throw new HttpError(400, 'Nedostaje mesec.');
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Neispravan tip unosa.');
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Iznos mora biti broj veci od nule.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Neispravan datum.');

  return {
    month_id,
    kind,
    amount,
    date,
    category: str(body.category).slice(0, 60),
    description: str(body.description).slice(0, 300),
  };
}

function tokenFromCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...val] = part.trim().split('=');
    if (key === AUTH_COOKIE) return val.join('=');
  }
  return '';
}

const isLoggedIn = (req) => sessions.has(tokenFromCookie(req));

/**
 * Prijava i cuvar ostatka API-ja.
 * Vraca true ako je zahtev vec odgovoren, pa dalje ne treba nista.
 */
function handleAuth(req, res, seg, body) {
  const reply = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  if (req.method === 'GET' && seg[0] === 'session') {
    reply(200, { ulogovan: isLoggedIn(req) });
    return true;
  }

  if (req.method === 'POST' && seg[0] === 'login') {
    if (str(body.sifra) !== PIN) {
      // Pauza posle pogresne sifre - da masinsko probanje nema smisla.
      setTimeout(() => reply(401, { error: 'Sifra nije tacna.' }), 700);
      return true;
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // Bez Max-Age: kolacic umire sa prozorom, pa sledece pokretanje trazi sifru.
      'set-cookie': `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Ping je namerno otvoren: ne nosi nijedan podatak, a drzi server zivim
  // dok stojimo na ekranu za prijavu.
  if (seg[0] !== 'ping' && !isLoggedIn(req)) throw new HttpError(401, 'Potrebna je sifra.');
  return false;
}

function api(method, seg, body) {
  // ---- meseci ----
  if (method === 'GET' && seg[0] === 'months' && seg.length === 1) {
    return { months: q.months.all() };
  }

  if (method === 'POST' && seg[0] === 'months' && seg.length === 1) {
    const year = num(body.year);
    const month = num(body.month);
    if (!Number.isInteger(year) || year < 1990 || year > 2200) throw new HttpError(400, 'Neispravna godina.');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new HttpError(400, 'Neispravan mesec.');
    if (q.monthByYM.get(year, month)) throw new HttpError(409, 'Taj mesec je vec dodat.');
    const info = q.addMonth.run(year, month, str(body.note));
    return { month: q.month.get(Number(info.lastInsertRowid)) };
  }

  if (method === 'GET' && seg[0] === 'months' && seg.length === 2) {
    const data = monthPayload(Number(seg[1]));
    if (!data) throw new HttpError(404, 'Mesec ne postoji.');
    return data;
  }

  if (method === 'PATCH' && seg[0] === 'months' && seg.length === 2) {
    q.setNote.run(str(body.note), Number(seg[1]));
    return { month: q.month.get(Number(seg[1])) };
  }

  if (method === 'DELETE' && seg[0] === 'months' && seg.length === 2) {
    q.delMonth.run(Number(seg[1]));
    return { ok: true };
  }

  // ---- unosi ----
  if (method === 'POST' && seg[0] === 'entries' && seg.length === 1) {
    const e = validateEntry(body);
    if (!q.month.get(e.month_id)) throw new HttpError(400, 'Mesec ne postoji.');
    const info = q.addEntry.run(e.month_id, e.kind, e.amount, e.category, e.description, e.date);
    return { id: Number(info.lastInsertRowid), ...monthPayload(e.month_id) };
  }

  if (method === 'PUT' && seg[0] === 'entries' && seg.length === 2) {
    const e = validateEntry(body);
    q.updEntry.run(e.kind, e.amount, e.category, e.description, e.date, Number(seg[1]));
    return monthPayload(e.month_id);
  }

  if (method === 'DELETE' && seg[0] === 'entries' && seg.length === 2) {
    const monthId = num(body.month_id);
    q.delEntry.run(Number(seg[1]));
    return Number.isFinite(monthId) ? monthPayload(monthId) : { ok: true };
  }

  // ---- ostalo ----
  if (method === 'GET' && seg[0] === 'overview') return overviewPayload();

  if (method === 'GET' && seg[0] === 'categories') {
    return {
      trosak: q.knownCats.all('trosak').map((r) => r.category),
      prihod: q.knownCats.all('prihod').map((r) => r.category),
      stek: q.knownCats.all('stek').map((r) => r.category),
    };
  }

  if (method === 'GET' && seg[0] === 'settings') {
    return Object.fromEntries(q.settings.all().map((r) => [r.key, r.value]));
  }

  if (method === 'PUT' && seg[0] === 'settings') {
    for (const [k, v] of Object.entries(body || {})) q.setSetting.run(String(k), String(v));
    return Object.fromEntries(q.settings.all().map((r) => [r.key, r.value]));
  }

  if (method === 'GET' && seg[0] === 'ping') {
    lastSeen = Date.now();
    return { ok: true };
  }

  if (method === 'GET' && seg[0] === 'export') {
    return {
      exported_at: new Date().toISOString(),
      months: q.months.all().map((m) => ({ ...m, entries: q.entries.all(m.id) })),
    };
  }

  throw new HttpError(404, 'Nepoznata ruta.');
}

/* ------------------------------------------------------------- watchdog --- */
/* Prozor aplikacije se javlja svakih ~25s. Kad prestane (zatvoren je),
   server se sam gasi da ne visi u memoriji do restarta racunara.          */

let lastSeen = 0;
const IDLE_MS = 90_000;

function armWatchdog() {
  setInterval(() => {
    if (lastSeen && Date.now() - lastSeen > IDLE_MS) {
      console.log('Nema otvorenog prozora - server se gasi.');
      process.exit(0);
    }
  }, 30_000).unref();
}

/* --------------------------------------------------------------- server --- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Server je namenjen samo ovoj masini.
  const remote = req.socket.remoteAddress || '';
  if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
    res.writeHead(403).end('Samo lokalni pristup.');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const seg = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
        if (handleAuth(req, res, seg, body)) return;
        const out = api(req.method, seg, body);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || 'Greska na serveru.' }));
      }
    });
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Nije pronadjeno');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

function openBrowser(port) {
  const url = `http://localhost:${port}/`;
  const browser = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => fs.existsSync(p));

  if (browser) {
    spawn(browser, [
      `--app=${url}`,
      `--user-data-dir=${path.join(ROOT, 'data', 'browser-profile')}`,
      '--window-size=1440,940',
      '--lang=sr',            // da i birac datuma bude u nasem formatu
      '--no-first-run',
      '--no-default-browser-check',
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Aplikacija je vec pokrenuta - samo otvori novi prozor.
    if (OPEN_BROWSER) openBrowser(PORT);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Finansije: http://localhost:${PORT}   baza: ${DB_PATH}`);
  armWatchdog();
  if (OPEN_BROWSER) openBrowser(PORT);
});
