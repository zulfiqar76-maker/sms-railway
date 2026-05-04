const express = require('express');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const SECRET_KEY  = process.env.SECRET_KEY  || '0241';
const LOGIN_PASS  = process.env.LOGIN_PASS  || 'admin123';
const PORT        = process.env.PORT        || 3000;
const PHP_API_URL = process.env.PHP_API_URL || 'https://lld.zf3r.com/sms_queue_api.php';
const PHP_API_KEY = process.env.PHP_API_KEY || '0241';

// ─────────────────────────────────────────────
//  PHP API HELPER
//  Mimics a real browser so shared hosting doesn't block the request
// ─────────────────────────────────────────────
async function phpApi(action, extra = {}) {
  const params = new URLSearchParams({ key: PHP_API_KEY, action, ...extra });
  const url    = `${PHP_API_URL}?${params}`;

  const res = await fetch(url, {
    method : 'GET',
    headers: {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept'         : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer'        : 'https://lld.zf3r.com/',
      'Origin'         : 'https://lld.zf3r.com',
    },
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();

  // If response is HTML (hosting returned error page), throw clear error
  if (text.trim().startsWith('<')) {
    console.error(`PHP API returned HTML for action=${action}:`, text.substring(0, 300));
    throw new Error('PHP API returned HTML instead of JSON — hosting may be blocking the request');
  }

  return JSON.parse(text);
}

// POST version for send action
async function phpApiPost(body) {
  const res = await fetch(PHP_API_URL, {
    method : 'POST',
    headers: {
      'Content-Type'   : 'application/json',
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept'         : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer'        : 'https://lld.zf3r.com/',
      'Origin'         : 'https://lld.zf3r.com',
    },
    body  : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  if (text.trim().startsWith('<')) {
    console.error('PHP API POST returned HTML:', text.substring(0, 300));
    throw new Error('PHP API returned HTML instead of JSON');
  }
  return JSON.parse(text);
}

// ─────────────────────────────────────────────
//  CORS
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// ═══════════════════════════════════════════════════════════════
//  ANDROID APP  —  /sms_gateway.php
//  action=pending  → fetch pending SMS from PHP → send to app
//  action=update   → mark SMS sent/failed via PHP
// ═══════════════════════════════════════════════════════════════
async function handleGateway(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const key    = req.query.key    || req.body?.key    || '';
  const action = req.query.action || req.body?.action || 'pending';

  if (key !== SECRET_KEY) {
    return res.json({ status: 'error', message: 'Invalid secret key' });
  }

  try {
    // ── fetch pending ──
    if (action === 'pending') {
      const data = await phpApi('pending');
      if (data.status !== 'ok') {
        return res.json({ status: 'error', message: data.error || 'PHP API error' });
      }
      // PHP returns { sms:[{id,phone,message}] }
      // Android app v7 expects { messages:[{id,to,text}] }
      const messages = (data.sms || []).map(r => ({
        id  : String(r.id),
        to  : r.phone,
        text: r.message,
      }));
      return res.json({ status: 'ok', messages });
    }

    // ── update status ──
    if (action === 'update') {
      const id     = req.query.id     || req.body?.id     || '';
      const status = req.query.status || req.body?.status || 'sent';
      const reason = req.query.reason || req.body?.reason || '';

      if (!id) return res.json({ status: 'error', message: 'Missing id' });

      const phpAction = status === 'failed' ? 'mark_failed' : 'mark_sent';
      const extra     = status === 'failed' ? { id, reason } : { id };
      const data      = await phpApi(phpAction, extra);
      return res.json({ status: 'ok', updated: id, php: data });
    }

    return res.json({ status: 'error', message: 'Unknown action' });

  } catch (err) {
    console.error('Gateway error:', err.message);
    return res.json({ status: 'error', message: err.message });
  }
}

app.get('/sms_gateway.php',  handleGateway);
app.post('/sms_gateway.php', handleGateway);

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD API
// ═══════════════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  res.json(password === LOGIN_PASS
    ? { status: 'ok' }
    : { status: 'error', message: 'Wrong password' });
});

app.get('/api/stats', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try {
    const data = await phpApi('stats');
    const s = data.stats || {};
    res.json({ status: 'ok', ...s, total: (s.pending||0)+(s.sent||0)+(s.failed||0) });
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.post('/api/send', async (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message)  return res.json({ status: 'error', message: 'Fill all fields' });
  try {
    const data = await phpApiPost({ key: PHP_API_KEY, action: 'send', phone, message });
    res.json(data);
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.get('/api/history', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try {
    const data = await phpApi('log', { limit: 100 });
    res.json({ status: 'ok', messages: (data.log || []).map(r => ({
      id: r.id, phone_to: r.phone, message: r.message,
      status: r.status, fail_reason: r.fail_reason,
      created_at: r.created_at, sent_at: r.sent_at,
    })), total: data.count || 0 });
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.get('/api/delete', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try {
    res.json(await phpApi('delete', { id: req.query.id || 'all' }));
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

// ── Health check — also shows raw PHP response for debugging ──
app.get('/health', async (req, res) => {
  try {
    const data = await phpApi('ping');
    res.json({ status: 'ok', php_api: data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── Debug endpoint — shows raw text from PHP API ──
app.get('/debug', async (req, res) => {
  try {
    const params = new URLSearchParams({ key: PHP_API_KEY, action: 'ping' });
    const response = await fetch(`${PHP_API_URL}?${params}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept'    : 'application/json, */*',
        'Referer'   : 'https://lld.zf3r.com/',
      },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    res.setHeader('Content-Type', 'text/plain');
    res.send(`HTTP Status: ${response.status}\n\nResponse Headers:\n${JSON.stringify(Object.fromEntries(response.headers), null, 2)}\n\nBody:\n${text}`);
  } catch (err) {
    res.send(`Fetch error: ${err.message}`);
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`SMS Gateway running on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
});
