import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT       = process.env.PORT || 3000;
const DB_PATH    = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const MODEL      = process.env.MODEL || 'claude-sonnet-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1500);
const API_KEY    = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) console.warn('⚠  ANTHROPIC_API_KEY is not set — draft generation will fail.');

/* ── database ─────────────────────────────────────────── */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
);
CREATE TABLE IF NOT EXISTS usage_log(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  name       TEXT,
  role       TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);
`);

// Owner account — this becomes the app's OWNER (there is exactly one).
// The owner role sits above admin: nobody, including other admins, can
// modify or disable the owner's own login (see requireAdmin + the
// owner-guard in PATCH /api/users/:id below). The owner can only change
// their own credentials via /api/password, the same self-service path
// everyone else uses.
//
// This looks up the ADMIN_USER account specifically (rather than only
// seeding when the whole users table is empty) so it also works as a
// recovery path on a database that already has rows. Set FORCE_ADMIN_RESET=true
// to force the ADMIN_USER account's password back to ADMIN_PASS and its role
// to 'owner' on next boot — remove that env var again afterward so future
// deploys don't keep stomping on a password the owner has since changed.
{
  const u = process.env.ADMIN_USER || 'admin';
  const p = process.env.ADMIN_PASS || 'changeme123';
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(u);
  if (!existing) {
    db.prepare(`INSERT INTO users(username,name,password_hash,role,created_at)
                VALUES(?,?,?,?,?)`)
      .run(u, process.env.ADMIN_NAME || 'Administrator',
           bcrypt.hashSync(p, 10), 'owner', new Date().toISOString());
    console.log(`✓ Created owner account "${u}" — sign in and change the password.`);
  } else if (process.env.FORCE_ADMIN_RESET === 'true') {
    db.prepare('UPDATE users SET password_hash=?, role=?, active=1 WHERE id=?')
      .run(bcrypt.hashSync(p, 10), 'owner', existing.id);
    console.log(`✓ FORCE_ADMIN_RESET: reset "${u}"'s password to ADMIN_PASS and promoted to owner.`);
  }
}

function logActivity({ username, name, role, action, detail }) {
  try {
    db.prepare(`INSERT INTO activity_log(username,name,role,action,detail,created_at)
                VALUES(?,?,?,?,?,?)`)
      .run(username || null, name || null, role || null, action,
           detail ? String(detail).slice(0, 300) : null, new Date().toISOString());
  } catch { /* never let logging break the request */ }
}

/* ── app ──────────────────────────────────────────────── */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  }
}));

const requireAuth  = (req, res, next) =>
  req.session.uid ? next() : res.status(401).json({ error: 'Not signed in' });
// admin-level access = 'admin' or 'owner' (owner is a superset of admin)
const isAdminRole  = role => role === 'admin' || role === 'owner';
const requireAdmin = (req, res, next) =>
  isAdminRole(req.session.role) ? next() : res.status(403).json({ error: 'Admin only' });
// owner-only actions — e.g. resetting any account back to a default password
const requireOwner = (req, res, next) =>
  req.session.role === 'owner' ? next() : res.status(403).json({ error: 'Owner only' });

/* ── auth ─────────────────────────────────────────────── */
const attempts = new Map();

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const k = username.toLowerCase().trim();
  const a = attempts.get(k) || { n: 0, until: 0 };
  if (a.until > Date.now())
    return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });

  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(k);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    a.n++;
    if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(k, a);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  attempts.delete(k);
  req.session.uid = u.id;
  req.session.username = u.username;
  req.session.name = u.name;
  req.session.role = u.role;
  logActivity({ username: u.username, name: u.name, role: u.role, action: 'login' });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireAuth, (req, res) =>
  res.json({ username: req.session.username, name: req.session.name, role: req.session.role }));

app.post('/api/password', requireAuth, (req, res) => {
  const { current = '', next = '' } = req.body || {};
  if (next.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid);
  if (!bcrypt.compareSync(current, u.password_hash))
    return res.status(401).json({ error: 'Current password is wrong' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(next, 10), u.id);
  res.json({ ok: true });
});

/* ── key/value store ──────────────────────────────────── */
// shared=true  → one global copy (store policies)
// shared=false → private to the signed-in agent (case log)
const scopeOf = (req, shared) => (shared ? 'shared' : 'u' + req.session.uid);
const isShared = v => v === true || v === 'true';

app.get('/api/kv', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key FROM kv WHERE scope=? AND key LIKE ?')
    .all(scopeOf(req, isShared(req.query.shared)), (req.query.prefix || '') + '%');
  res.json({ keys: rows.map(r => r.key) });
});

app.get('/api/kv/:key', requireAuth, (req, res) => {
  const row = db.prepare('SELECT value FROM kv WHERE scope=? AND key=?')
    .get(scopeOf(req, isShared(req.query.shared)), req.params.key);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ value: row.value });
});

app.put('/api/kv/:key', requireAuth, (req, res) => {
  const shared = isShared(req.body?.shared);
  // shared data (store policies) can be added/edited by admins and the
  // owner; agents get a read-only view.
  if (shared && !isAdminRole(req.session.role))
    return res.status(403).json({ error: 'Only admins can edit store policies' });
  const value = String(req.body?.value ?? '');
  if (value.length > 2_000_000) return res.status(413).json({ error: 'Too large' });
  db.prepare(`INSERT INTO kv(scope,key,value,updated_at) VALUES(?,?,?,?)
              ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(scopeOf(req, shared), req.params.key, value, new Date().toISOString());
  res.json({ ok: true });
});

app.delete('/api/kv/:key', requireAuth, (req, res) => {
  const shared = isShared(req.query.shared);
  if (shared && !isAdminRole(req.session.role))
    return res.status(403).json({ error: 'Only admins can edit store policies' });
  db.prepare('DELETE FROM kv WHERE scope=? AND key=?')
    .run(scopeOf(req, shared), req.params.key);
  res.json({ ok: true });
});

/* ── activity log (agent history dashboard) ──────────────
   The client logs meaningful actions here (policy add/edit, case
   add/delete, copying a drafted reply). Login and draft-generation
   events are logged server-side above/below since those are single,
   unambiguous server events. */
const CLIENT_ACTIONS = new Set([
  'draft_copied',
  'policy_added', 'policy_edited', 'policy_deleted',
  'case_added', 'case_deleted'
]);

app.post('/api/activity', requireAuth, (req, res) => {
  const { action = '', detail = '' } = req.body || {};
  if (!CLIENT_ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });
  if (action.startsWith('policy_') && !isAdminRole(req.session.role))
    return res.status(403).json({ error: 'Admin only' });
  logActivity({
    username: req.session.username, name: req.session.name, role: req.session.role,
    action, detail
  });
  res.json({ ok: true });
});

app.get('/api/activity', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json(db.prepare(
    'SELECT id, username, name, role, action, detail, created_at FROM activity_log ORDER BY id DESC LIMIT ?'
  ).all(limit));
});

/* ── Claude proxy ─────────────────────────────────────── */
app.post('/api/generate', requireAuth, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'Server has no API key configured' });
  try {
    const body = {
      model: MODEL,                                     // server decides the model
      max_tokens: Math.min(Number(req.body?.max_tokens) || 1000, MAX_TOKENS),
      system: String(req.body?.system || '').slice(0, 60000),
      messages: Array.isArray(req.body?.messages) ? req.body.messages.slice(0, 4) : []
    };
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (r.ok && data.usage) {
      db.prepare(`INSERT INTO usage_log(username,input_tokens,output_tokens,created_at)
                  VALUES(?,?,?,?)`)
        .run(req.session.username, data.usage.input_tokens || 0,
             data.usage.output_tokens || 0, new Date().toISOString());
      logActivity({
        username: req.session.username, name: req.session.name, role: req.session.role,
        action: 'draft_generated'
      });
    }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream failure: ' + e.message });
  }
});

/* ── admin ────────────────────────────────────────────── */
app.get('/api/users', requireAdmin, (_req, res) =>
  res.json(db.prepare('SELECT id,username,name,role,active,created_at FROM users ORDER BY id').all()));

app.post('/api/users', requireAdmin, (req, res) => {
  const { username = '', name = '', password = '', role = 'agent' } = req.body || {};
  const u = username.toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) return res.status(400).json({ error: 'Username: 3-32 chars, letters/numbers/._-' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
  if (!name.trim()) return res.status(400).json({ error: 'Full name required' });
  // 'owner' can never be granted through this endpoint — there is exactly
  // one owner, set only at first boot from ADMIN_USER/ADMIN_PASS.
  try {
    db.prepare(`INSERT INTO users(username,name,password_hash,role,created_at) VALUES(?,?,?,?,?)`)
      .run(u, name.trim(), bcrypt.hashSync(password, 10),
           role === 'admin' ? 'admin' : 'agent', new Date().toISOString());
    res.json({ ok: true });
  } catch { res.status(409).json({ error: 'That username already exists' }); }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.uid) return res.status(400).json({ error: "You can't modify your own account here" });
  const target = db.prepare('SELECT id, role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });
  // Owner protection: nobody — not even another admin — can change or
  // disable the owner's login through this endpoint. Only the owner can
  // change their own credentials, and only via the self-service
  // /api/password route (which requires their current password).
  if (target.role === 'owner') return res.status(403).json({ error: "The owner's login can only be changed by the owner" });
  if (req.body?.password) {
    if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(req.body.password, 10), id);
  }
  if (req.body?.active !== undefined)
    db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active ? 1 : 0, id);
  res.json({ ok: true });
});

// Owner-only: reset any account (admin or agent) back to a fresh
// system-generated password — a simpler recovery path than PATCH's
// "choose a new password" flow. Regular admins cannot call this.
app.post('/api/users/:id/reset-default', requireOwner, (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT id, username, role FROM users WHERE id=?').get(id);
  if (!target) return res.status(404).json({ error: 'No such user' });
  const newPassword = randomBytes(9).toString('base64url'); // 12-char URL-safe random password
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), id);
  logActivity({
    username: req.session.username, name: req.session.name, role: req.session.role,
    action: 'account_reset', detail: target.username
  });
  res.json({ ok: true, username: target.username, newPassword });
});

// Admin/owner oversight view: every agent's saved cases, read-only.
// Cases are stored per-agent as a single JSON blob under kv key "cases"
// in that agent's private scope ("u"+userId) — gather them all here.
app.get('/api/admin/cases', requireAdmin, (_req, res) => {
  const rows = db.prepare("SELECT scope, value FROM kv WHERE key='cases' AND scope LIKE 'u%'").all();
  const users = new Map(db.prepare('SELECT id, username, name FROM users').all().map(u => [u.id, u]));
  const out = [];
  for (const row of rows) {
    const uid = Number(row.scope.slice(1));
    const u = users.get(uid);
    let cases = [];
    try { cases = JSON.parse(row.value) || []; } catch { cases = []; }
    out.push({
      userId: uid,
      username: u ? u.username : '(deleted user)',
      name: u ? u.name : '(deleted user)',
      cases
    });
  }
  res.json(out);
});

app.get('/api/usage', requireAdmin, (_req, res) => {
  res.json(db.prepare(`
    SELECT username,
           COUNT(*) drafts,
           SUM(input_tokens)  input_tokens,
           SUM(output_tokens) output_tokens,
           MAX(created_at)    last_used
    FROM usage_log GROUP BY username ORDER BY drafts DESC`).all());
});

/* ── pages ────────────────────────────────────────────── */
const page = f => path.join(__dirname, 'public', f);
app.get('/login', (_req, res) => res.sendFile(page('login.html')));
app.get('/', (req, res) => req.session.uid ? res.sendFile(page('index.html')) : res.redirect('/login'));
app.get('/admin', (req, res) =>
  isAdminRole(req.session.role) ? res.sendFile(page('admin.html')) : res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.listen(PORT, () => console.log(`Reply Desk running on port ${PORT}`));
