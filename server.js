const express  = require('express');
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  CONFIGURATION
// ─────────────────────────────────────────────
const SECRET_KEY = process.env.SECRET_KEY || '0241';
const LOGIN_PASS = process.env.LOGIN_PASS || 'admin123';
const PORT       = process.env.PORT       || 3000;

// ─────────────────────────────────────────────
//  DATABASE  (separate db.json file)
// ─────────────────────────────────────────────
const path    = require('path');
const DB_PATH = path.join(__dirname, 'db.json');
const adapter = new FileSync(DB_PATH);
const db      = low(adapter);
db.defaults({ messages: [], nextId: 1 }).write();

function getNextId() {
  const id = db.get('nextId').value();
  db.set('nextId', id + 1).write();
  return id;
}

function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ─────────────────────────────────────────────
//  CORS
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

app.use(express.static('public'));

// ═══════════════════════════════════════════════
//  ANDROID APP API
// ═══════════════════════════════════════════════
app.get('/sms_gateway.php', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const action = req.query.action || '';
  const key    = req.query.key    || '';

  if (key !== SECRET_KEY) {
    return res.json({ status: 'error', message: 'Invalid secret key' });
  }

  if (action === 'pending') {
    const messages = db.get('messages')
      .filter({ status: 'pending' })
      .sortBy('id')
      .take(10)
      .map(m => ({ id: m.id, to: m.phone_to, text: m.message }))
      .value();
    return res.json({ status: 'ok', messages });
  }

  if (action === 'update') {
    const id     = parseInt(req.query.id || 0);
    const status = ['sent','failed'].includes(req.query.status) ? req.query.status : 'sent';
    db.get('messages').find({ id }).assign({ status, sent_at: now() }).write();
    return res.json({ status: 'ok', updated: id });
  }

  return res.json({ status: 'error', message: 'Unknown action' });
});

// ═══════════════════════════════════════════════
//  WEB API
// ═══════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  res.json(password === LOGIN_PASS
    ? { status: 'ok' }
    : { status: 'error', message: 'Wrong password' });
});

app.get('/api/stats', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const all = db.get('messages').value();
  res.json({
    status: 'ok',
    total:   all.length,
    pending: all.filter(m => m.status === 'pending').length,
    sent:    all.filter(m => m.status === 'sent').length,
    failed:  all.filter(m => m.status === 'failed').length
  });
});

app.post('/api/send', (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message) return res.json({ status: 'error', message: 'Fill all fields' });
  const id = getNextId();
  db.get('messages').push({ id, phone_to: phone, message, status: 'pending', created: now(), sent_at: null }).write();
  res.json({ status: 'ok', id });
});

app.get('/api/history', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const filter = req.query.filter || 'all';
  const page   = parseInt(req.query.page || 1);
  const limit  = 20;
  let msgs = db.get('messages').value().slice().reverse();
  if (filter !== 'all') msgs = msgs.filter(m => m.status === filter);
  res.json({ status: 'ok', messages: msgs.slice((page-1)*limit, page*limit), total: msgs.length });
});

app.post('/api/edit', (req, res) => {
  const { key, id, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!id || !phone || !message) return res.json({ status: 'error', message: 'Fill all fields' });
  const record = db.get('messages').find({ id: parseInt(id) }).value();
  if (!record) return res.json({ status: 'error', message: 'Message not found' });
  db.get('messages')
    .find({ id: parseInt(id) })
    .assign({ phone_to: phone, message, status: 'pending', sent_at: null })
    .write();
  res.json({ status: 'ok' });
});

app.get('/api/delete', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const id = req.query.id || '';
  if      (id === 'all')    db.set('messages', []).write();
  else if (id === 'sent')   db.get('messages').remove({ status: 'sent' }).write();
  else if (id === 'failed') db.get('messages').remove({ status: 'failed' }).write();
  else                      db.get('messages').remove({ id: parseInt(id) }).write();
  res.json({ status: 'ok' });
});

// ═══════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`SMS Gateway running on port ${PORT}`);
});
