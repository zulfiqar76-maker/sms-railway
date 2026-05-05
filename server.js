const express = require('express');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const SECRET_KEY  = process.env.SECRET_KEY  || '0241';
const LOGIN_PASS  = process.env.LOGIN_PASS  || 'admin123';
const PORT        = process.env.PORT        || 3000;
const PHP_API_URL = process.env.PHP_API_URL || 'https://lld.zf3r.com/sms_queue_api.php';
const PHP_API_KEY = process.env.PHP_API_KEY || '0241';
const SELF_URL    = process.env.SELF_URL    || 'https://sms-railway.onrender.com';

// ─────────────────────────────────────────────
//  IN-MEMORY STORE
// ─────────────────────────────────────────────
let store = {
  pending : [],
  sent    : [],
  failed  : [],
  lastSync: null
};

// ─────────────────────────────────────────────
//  PHP FETCHER — strips HTML wrapper hosting injects
// ─────────────────────────────────────────────
async function phpFetch(params) {
  const url = new URL(PHP_API_URL);
  url.searchParams.set('key', PHP_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
  const raw  = await res.text();

  // Strip HTML wrapper — find first { or [
  const start = raw.search(/[{\[]/);
  if (start === -1) throw new Error('No JSON in PHP response: ' + raw.slice(0, 100));
  const end  = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']')) + 1;
  return JSON.parse(raw.slice(start, end));
}

// ─────────────────────────────────────────────
//  SYNC FROM PHP → MEMORY
//  Called every time Android app polls
// ─────────────────────────────────────────────
async function syncFromPHP() {
  try {
    const pd = await phpFetch({ action: 'pending' });
    store.pending = (pd.sms || pd.messages || []).map(m => ({
      id      : parseInt(m.id),
      phone_to: m.phone || m.to || '',
      message : m.message || m.text || '',
      created : m.created_at || new Date().toISOString()
    }));

    const lg = await phpFetch({ action: 'log', limit: 200 });
    store.sent   = [];
    store.failed = [];
    for (const m of (lg.log || [])) {
      const row = {
        id         : parseInt(m.id),
        phone_to   : m.phone,
        message    : m.message,
        created    : m.created_at || '',
        sent_at    : m.sent_at    || '',
        fail_reason: m.fail_reason || ''
      };
      if (m.status === 'sent')   store.sent.push(row);
      if (m.status === 'failed') store.failed.push(row);
    }

    store.lastSync = new Date().toISOString();
    console.log(`[sync] OK pending:${store.pending.length} sent:${store.sent.length} failed:${store.failed.length}`);
    return true;
  } catch (e) {
    console.error('[sync] FAILED:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
//  PUSH STATUS TO PHP/MySQL (background)
// ─────────────────────────────────────────────
async function pushStatus(id, status, reason) {
  try {
    const action = status === 'failed' ? 'mark_failed' : 'mark_sent';
    const params = { action, id };
    if (reason) params.reason = reason;
    await phpFetch(params);
    console.log(`[push] id=${id} status=${status}`);
  } catch (e) {
    console.error('[push] FAILED:', e.message);
  }
}

// ─────────────────────────────────────────────
//  KEEP-ALIVE — ping self every 10 min
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch(SELF_URL + '/ping', { signal: AbortSignal.timeout(8000) });
    console.log('[keep-alive] ok', new Date().toISOString());
  } catch (e) {
    console.log('[keep-alive] failed:', e.message);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────
//  CORS
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static('public'));

// ─────────────────────────────────────────────
//  PING
// ─────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), lastSync: store.lastSync });
});

// ═══════════════════════════════════════════════
//  ANDROID APP ENDPOINT
// ═══════════════════════════════════════════════
app.all('/sms_gateway.php', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const key = req.query.key || req.body?.key || req.headers['x-api-key'] || '';
  if (key !== SECRET_KEY)
    return res.status(401).json({ status: 'error', message: 'Invalid secret key' });

  const action = (req.query.action || req.body?.action || 'pending').trim();

  // PENDING — sync fresh from PHP, serve clean JSON to app
  if (action === 'pending') {
    await syncFromPHP();
    const messages = store.pending.map(m => ({
      id  : String(m.id),
      to  : m.phone_to,
      text: m.message
    }));
    return res.json({ status: 'ok', messages });
  }

  // UPDATE — move in memory + push to PHP
  if (action === 'update') {
    const id     = String(req.query.id     || req.body?.id     || '');
    const status = String(req.query.status || req.body?.status || 'sent');
    const reason = String(req.query.reason || req.body?.reason || '');
    if (!id) return res.json({ status: 'error', message: 'Missing id' });

    const numId = parseInt(id);
    const idx   = store.pending.findIndex(m => m.id === numId);
    if (idx !== -1) {
      const [m] = store.pending.splice(idx, 1);
      const row = { ...m, sent_at: new Date().toISOString(), fail_reason: reason };
      if (status === 'failed') store.failed.unshift(row);
      else                     store.sent.unshift(row);
    }
    pushStatus(id, status, reason); // fire and forget
    return res.json({ status: 'ok', updated: id });
  }

  return res.json({ status: 'error', message: 'Unknown action' });
});

// ═══════════════════════════════════════════════
//  WEB DASHBOARD API
// ═══════════════════════════════════════════════

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  res.json(password === LOGIN_PASS
    ? { status: 'ok' }
    : { status: 'error', message: 'Wrong password' });
});

app.get('/api/stats', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  res.json({
    status : 'ok',
    total  : store.pending.length + store.sent.length + store.failed.length,
    pending: store.pending.length,
    sent   : store.sent.length,
    failed : store.failed.length
  });
});

app.post('/api/send', async (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message)  return res.json({ status: 'error', message: 'Fill all fields' });
  try {
    const data = await phpFetch({ action: 'send', phone, message });
    if (data.error) return res.json({ status: 'error', message: data.error });
    store.pending.push({ id: parseInt(data.id), phone_to: phone, message, created: new Date().toISOString() });
    res.json({ status: 'ok', id: data.id });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

app.get('/api/history', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const filter = req.query.filter || 'all';
  const page   = parseInt(req.query.page || 1);
  const limit  = 20;

  let rows = [];
  if (filter === 'all' || filter === 'pending') rows = rows.concat(store.pending.map(m => ({ ...m, status: 'pending' })));
  if (filter === 'all' || filter === 'sent')    rows = rows.concat(store.sent.map(m => ({ ...m, status: 'sent' })));
  if (filter === 'all' || filter === 'failed')  rows = rows.concat(store.failed.map(m => ({ ...m, status: 'failed' })));

  rows.sort((a, b) => b.id - a.id);
  res.json({ status: 'ok', messages: rows.slice((page - 1) * limit, page * limit), total: rows.length });
});

app.post('/api/edit', async (req, res) => {
  const { key, id, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!id || !phone || !message) return res.json({ status: 'error', message: 'Fill all fields' });
  try {
    await phpFetch({ action: 'delete', id });
    const data = await phpFetch({ action: 'send', phone, message });
    const idx  = store.pending.findIndex(m => m.id === parseInt(id));
    if (idx !== -1) store.pending[idx] = { id: parseInt(data.id), phone_to: phone, message, created: new Date().toISOString() };
    res.json({ status: 'ok' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

app.get('/api/delete', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const id = req.query.id || '';
  try {
    await phpFetch({ action: 'delete', id });
    if      (id === 'all')    { store.pending = []; store.sent = []; store.failed = []; }
    else if (id === 'sent')   { store.sent    = []; }
    else if (id === 'failed') { store.failed  = []; }
    else {
      const n = parseInt(id);
      store.pending = store.pending.filter(m => m.id !== n);
      store.sent    = store.sent.filter(m => m.id !== n);
      store.failed  = store.failed.filter(m => m.id !== n);
    }
    res.json({ status: 'ok' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`SMS Gateway Bridge v3 on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
  await syncFromPHP();
});
