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

async function phpApi(action, extra = {}) {
  const params = new URLSearchParams({ key: PHP_API_KEY, action, ...extra });
  const url    = `${PHP_API_URL}?${params}`;
  const res    = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`PHP API HTTP ${res.status}`);
  return res.json();
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

async function handleGateway(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const key    = req.query.key    || req.body?.key    || '';
  const action = req.query.action || req.body?.action || 'pending';
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid secret key' });
  try {
    if (action === 'pending') {
      const data = await phpApi('pending');
      if (data.status !== 'ok') return res.json({ status: 'error', message: data.error || 'PHP API error' });
      const messages = (data.sms || []).map(r => ({ id: String(r.id), to: r.phone, text: r.message }));
      return res.json({ status: 'ok', messages });
    }
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
    return res.json({ status: 'error', message: err.message });
  }
}

app.get('/sms_gateway.php',  handleGateway);
app.post('/sms_gateway.php', handleGateway);

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  res.json(password === LOGIN_PASS ? { status: 'ok' } : { status: 'error', message: 'Wrong password' });
});

app.get('/api/stats', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try {
    const data = await phpApi('stats');
    res.json({ status: 'ok', ...data.stats, total: (data.stats?.pending||0)+(data.stats?.sent||0)+(data.stats?.failed||0) });
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.post('/api/send', async (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message)  return res.json({ status: 'error', message: 'Fill all fields' });
  try {
    const response = await fetch(PHP_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: PHP_API_KEY, action: 'send', phone, message }),
      signal: AbortSignal.timeout(15000),
    });
    res.json(await response.json());
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.get('/api/history', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try {
    const data = await phpApi('log', { limit: 100 });
    res.json({ status: 'ok', messages: (data.log||[]).map(r => ({
      id: r.id, phone_to: r.phone, message: r.message,
      status: r.status, fail_reason: r.fail_reason, created_at: r.created_at, sent_at: r.sent_at
    })), total: data.count||0 });
  } catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.get('/api/delete', async (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  try { res.json(await phpApi('delete', { id: req.query.id || 'all' })); }
  catch (err) { res.json({ status: 'error', message: err.message }); }
});

app.get('/health', async (req, res) => {
  try { res.json({ status: 'ok', php_api: await phpApi('ping') }); }
  catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

app.listen(PORT, () => {
  console.log(`SMS Gateway running on port ${PORT}`);
  console.log(`PHP API: ${PHP_API_URL}`);
});
