// server.js — the reservation, ordering and content API for Musafir Cafe.
//
// Reservations & orders:
//   POST  /api/reservations        create a reservation (website form)
//   GET   /api/reservations        list all (admin only)
//   PATCH /api/reservations/:id    update status (admin only)
//   POST  /api/orders              create a food order (website cart; UPI orders come with their UTR)
//   GET   /api/orders              list all (admin only)
//   PATCH /api/orders/:id          update status (admin only)
//   PATCH /api/orders/:id/payment-status  owner marks a UPI order paid (admin only)
//   PATCH /api/admin/menu/:id/availability  mark an item available / unavailable (admin only)
//
// Customer accounts (login with mobile number + 6-digit PIN):
//   POST /api/account/signup | /login | /logout     create account / log in / log out
//   GET  /api/account/me | /orders | /reservations  the logged-in customer's details and history
//   POST /api/account/claim | /change-pin           attach earlier guest orders / change PIN
//   GET /api/admin/customers, PATCH .../:id/pin, DELETE .../:id   owner manages accounts (admin only)
//
// Site content (powers the "no-code" admin panel):
//   GET /api/content/settings      public — hero/about/contact text the site displays
//   PUT /api/admin/settings        admin only — update that text
//   GET /api/content/menu          public — all menu items
//   POST/PUT/DELETE /api/admin/menu[/:id]   admin only — manage menu items
//   GET /api/content/gallery       public — all gallery images
//   POST/PUT/DELETE /api/admin/gallery[/:id]  admin only
//   POST /api/admin/upload         admin only — upload a photo file (saved in ./uploads)
//   GET /api/content/news          public — all news posts
//   POST/PUT/DELETE /api/admin/news[/:id]   admin only
//
// Run locally:
//   1. npm install
//   2. cp .env.example .env   (then fill in your own values)
//   3. npm start
//   The API listens on http://localhost:4000 by default.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const { sendReservationEmail, sendOrderEmail } = require('./mailer');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Normal JSON bodies are capped small. The photo-upload route needs a bigger
// limit, so it is skipped here and gets its own parser further down.
app.use((req, res, next) =>
  req.path === '/api/admin/upload'
    ? next()
    : express.json()(req, res, next)
);

// Photos uploaded from the admin panel are saved in ./uploads and served
// publicly at /uploads/<file> so the website can show them.
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));

// Deletes a previously uploaded photo from disk (ignores normal http links).
function removeUploadedFile(url) {
  if (url && typeof url === 'string' && url.startsWith('/uploads/')) {
    fs.unlink(path.join(uploadsDir, path.basename(url)), () => {});
  }
}

// --- CORS: only allow the frontend origins listed in .env ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // allow requests with no origin (curl, mobile apps) and any listed origin
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
  })
);

// --- basic rate limiting so the public booking endpoint can't be spammed ---
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 reservation attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reservation attempts. Please try again later.' },
});

const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 order attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many order attempts. Please try again later.' },
});

// --- tiny admin-key gate for viewing/managing reservations ---
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- validation helper ---
function validateReservation(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
    errors.push('name is required');
  }
  if (!body.phone || typeof body.phone !== 'string' || body.phone.trim().length < 6) {
    errors.push('phone is required');
  }
  if (!body.date) errors.push('date is required');
  if (!body.time) errors.push('time is required');
  if (!body.guests) errors.push('guests is required');
  return errors;
}

const TABLE_PATTERN = /^[A-Za-z0-9 -]{1,10}$/;

function validateOrder(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
    errors.push('name is required');
  }
  if (!body.phone || typeof body.phone !== 'string' || body.phone.trim().length < 6) {
    errors.push('phone is required');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items must be a non-empty array');
  } else {
    for (const item of body.items) {
      if (!item || !item.name || typeof item.name !== 'string' || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 50) {
        errors.push('each item needs a name and a whole-number qty between 1 and 50');
        break;
      }
    }
  }
  if (body.order_type !== undefined && !['dine-in', 'pickup', 'delivery'].includes(body.order_type)) {
    errors.push("order_type must be 'dine-in', 'pickup' or 'delivery'");
  }
  if (body.order_type === 'delivery' && (!body.address || !body.address.trim())) {
    errors.push('address is required for delivery orders');
  }
  if (body.order_type === 'dine-in' && !TABLE_PATTERN.test(String(body.table_number || '').trim())) {
    errors.push('please enter your table number (letters, numbers or - only, up to 10 characters)');
  }
  if (body.payment_method !== undefined && !['cash', 'upi'].includes(body.payment_method)) {
    errors.push("payment_method must be 'cash' or 'upi'");
  }
  if (body.payment_method === 'upi' && !/^\d{12}$/.test(String(body.payment_ref || '').replace(/\s+/g, ''))) {
    errors.push('Please pay first, then enter the 12-digit UPI reference (UTR) number from your payment app.');
  }
  return errors;
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Create a reservation — called by the website's reservation form
app.post('/api/reservations', bookingLimiter, async (req, res) => {
  const errors = validateReservation(req.body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid submission', details: errors });
  }

  const { name, phone, date, time, guests, message } = req.body;

  const stmt = db.prepare(`
    INSERT INTO reservations (name, phone, date, time, guests, message, customer_id)
    VALUES (@name, @phone, @date, @time, @guests, @message, @customer_id)
  `);
  const loggedIn = getCustomer(req);
  const info = stmt.run({
    name: name.trim(),
    phone: phone.trim(),
    date,
    time,
    guests,
    message: (message || '').trim(),
    customer_id: loggedIn ? loggedIn.id : null,
  });

  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(info.lastInsertRowid);

  const emailResult = await sendReservationEmail(reservation);

  res.status(201).json({
    message: 'Reservation received',
    reservation,
    emailSent: emailResult.sent,
  });
});

// List reservations — admin only
app.get('/api/reservations', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM reservations ORDER BY created_at DESC').all();
  res.json(rows);
});

// Update a reservation's status (e.g. confirmed / cancelled) — admin only
app.patch('/api/reservations/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const result = db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Reservation not found' });
  }
  const updated = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Create an order — called by the website's cart checkout
// =====================================================================
// CUSTOMER ACCOUNTS — login with mobile number + 6-digit PIN
// (No SMS service needed. The owner can reset a forgotten PIN in the admin panel.)
// =====================================================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
const SESSION_DAYS = 90;
const MAX_FAILED_PINS = 5;      // wrong PINs allowed ...
const LOCK_MINUTES = 15;        // ... before that account is locked for a while

// accepts 98765 43210, +91 98765 43210, 098765 43210 ... returns the 10 digits, or null
function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 64).toString('hex'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function createSession(customerId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), customerId, new Date(Date.now() + SESSION_DAYS * 86400000).toISOString());
  return token;
}
function bearerToken(req) {
  const m = (req.header('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}
// the logged-in customer for this request, or null (also used for optional login while ordering)
function getCustomer(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT c.id, c.name, c.phone, s.expires_at FROM sessions s
    JOIN customers c ON c.id = s.customer_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { id: row.id, name: row.name, phone: row.phone };
}
function requireCustomer(req, res, next) {
  const customer = getCustomer(req);
  if (!customer) return res.status(401).json({ error: 'Please log in again.' });
  req.customer = customer;
  next();
}

app.post('/api/account/signup', authLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  if (db.prepare('SELECT id FROM customers WHERE phone = ?').get(phone)) {
    return res.status(409).json({ error: 'This number already has an account. Please log in.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const info = db.prepare('INSERT INTO customers (name, phone, pin_salt, pin_hash) VALUES (?, ?, ?, ?)')
    .run(name, phone, salt, hashPin(pin, salt));
  const id = Number(info.lastInsertRowid);
  res.status(201).json({ token: createSession(id), customer: { id, name, phone } });
});

app.post('/api/account/login', authLimiter, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  const wrong = () => res.status(401).json({ error: 'Wrong mobile number or PIN.' });
  if (!phone || !/^\d{6}$/.test(pin)) return wrong();
  const customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  if (!customer) return wrong();

  if (customer.locked_until && new Date(customer.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(customer.locked_until) - new Date()) / 60000);
    return res.status(429).json({ error: `Too many wrong PINs. Please try again in ${mins} minute${mins > 1 ? 's' : ''}, or ask the cafe to reset your PIN.` });
  }
  if (!safeEqual(hashPin(pin, customer.pin_salt), customer.pin_hash)) {
    const failed = customer.failed_attempts + 1;
    if (failed >= MAX_FAILED_PINS) {
      db.prepare('UPDATE customers SET failed_attempts = 0, locked_until = ? WHERE id = ?')
        .run(new Date(Date.now() + LOCK_MINUTES * 60000).toISOString(), customer.id);
    } else {
      db.prepare('UPDATE customers SET failed_attempts = ? WHERE id = ?').run(failed, customer.id);
    }
    return wrong();
  }
  db.prepare('UPDATE customers SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(customer.id);
  res.json({ token: createSession(customer.id), customer: { id: customer.id, name: customer.name, phone: customer.phone } });
});

app.post('/api/account/logout', (req, res) => {
  const token = bearerToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.json({ ok: true });
});

app.get('/api/account/me', requireCustomer, (req, res) => res.json({ customer: req.customer }));

// all orders placed while logged in (newest first)
app.get('/api/account/orders', requireCustomer, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(req.customer.id);
  res.json(rows.map(publicOrder));
});

app.get('/api/account/reservations', requireCustomer, (req, res) => {
  res.json(db.prepare('SELECT * FROM reservations WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(req.customer.id));
});

// Orders placed as a guest on this phone are attached to the account after logging in.
// Each one needs the secret token the server handed out when it was placed.
app.post('/api/account/claim', requireCustomer, (req, res) => {
  const list = Array.isArray(req.body.orders) ? req.body.orders.slice(0, 50) : [];
  const attach = db.prepare('UPDATE orders SET customer_id = ? WHERE id = ? AND claim_token = ? AND customer_id IS NULL');
  let linked = 0;
  for (const o of list) {
    if (o && Number.isInteger(o.id) && typeof o.token === 'string' && o.token.length >= 16) {
      linked += attach.run(req.customer.id, o.id, o.token).changes;
    }
  }
  res.json({ linked });
});

app.post('/api/account/change-pin', authLimiter, requireCustomer, (req, res) => {
  const oldPin = String(req.body.old_pin || '');
  const newPin = String(req.body.new_pin || '');
  if (!/^\d{6}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be exactly 6 digits.' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.customer.id);
  if (!safeEqual(hashPin(oldPin, customer.pin_salt), customer.pin_hash)) {
    return res.status(401).json({ error: 'Your current PIN is not correct.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE customers SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hashPin(newPin, salt), customer.id);
  // log out every other phone that was using this account
  db.prepare('DELETE FROM sessions WHERE customer_id = ? AND token_hash != ?').run(customer.id, sha256(bearerToken(req)));
  res.json({ ok: true });
});

// ---------- owner tools (admin only) ----------
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.id, c.name, c.phone, c.created_at,
           (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count
    FROM customers c ORDER BY c.id DESC`).all());
});

// forgotten PIN: the owner sets a new one and tells the customer
app.patch('/api/admin/customers/:id/pin', requireAdmin, (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const result = db.prepare('UPDATE customers SET pin_salt = ?, pin_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .run(salt, hashPin(pin, salt), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Customer not found' });
  db.prepare('DELETE FROM sessions WHERE customer_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/customers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE customer_id = ?').run(req.params.id);
  db.prepare('UPDATE orders SET customer_id = NULL WHERE customer_id = ?').run(req.params.id);
  db.prepare('UPDATE reservations SET customer_id = NULL WHERE customer_id = ?').run(req.params.id);
  const result = db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Customer not found' });
  res.json({ deleted: true });
});

// An order row as sent to the browser: items parsed, secret pay_token removed.
function publicOrder(row) {
  const { pay_token, claim_token, ...rest } = row;
  return { ...rest, items: JSON.parse(row.items) };
}
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const value = row ? row.value : '';
  // optional fallback: UPI_ID / UPI_NAME in .env, used when nothing is saved in the admin panel
  if (!value.trim() && key === 'upi_id') return process.env.UPI_ID || '';
  if (!value.trim() && key === 'upi_name') return process.env.UPI_NAME || '';
  return value;
}
const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/;

app.post('/api/orders', orderLimiter, async (req, res) => {
  const errors = validateOrder(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors[0], details: errors });
  }

  const { name, phone, order_type, address, items, notes } = req.body;
  const orderType = ['dine-in', 'delivery'].includes(order_type) ? order_type : 'pickup';
  const tableNumber = orderType === 'dine-in' ? String(req.body.table_number).trim() : null;
  const payment_method = req.body.payment_method === 'upi' ? 'upi' : 'cash';

  // Prices and availability come from the menu in the database, never from
  // the browser — so nobody can edit a price, and sold-out items are refused.
  const findItem = db.prepare('SELECT name, price, available FROM menu_items WHERE name = ?');
  const unavailable = [];
  const lines = [];
  for (const item of items) {
    const row = findItem.get(item.name);
    if (!row || row.available === 0) { unavailable.push(item.name); continue; }
    lines.push({ name: row.name, price: row.price, qty: item.qty });
  }
  if (unavailable.length) {
    const list = unavailable.join(', ');
    return res.status(409).json({
      error: 'unavailable',
      unavailable,
      message: `Sorry, ${list} ${unavailable.length > 1 ? 'are' : 'is'} currently unavailable. Please remove ${unavailable.length > 1 ? 'them' : 'it'} from your order and try again.`,
    });
  }
  const total = Math.round(lines.reduce((sum, i) => sum + i.price * i.qty, 0) * 100) / 100;

  // UPI orders are placed AFTER the customer has paid: they arrive together with the
  // 12-digit UPI reference (UTR), which the owner matches in their UPI / bank app.
  let paymentRef = null;
  if (payment_method === 'upi') {
    if (!VPA_PATTERN.test(getSetting('upi_id').trim())) {
      return res.status(400).json({ error: 'UPI payment is not available right now. Please choose pay at cafe / on delivery.' });
    }
    paymentRef = String(req.body.payment_ref).replace(/\s+/g, '');
    if (db.prepare('SELECT id FROM orders WHERE payment_ref = ?').get(paymentRef)) {
      return res.status(409).json({ error: 'This reference number was already used for another order. Please check it and try again.' });
    }
  }
  const claimToken = crypto.randomBytes(16).toString('hex');   // returned once, so a guest's phone can attach this order after logging in

  const info = db.prepare(`
    INSERT INTO orders (name, phone, order_type, table_number, address, items, total, notes, payment_method, payment_status, payment_ref, customer_id, claim_token)
    VALUES (@name, @phone, @order_type, @table_number, @address, @items, @total, @notes, @payment_method, @payment_status, @payment_ref, @customer_id, @claim_token)
  `).run({
    name: name.trim(),
    phone: phone.trim(),
    order_type: orderType,
    table_number: tableNumber,
    address: (address || '').trim(),
    items: JSON.stringify(lines),
    total,
    notes: (notes || '').trim(),
    payment_method,
    payment_status: payment_method === 'upi' ? 'claimed' : 'unpaid',
    payment_ref: paymentRef,
    customer_id: getCustomer(req) ? getCustomer(req).id : null,
    claim_token: claimToken,
  });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  const emailResult = await sendOrderEmail(order);

  const response = { message: 'Order received', order: publicOrder(order), emailSent: emailResult.sent, claim_token: claimToken };
  res.status(201).json(response);
});

// List orders — admin only
app.get('/api/orders', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(rows.map(publicOrder));
});

// Update an order's status (e.g. preparing / ready / delivered / cancelled) — admin only
app.patch('/api/orders/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  res.json(publicOrder(updated));
});

// Owner marks a UPI order as paid (after checking their UPI app) — admin only
app.patch('/api/orders/:id/payment-status', requireAdmin, (req, res) => {
  const { payment_status } = req.body;
  if (!['unpaid', 'claimed', 'paid'].includes(payment_status)) {
    return res.status(400).json({ error: 'payment_status must be unpaid, claimed or paid' });
  }
  const result = db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(payment_status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

// =====================================================================
// CONTENT API — lets the admin edit site text, menu, gallery and news
// from the admin panel, no code changes needed. Public GET endpoints
// are read by the website itself on every page load; the write
// endpoints below are admin-only.
// =====================================================================

// ---------- settings (hero text, about text, contact info, footer) ----------
app.get('/api/content/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  if (!(settings.upi_id || '').trim() && process.env.UPI_ID) settings.upi_id = process.env.UPI_ID;
  if (!(settings.upi_name || '').trim() && process.env.UPI_NAME) settings.upi_name = process.env.UPI_NAME;
  res.json(settings);
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Body must be an object of key/value pairs' });
  }
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const runAll = db.transaction((entries) => {
    for (const [key, value] of entries) {
      // site photos (hero/about/dining): delete the old uploaded file when replaced
      if (/_image2?$/.test(key)) {
        const old = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (old && old.value !== String(value)) removeUploadedFile(old.value);
      }
      upsert.run({ key, value: String(value) });
    }
  });
  runAll(Object.entries(updates));
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json(settings);
});

// ---------- menu items ----------
app.get('/api/content/menu', (req, res) => {
  const rows = db.prepare('SELECT * FROM menu_items ORDER BY category, sort_order, id').all();
  res.json(rows);
});

function validateMenuItem(body) {
  const errors = [];
  if (!body.category || typeof body.category !== 'string') errors.push('category is required');
  if (!body.name || typeof body.name !== 'string') errors.push('name is required');
  if (typeof body.price !== 'number' || body.price < 0) errors.push('price must be a non-negative number');
  return errors;
}

app.post('/api/admin/menu', requireAdmin, (req, res) => {
  const errors = validateMenuItem(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid item', details: errors });
  const { category, name, description, price, sort_order, image_url } = req.body;
  const info = db
    .prepare('INSERT INTO menu_items (category, name, description, price, image_url, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(category.trim(), name.trim(), (description || '').trim(), price, (image_url || '').trim(), sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const errors = validateMenuItem(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid item', details: errors });
  const { category, name, description, price, sort_order, image_url } = req.body;
  const existing = db.prepare('SELECT image_url FROM menu_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Menu item not found' });
  const newImage = image_url === undefined ? existing.image_url || '' : String(image_url).trim();
  if (newImage !== (existing.image_url || '')) removeUploadedFile(existing.image_url);
  db.prepare('UPDATE menu_items SET category=?, name=?, description=?, price=?, image_url=?, sort_order=? WHERE id=?')
    .run(category.trim(), name.trim(), (description || '').trim(), price, newImage, sort_order || 0, req.params.id);
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id));
});

// Switch a single menu item between available / unavailable — admin only
app.patch('/api/admin/menu/:id/availability', requireAdmin, (req, res) => {
  if (typeof req.body.available !== 'boolean') {
    return res.status(400).json({ error: 'available must be true or false' });
  }
  const result = db.prepare('UPDATE menu_items SET available = ? WHERE id = ?').run(req.body.available ? 1 : 0, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Menu item not found' });
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/menu/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT image_url FROM menu_items WHERE id = ?').get(req.params.id);
  if (row) removeUploadedFile(row.image_url);
  const result = db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Menu item not found' });
  res.json({ deleted: true });
});

// ---------- photo upload (admin picks a file from their device) ----------
// Receives one image as a base64 data URL, saves it into ./uploads and
// returns the public path (e.g. /uploads/ab12cd.jpg) to store in the gallery.
const UPLOAD_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB per photo

app.post('/api/admin/upload', requireAdmin, express.json({ limit: '12mb' }), (req, res) => {
  const { data } = req.body || {};
  const match = typeof data === 'string' && data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match || !UPLOAD_TYPES[match[1]]) {
    return res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'Image must be smaller than 8 MB.' });
  }
  const filename = crypto.randomBytes(12).toString('hex') + UPLOAD_TYPES[match[1]];
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  res.status(201).json({ url: '/uploads/' + filename });
});

// ---------- gallery images ----------
app.get('/api/content/gallery', (req, res) => {
  res.json(db.prepare('SELECT * FROM gallery_images ORDER BY sort_order, id').all());
});

app.post('/api/admin/gallery', requireAdmin, (req, res) => {
  const { image_url, caption, sort_order } = req.body;
  if (!image_url || typeof image_url !== 'string') {
    return res.status(400).json({ error: 'image_url is required' });
  }
  const info = db
    .prepare('INSERT INTO gallery_images (image_url, caption, sort_order) VALUES (?, ?, ?)')
    .run(image_url.trim(), (caption || '').trim(), sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/admin/gallery/:id', requireAdmin, (req, res) => {
  const { image_url, caption, sort_order } = req.body;
  if (!image_url || typeof image_url !== 'string') {
    return res.status(400).json({ error: 'image_url is required' });
  }
  const result = db
    .prepare('UPDATE gallery_images SET image_url=?, caption=?, sort_order=? WHERE id=?')
    .run(image_url.trim(), (caption || '').trim(), sort_order || 0, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Image not found' });
  res.json(db.prepare('SELECT * FROM gallery_images WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/gallery/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT image_url FROM gallery_images WHERE id = ?').get(req.params.id);
  if (row) removeUploadedFile(row.image_url);
  const result = db.prepare('DELETE FROM gallery_images WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Image not found' });
  res.json({ deleted: true });
});

// ---------- news posts ----------
app.get('/api/content/news', (req, res) => {
  res.json(db.prepare('SELECT * FROM news_posts ORDER BY sort_order, id').all());
});

app.post('/api/admin/news', requireAdmin, (req, res) => {
  const { title, excerpt, image_url, date_label, link, sort_order } = req.body;
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  const info = db
    .prepare('INSERT INTO news_posts (title, excerpt, image_url, date_label, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title.trim(), (excerpt || '').trim(), (image_url || '').trim(), (date_label || '').trim(), (link || '').trim(), sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM news_posts WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/admin/news/:id', requireAdmin, (req, res) => {
  const { title, excerpt, image_url, date_label, link, sort_order } = req.body;
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  const existing = db.prepare('SELECT image_url FROM news_posts WHERE id = ?').get(req.params.id);
  if (existing && (image_url || '').trim() !== (existing.image_url || '')) removeUploadedFile(existing.image_url);
  const result = db
    .prepare('UPDATE news_posts SET title=?, excerpt=?, image_url=?, date_label=?, link=?, sort_order=? WHERE id=?')
    .run(title.trim(), (excerpt || '').trim(), (image_url || '').trim(), (date_label || '').trim(), (link || '').trim(), sort_order || 0, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json(db.prepare('SELECT * FROM news_posts WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/news/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT image_url FROM news_posts WHERE id = ?').get(req.params.id);
  if (row) removeUploadedFile(row.image_url);
  const result = db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Post not found' });
  res.json({ deleted: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Musafir Cafe reservation API running on http://localhost:${PORT}`);
});
