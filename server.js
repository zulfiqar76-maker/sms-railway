const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────
//  CONFIGURATION — Change SECRET_KEY
// ─────────────────────────────────────────────
const SECRET_KEY   = process.env.SECRET_KEY   || '0241';
const LOGIN_PASS   = process.env.LOGIN_PASS   || 'admin123';
const PORT         = process.env.PORT         || 3000;
const DB_PATH      = process.env.DB_PATH      || './sms_gateway.db';
// ─────────────────────────────────────────────

// Initialize SQLite database
const db = new Database(DB_PATH);

// Create table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS sms_queue (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_to  TEXT NOT NULL,
    message   TEXT NOT NULL,
    status    TEXT DEFAULT 'pending',
    created   DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at   DATETIME NULL
  )
`);

// Allow CORS for all requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Serve static files (web pages)
app.use(express.static('public'));

// ═══════════════════════════════════════════
//  API — For Android App
// ═══════════════════════════════════════════

app.get('/sms_gateway.php', (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const action = req.query.action || '';
  const key    = req.query.key    || '';

  // Validate secret key
  if (key !== SECRET_KEY) {
    return res.json({ status: 'error', message: 'Invalid secret key' });
  }

  // Get pending messages
  if (action === 'pending') {
    const messages = db.prepare(
      "SELECT id, phone_to AS 'to', message AS text FROM sms_queue WHERE status='pending' ORDER BY created ASC LIMIT 10"
    ).all();
    return res.json({ status: 'ok', messages });
  }

  // Mark message as sent/failed
  if (action === 'update') {
    const id     = parseInt(req.query.id || 0);
    const status = ['sent', 'failed'].includes(req.query.status) ? req.query.status : 'sent';
    db.prepare("UPDATE sms_queue SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?").run(status, id);
    return res.json({ status: 'ok', updated: id });
  }

  return res.json({ status: 'error', message: 'Unknown action' });
});

// ═══════════════════════════════════════════
//  WEB PAGES API
// ═══════════════════════════════════════════

// Login check
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === LOGIN_PASS) {
    res.json({ status: 'ok' });
  } else {
    res.json({ status: 'error', message: 'Wrong password' });
  }
});

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  const key = req.query.key || '';
  if (key !== SECRET_KEY) return res.json({ status: 'error' });

  const total   = db.prepare("SELECT COUNT(*) as c FROM sms_queue").get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status='pending'").get().c;
  const sent    = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status='sent'").get().c;
  const failed  = db.prepare("SELECT COUNT(*) as c FROM sms_queue WHERE status='failed'").get().c;

  res.json({ status: 'ok', total, pending, sent, failed });
});

// Send new SMS (from web page)
app.post('/api/send', (req, res) => {
  const { key, phone, message } = req.body;
  if (key !== SECRET_KEY) return res.json({ status: 'error', message: 'Invalid key' });
  if (!phone || !message) return res.json({ status: 'error', message: 'Phone and message required' });

  const result = db.prepare(
    "INSERT INTO sms_queue (phone_to, message, status) VALUES (?, ?, 'pending')"
  ).run(phone, message);

  res.json({ status: 'ok', id: result.lastInsertRowid });
});

// Get message history
app.get('/api/history', (req, res) => {
  const key    = req.query.key    || '';
  const filter = req.query.filter || 'all';
  const page   = parseInt(req.query.page || 1);
  const limit  = 20;
  const offset = (page - 1) * limit;

  if (key !== SECRET_KEY) return res.json({ status: 'error' });

  let where = filter !== 'all' ? `WHERE status='${filter}'` : '';
  const messages = db.prepare(
    `SELECT * FROM sms_queue ${where} ORDER BY created DESC LIMIT ${limit} OFFSET ${offset}`
  ).all();
  const total = db.prepare(`SELECT COUNT(*) as c FROM sms_queue ${where}`).get().c;

  res.json({ status: 'ok', messages, total });
});

// Delete message
app.get('/api/delete', (req, res) => {
  const key = req.query.key || '';
  const id  = req.query.id  || '';
  if (key !== SECRET_KEY) return res.json({ status: 'error' });

  if (id === 'all')    db.exec("DELETE FROM sms_queue");
  else if (id === 'sent')   db.exec("DELETE FROM sms_queue WHERE status='sent'");
  else if (id === 'failed') db.exec("DELETE FROM sms_queue WHERE status='failed'");
  else db.prepare("DELETE FROM sms_queue WHERE id=?").run(parseInt(id));

  res.json({ status: 'ok' });
});

// ═══════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`✅ SMS Gateway running on port ${PORT}`);
  console.log(`🔑 Secret Key: ${SECRET_KEY}`);
});
