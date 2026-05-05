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
const PHP_API_URL = process.env.PHP_API_URL || 'http://lld.zf3r.com/sms_queue_api.php';
const PHP_API_KEY = process.env.PHP_API_KEY || '0241';
const SELF_URL    = process.env.SELF_URL    || 'https://sms-railway.onrender.com';

// ─────────────────────────────────────────────
//  IN-MEMORY STORE
// ─────────────────────────────────────────────
let store = {
  pending  : [],
  sent     : [],
  failed   : [],
  lastSync : null,
  lastError: null
};

// ─────────────────────────────────────────────
//  PHP FETCHER
//  Handles HTML wrapper + broken JSON from hosting
// ─────────────────────────────────────────────
async function phpFetch(params) {
  const url = new URL(PHP_API_URL);
  url.searchParams.set('key', PHP_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  console.log('[phpFetch]', url.toString());

  const res = await fetch(url.toString(), {
    signal : AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'SMSBridge/3.0', 'Accept': '*/*' }
  });

  const raw = await res.text();
  console.log('[phpFetch] raw (300):', raw.slice(0, 300));

  // 1. Strip any HTML the host injects before/after JSON
  const start = raw.search(/[{\[]/);
  if (start === -1) throw new Error('No JSON found: ' + raw.slice(0, 150));
  const end   = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']')) + 1;
  let jsonStr  = raw.slice(start, end);

  // 2. Fix unescaped literal newlines/tabs inside JSON string values
  //    Walk char by char — only replace \n \r \t that are inside quotes
  jsonStr = fixJsonString(jsonStr);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('[phpFetch] parse error:', e.message);
    console.error('[phpFetch] jsonStr (300):', jsonStr.slice(0, 300));
    throw new Error('JSON parse failed: ' + e.message);
  }
}

// Fix unescaped control characters inside JSON string values
function fixJsonString(str) {
  let result  = '';
  let inStr   = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      result  += ch;
      escaped  = false;
      continue;
    }

    if (ch === '\\') {
      result  += ch;
      escaped  = true;
      continue;
    }

    if (ch === '"') {
      inStr  = !inStr;
      result += ch;
      continue;
    }

    if (inStr) {
      // Replace unescaped control chars inside strings
      if      (ch === '\n') { result += '\\n';  continue; }
      else if (ch === '\r') { result += '\\r';  continue; }
      else if (ch === '\t') { result += '\\t';  continue; }
      else if (ch.charCodeAt(0) < 32) { continue; } // drop other control chars
    }

    result += ch;
  }
  return result;
}

// ─────────────────────────────────────────────
//  SYNC PHP → MEMORY
// ─────────────────────────────────────────────
async function syncFromPHP() {
  try {
    console.log('[sync] starting...');

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

    store.lastSync  = new Date().toISOString();
    store.lastError = null;
    console.log(`[sync] OK — pending:${store.pending.length} sent:${store.sent.length} failed:${store.failed.length}`);
    return true;
  } catch (e) {
    store.lastError = e.message;
    console.error('[sync] FAILED:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
//  PUSH STATUS BACK TO PHP
// ─────────────────────────────────────────────
async function pushStatus(id, status, reason) {
  try {
    const action = status === 'failed' ? 'mark_failed' : 'mark_sent';
    const params = { action, id };
    if (reason) params.reason = reason;
    await phpFetch(params);
    console.log(`[push] id=${id} marked ${status}`);
  } catch (e) {
    console.error('[push] FAILED:', e.message);
  }
}

// ─────────────────────────────────────────────
//  KEEP-ALIVE every 10 min
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
  res.json({
    status    : 'ok',
    time      : new Date().toISOString(),
    lastSync  : store.lastSync,
    lastError : store.lastError,
    counts    : { pending: store.pending.length, sent: store.sent.length, failed: store.failed.length }
  });
});

// Manual sync trigger
app.get('/sync', async (req, res) => {
  const ok = await syncFromPHP();
  res.json({
    status    : ok ? 'ok' : 'error',
    lastSync  : store.lastSync,
    lastError : store.lastError,
    counts    : { pending: store.pending.length, sent: store.sent.length, failed: store.failed.length }
  });
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

  if (action === 'pending') {
    await syncFromPHP();
    const messages = store.pending.map(m => ({
      id  : String(m.id),
      to  : m.phone_to,
      text: m.message
    }));
    return res.json({ status: 'ok', messages });
  }

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
    pushStatus(id, status, reason);
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
  console.log(`SMS Gateway Bridge v4 on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
  for (let i = 1; i <= 3; i++) {
    console.log(`[startup] sync attempt ${i}...`);
    const ok = await syncFromPHP();
    if (ok) break;
    await new Promise(r => setTimeout(r, 3000));
  }
});
