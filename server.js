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
//  PHP API BRIDGE  (fetch replaces lowdb)
// ─────────────────────────────────────────────
async function phpApi(params) {
  const url = new URL(PHP_API_URL);
  url.searchParams.set('key', PHP_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch (e) { return { error: 'PHP returned non-JSON: ' + text.slice(0, 200) }; }
}

// ─────────────────────────────────────────────
//  KEEP-ALIVE  — pings self every 10 min so
//  Render free tier never sleeps
// ─────────────────────────────────────────────
setInterval(async () => {
  try {
    await fetch(SELF_URL + '/ping', { signal: AbortSignal.timeout(8000) });
    console.log('[keep-alive] ping ok', new Date().toISOString());
  } catch (e) {
    console.log('[keep-alive] ping failed:', e.message);
  }
}, 10 * 60 * 1000); // every 10 minutes

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
//  PING  (keep-alive + health check)
// ─────────────────────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════
//  ANDROID APP API
//  Android SMS Gateway App v7 calls this endpoint
// ═══════════════════════════════════════════════

// GET /sms_gateway.php?key=0241&action=pending
// GET /sms_gateway.php?key=0241&action=update&id=5&status=sent
// POST with no action → treated as pending
app.all('/sms_gateway.php', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Read key from GET, POST body, or header
  const key = req.query.key || req.body?.key || req.headers['x-api-key'] || '';
  if (key !== SECRET_KEY) {
    return res.status(401).json({ status: 'error', message: 'Invalid secret key' });
  }

  const action = (req.query.action || req.body?.action || 'pending').trim();

  // ── GET PENDING SMS from PHP/MySQL ─────────
  if (action === 'pending') {
    try {
      const data = await phpApi({ action: 'pending' });
      if (data.error) {
        return res.json({ status: 'error', message: data.error, messages: [] });
      }
      // PHP returns { sms: [{id, phone, message}] }
      // Android App v7 expects { status:'ok', messages:[{id, to, text}] }
      const messages = (data.sms || data.messages || []).map(m => ({
        id:   String(m.id),
        to:   m.phone || m.to || '',
        text: m.message || m.text || ''
      }));
      return res.json({ status: 'ok', messages });
    } catch (e) {
      return res.json({ status: 'error', message: e.message, messages: [] });
    }
  }

  // ── UPDATE STATUS (sent / failed) ──────────
  if (action === 'update') {
    const id     = req.query.id     || req.body?.id     || '';
    const status = req.query.status || req.body?.status || 'sent';
    const reason = req.query.reason || req.body?.reason || '';

    if (!id) return res.json({ status: 'error', message: 'Missing id' });

    try {
      let phpAction = status === 'failed' ? 'mark_failed' : 'mark_sent';
      const params  = { action: phpAction, id };
      if (status === 'failed' && reason) params.reason = reason;

      const data = await phpApi(params);
      return res.json({ status: 'ok', updated: id, php: data });
    } catch (e) {
      return res.json({ status: 'error', message: e.message });
    }
  }

  return res.json({ status: 'error', message: 'Unknown action' });
});

// ═══════════════════════════════════════════════
//  WEB DASHBOARD API
// ═══════════════════════════════════════════════

// Login
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  res.json(password === LOGIN_PASS
    ? { status: 'ok' }
    : { status: 'error', message: 'Wrong password' });
});

// Stats — reads from PHP/MySQL
app.get('/api/stats', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error', message: 'Unauthorized' });
  try {
    const data = await phpApi({ action: 'stats' });
    if (data.error) return res.json({ status: 'error', message: data.error });
    const s = data.stats || {};
    res.json({
      status:  'ok',
      total:   (s.pending || 0) + (s.sent || 0) + (s.failed || 0),
      pending: s.pending || 0,
      sent:    s.sent    || 0,
      failed:  s.failed  || 0
    });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Send — queues in PHP/MySQL
app.post('/api/send', async (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message)  return res.json({ status: 'error', message: 'Fill all fields' });
  try {
    const data = await phpApi({ action: 'send', phone, message });
    if (data.error) return res.json({ status: 'error', message: data.error });
    res.json({ status: 'ok', id: data.id });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// History — reads sent/failed log from PHP/MySQL
app.get('/api/history', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error', message: 'Unauthorized' });
  const filter = req.query.filter || 'all';
  const page   = parseInt(req.query.page || 1);
  const limit  = 20;

  try {
    // Fetch all from PHP log (sent+failed) + pending separately
    let rows = [];

    if (filter === 'pending' || filter === 'all') {
      const pd = await phpApi({ action: 'pending' });
      const pendingRows = (pd.sms || []).map(m => ({
        id:       m.id,
        phone_to: m.phone,
        message:  m.message,
        status:   'pending',
        created:  m.created_at || '',
        sent_at:  null
      }));
      rows = rows.concat(pendingRows);
    }

    if (filter !== 'pending') {
      const logLimit = 500;
      const ld = await phpApi({ action: 'log', limit: logLimit });
      let logRows = (ld.log || []).map(m => ({
        id:       m.id,
        phone_to: m.phone,
        message:  m.message,
        status:   m.status,
        created:  m.created_at || '',
        sent_at:  m.sent_at || ''
      }));
      if (filter !== 'all') logRows = logRows.filter(m => m.status === filter);
      rows = rows.concat(logRows);
    }

    // Sort by id descending (newest first)
    rows.sort((a, b) => b.id - a.id);

    const total = rows.length;
    const paged = rows.slice((page - 1) * limit, page * limit);
    res.json({ status: 'ok', messages: paged, total });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Edit — update a pending record in PHP/MySQL
app.post('/api/edit', async (req, res) => {
  const { key, id, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!id || !phone || !message) return res.json({ status: 'error', message: 'Fill all fields' });

  try {
    // Delete the old record and re-insert (PHP API has no edit, but has send+delete)
    await phpApi({ action: 'delete', id });
    const data = await phpApi({ action: 'send', phone, message });
    if (data.error) return res.json({ status: 'error', message: data.error });
    res.json({ status: 'ok' });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// Delete
app.get('/api/delete', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error', message: 'Unauthorized' });
  const id = req.query.id || '';
  try {
    const data = await phpApi({ action: 'delete', id });
    res.json({ status: 'ok', deleted: data.deleted || 0 });
  } catch (e) {
    res.json({ status: 'error', message: e.message });
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SMS Gateway Bridge running on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
  console.log(`Keep-alive target: ${SELF_URL}`);
});
