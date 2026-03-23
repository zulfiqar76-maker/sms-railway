const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET_KEY = process.env.SECRET_KEY || '0241';
const LOGIN_PASS = process.env.LOGIN_PASS || 'admin123';
const PORT       = process.env.PORT       || 3000;
const DB_FILE    = path.join(__dirname, 'db.json');

function readDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { messages: [], nextId: 1 };
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function now() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/sms_gateway.php', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { action, key } = req.query;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  const db = readDB();
  if (action === 'pending') {
    const messages = db.messages.filter(m => m.status === 'pending').slice(0,10)
      .map(m => ({ id: m.id, to: m.phone_to, text: m.message }));
    return res.json({ status: 'ok', messages });
  }
  if (action === 'update') {
    const id = parseInt(req.query.id || 0);
    const status = ['sent','failed'].includes(req.query.status) ? req.query.status : 'sent';
    const msg = db.messages.find(m => m.id === id);
    if (msg) { msg.status = status; msg.sent_at = now(); writeDB(db); }
    return res.json({ status: 'ok', updated: id });
  }
  res.json({ status: 'error', message: 'Unknown action' });
});

app.post('/api/login', (req, res) => {
  res.json(req.body.password === LOGIN_PASS ? { status: 'ok' } : { status: 'error', message: 'Wrong password' });
});

app.get('/api/stats', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const db = readDB();
  res.json({ status: 'ok', total: db.messages.length,
    pending: db.messages.filter(m => m.status==='pending').length,
    sent:    db.messages.filter(m => m.status==='sent').length,
    failed:  db.messages.filter(m => m.status==='failed').length });
});

app.post('/api/send', (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message) return res.json({ status: 'error', message: 'Fill all fields' });
  const db = readDB();
  const id = db.nextId++;
  db.messages.push({ id, phone_to: phone, message, status: 'pending', created: now(), sent_at: null });
  writeDB(db);
  res.json({ status: 'ok', id });
});

app.get('/api/history', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const page = parseInt(req.query.page || 1);
  const filter = req.query.filter || 'all';
  const db = readDB();
  let msgs = db.messages.slice().reverse();
  if (filter !== 'all') msgs = msgs.filter(m => m.status === filter);
  res.json({ status: 'ok', messages: msgs.slice((page-1)*20, page*20), total: msgs.length });
});

app.get('/api/delete', (req, res) => {
  if (req.query.key !== SECRET_KEY) return res.json({ status: 'error' });
  const id = req.query.id || '';
  const db = readDB();
  if      (id === 'all')    db.messages = [];
  else if (id === 'sent')   db.messages = db.messages.filter(m => m.status !== 'sent');
  else if (id === 'failed') db.messages = db.messages.filter(m => m.status !== 'failed');
  else                      db.messages = db.messages.filter(m => m.id !== parseInt(id));
  writeDB(db);
  res.json({ status: 'ok' });
});

app.listen(PORT, () => console.log(`SMS Gateway on port ${PORT}`));
