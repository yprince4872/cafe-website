// server.js — the reservation, ordering, accounts and content API for Musafir Cafe.
// Database: MongoDB (see db.js).
//
// Reservations & orders:
//   POST  /api/reservations        create a reservation (website form)
//   GET   /api/reservations        list all (admin only)
//   PATCH /api/reservations/:id    update status (admin only)
//   POST  /api/orders              create a food order (website cart; UPI orders come with their UTR)
//   GET   /api/orders              list all (admin only)
//   PATCH /api/orders/:id          update status (admin only)
//   PATCH /api/orders/:id/payment-status  owner marks a UPI order paid (admin only)
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
//   PATCH /api/admin/menu/:id/availability  mark an item available / unavailable (admin only)
//   GET /api/content/gallery       public — all gallery images
//   POST/PUT/DELETE /api/admin/gallery[/:id]  admin only
//   POST /api/admin/upload         admin only — upload a photo (kept in MongoDB, shown at /uploads/<file>)
//   GET /api/content/news          public — all news posts
//   POST/PUT/DELETE /api/admin/news[/:id]   admin only
//
// Run locally:
//   1. npm install
//   2. copy .env.example to .env and fill in MONGODB_URI and the other values
//   3. npm start          (the API listens on http://localhost:4000 by default)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const db = require('./db');
const { sendReservationEmail, sendOrderEmail } = require('./mailer');

const app = express();
app.set('trust proxy', 1);   // behind a host's proxy (Render, Railway ...) the real visitor address is used for rate limits

// Normal JSON bodies are capped small. The photo-upload route needs a bigger
// limit, so it is skipped here and gets its own parser further down.
app.use((req, res, next) =>
  req.path === '/api/admin/upload'
    ? next()
    : express.json()(req, res, next)
);

// ---------- CORS: which websites may talk to this API ----------
// ALLOWED_ORIGINS in .env = your live website address(es), comma separated.
// While testing on your own computer / phone, local addresses are allowed automatically.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, '').toLowerCase())
  .filter(Boolean);
const isProduction = process.env.NODE_ENV === 'production';
const warnedOrigins = new Set();

function originAllowed(origin) {
  if (!origin) return true;                                     // curl, server-to-server, mobile apps
  const o = origin.replace(/\/+$/, '').toLowerCase();
  if (allowedOrigins.length === 0 || allowedOrigins.includes(o)) return true;
  if (!isProduction) {
    if (o === 'null') return true;                              // a page opened straight from a file
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o)) return true;
    if (/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d+)?$/.test(o)) return true;   // phone on the same Wi-Fi
  }
  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (originAllowed(origin)) return callback(null, true);
      if (!warnedOrigins.has(origin)) {
        warnedOrigins.add(origin);
        console.warn(`[cors] Blocked a request from ${origin}. If this is your website, add it to ALLOWED_ORIGINS in .env and restart.`);
      }
      return callback(null, false);                             // the browser blocks it; no crash, no stack trace
    },
  })
);

// ---------- basic rate limiting so public endpoints can't be spammed ----------
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many reservation attempts. Please try again later.' },
});
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many order attempts. Please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

// ---------- small helpers ----------
// Express 4 does not catch errors from async handlers by itself — this does.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// ids in the URL are whole numbers; anything else can never match a record
function idParam(req) {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}
const isDuplicateKey = (err) => !!err && (err.code === 11000 || err.code === 11001);
const str = (v) => String(v == null ? '' : v).trim();

// --- tiny admin-key gate for viewing/managing everything in the admin panel ---
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- validation ----------
function validateReservation(body) {
  const errors = [];
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
    errors.push('name is required');
  }
  if (!body.phone || typeof body.phone !== 'string' || body.phone.trim().length < 6) {
    errors.push('phone is required');
  }
  if (!body.date || typeof body.date !== 'string') errors.push('date is required');
  if (!body.time || typeof body.time !== 'string') errors.push('time is required');
  if (!body.guests || typeof body.guests !== 'string') errors.push('guests is required');
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
  if (body.order_type === 'delivery' && (typeof body.address !== 'string' || !body.address.trim())) {
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

// ---------- records as the website receives them ----------
// (internal fields never leave the server)
function publicOrder(doc) {
  const { _id, claim_token, phone_norm, linked_by_phone, pay_token, ...rest } = doc;
  return { id: _id, ...rest };
}
function publicReservation(doc) {
  const { _id, phone_norm, ...rest } = doc;
  return { id: _id, ...rest };
}

// ---------- photos uploaded from the admin panel ----------
// They live in MongoDB (collection "uploads"), so they are NOT lost when the host restarts or
// redeploys. The website shows them at  <backend address>/uploads/<file>.
const UPLOAD_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const EXT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB per photo

function uploadIdFromUrl(url) {
  const m = typeof url === 'string' && url.match(/^\/uploads\/([a-f0-9]{8,64})(\.[a-z0-9]+)?$/i);
  return m ? m[1].toLowerCase() : null;
}
// deletes a photo that is no longer used (ignores normal http links)
function removeUploadedFile(url) {
  const id = uploadIdFromUrl(url);
  if (id) db.uploads.deleteOne({ _id: id }).catch(() => {});
}
function binaryToBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (b && b.buffer) {
    const len = typeof b.length === 'function' ? b.length() : b.buffer.length;
    return Buffer.from(b.buffer.subarray ? b.buffer.subarray(0, len) : b.buffer);
  }
  return Buffer.from(b);
}

app.get('/uploads/:file', wrap(async (req, res) => {
  const id = uploadIdFromUrl('/uploads/' + req.params.file);
  const doc = id ? await db.uploads.findOne({ _id: id }) : null;
  if (!doc) return res.status(404).end();
  res.set('Content-Type', doc.contentType || EXT_TYPES[String(req.params.file).split('.').pop().toLowerCase()] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');   // the website lives on another address and shows these photos
  res.send(binaryToBuffer(doc.data));
}));

app.get('/api/health', wrap(async (req, res) => {
  const database = await db.ping().then(() => true).catch(() => false);
  res.json({ ok: true, database });
}));

// =====================================================================
// CUSTOMER ACCOUNTS — login with mobile number + 6-digit PIN
// (No SMS service needed. The owner can reset a forgotten PIN in the admin panel.)
// =====================================================================
const SESSION_DAYS = 90;
const MAX_FAILED_PINS = 5;      // wrong PINs allowed ...
const LOCK_MINUTES = 15;        // ... before that account is locked for a while

const normalizePhone = db.normalizePhone;
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 64).toString('hex'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function createSession(customerId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.sessions.insertOne({
    _id: sha256(token),                 // only a fingerprint of the token is stored
    customer_id: customerId,
    created_at: db.nowSql(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000),
  });
  return token;
}
function bearerToken(req) {
  const m = (req.header('authorization') || '').match(/^Bearer ([a-f0-9]{64})$/);
  return m ? m[1] : null;
}
// the logged-in customer for this request, or null (also used for optional login while ordering)
async function getCustomer(req) {
  const token = bearerToken(req);
  if (!token) return null;
  const session = await db.sessions.findOne({ _id: sha256(token) });
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    await db.sessions.deleteOne({ _id: session._id });
    return null;
  }
  const customer = await db.customers.findOne({ _id: session.customer_id });
  return customer ? { id: customer._id, name: customer.name, phone: customer.phone } : null;
}
const requireCustomer = wrap(async (req, res, next) => {
  const customer = await getCustomer(req);
  if (!customer) return res.status(401).json({ error: 'Please log in again.' });
  req.customer = customer;
  next();
});

// Orders and bookings made with this mobile number before the account existed (or while logged out)
// show up in the account. Their delivery address and notes stay hidden (see accountOrder), because
// this login cannot prove the number belongs to the person who set the PIN.
async function linkPhoneHistory(customer) {
  await db.orders.updateMany(
    { customer_id: null, phone_norm: customer.phone },
    { $set: { customer_id: customer.id, linked_by_phone: 1 } }
  );
  await db.reservations.updateMany(
    { customer_id: null, phone_norm: customer.phone },
    { $set: { customer_id: customer.id } }
  );
}
function accountOrder(doc) {
  const order = publicOrder(doc);
  if (doc.linked_by_phone) { order.address = ''; order.notes = ''; }
  return order;
}

app.post('/api/account/signup', authLimiter, wrap(async (req, res) => {
  const name = str(req.body.name);
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone) return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  if (await db.customers.findOne({ phone })) {
    return res.status(409).json({ error: 'This number already has an account. Please log in.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const customer = {
    _id: await db.nextId('customers'), name, phone, pin_salt: salt, pin_hash: hashPin(pin, salt),
    failed_attempts: 0, locked_until: null, created_at: db.nowSql(),
  };
  try {
    await db.customers.insertOne(customer);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'This number already has an account. Please log in.' });
    throw err;
  }
  await linkPhoneHistory({ id: customer._id, phone });
  res.status(201).json({ token: await createSession(customer._id), customer: { id: customer._id, name, phone } });
}));

app.post('/api/account/login', authLimiter, wrap(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = String(req.body.pin || '');
  const wrong = () => res.status(401).json({ error: 'Wrong mobile number or PIN.' });
  if (!phone || !/^\d{6}$/.test(pin)) return wrong();
  const customer = await db.customers.findOne({ phone });
  if (!customer) return wrong();

  if (customer.locked_until && new Date(customer.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(customer.locked_until) - new Date()) / 60000);
    return res.status(429).json({ error: `Too many wrong PINs. Please try again in ${mins} minute${mins > 1 ? 's' : ''}, or ask the cafe to reset your PIN.` });
  }
  if (!safeEqual(hashPin(pin, customer.pin_salt), customer.pin_hash)) {
    const failed = customer.failed_attempts + 1;
    if (failed >= MAX_FAILED_PINS) {
      await db.customers.updateOne({ _id: customer._id }, { $set: { failed_attempts: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() } });
    } else {
      await db.customers.updateOne({ _id: customer._id }, { $set: { failed_attempts: failed } });
    }
    return wrong();
  }
  await db.customers.updateOne({ _id: customer._id }, { $set: { failed_attempts: 0, locked_until: null } });
  await linkPhoneHistory({ id: customer._id, phone });
  res.json({ token: await createSession(customer._id), customer: { id: customer._id, name: customer.name, phone: customer.phone } });
}));

app.post('/api/account/logout', wrap(async (req, res) => {
  const token = bearerToken(req);
  if (token) await db.sessions.deleteOne({ _id: sha256(token) });
  res.json({ ok: true });
}));

app.get('/api/account/me', requireCustomer, (req, res) => res.json({ customer: req.customer }));

// all orders of this customer (newest first) — including earlier ones made with the same mobile number
app.get('/api/account/orders', requireCustomer, wrap(async (req, res) => {
  await linkPhoneHistory(req.customer);
  const rows = await db.orders.find({ customer_id: req.customer.id }).sort({ _id: -1 }).limit(200).toArray();
  res.json(rows.map(accountOrder));
}));

app.get('/api/account/reservations', requireCustomer, wrap(async (req, res) => {
  await linkPhoneHistory(req.customer);
  const rows = await db.reservations.find({ customer_id: req.customer.id }).sort({ _id: -1 }).limit(200).toArray();
  res.json(rows.map(publicReservation));
}));

// Orders placed as a guest on this phone are attached to the account (with full details) after
// logging in. Each one needs the secret token the server handed out when it was placed.
app.post('/api/account/claim', requireCustomer, wrap(async (req, res) => {
  const list = Array.isArray(req.body.orders) ? req.body.orders.slice(0, 50) : [];
  let linked = 0;
  for (const o of list) {
    if (o && Number.isInteger(o.id) && typeof o.token === 'string' && o.token.length >= 16) {
      const result = await db.orders.updateOne(
        { _id: o.id, claim_token: o.token, $or: [{ customer_id: null }, { customer_id: req.customer.id, linked_by_phone: 1 }] },
        { $set: { customer_id: req.customer.id, linked_by_phone: 0 } }
      );
      linked += result.modifiedCount;
    }
  }
  res.json({ linked });
}));

app.post('/api/account/change-pin', authLimiter, requireCustomer, wrap(async (req, res) => {
  const oldPin = String(req.body.old_pin || '');
  const newPin = String(req.body.new_pin || '');
  if (!/^\d{6}$/.test(newPin)) return res.status(400).json({ error: 'New PIN must be exactly 6 digits.' });
  const customer = await db.customers.findOne({ _id: req.customer.id });
  if (!safeEqual(hashPin(oldPin, customer.pin_salt), customer.pin_hash)) {
    return res.status(401).json({ error: 'Your current PIN is not correct.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await db.customers.updateOne({ _id: customer._id }, { $set: { pin_salt: salt, pin_hash: hashPin(newPin, salt) } });
  // log out every other phone that was using this account
  await db.sessions.deleteMany({ customer_id: customer._id, _id: { $ne: sha256(bearerToken(req)) } });
  res.json({ ok: true });
}));

// ---------- owner tools (admin only) ----------
app.get('/api/admin/customers', requireAdmin, wrap(async (req, res) => {
  const customers = await db.customers.find({}).sort({ _id: -1 }).toArray();
  // an order belongs to a customer if it is linked to the account OR was placed with the same mobile number
  const customerByPhone = new Map(customers.map((c) => [c.phone, c._id]));
  const orders = await db.orders.find({}, { projection: { customer_id: 1, phone_norm: 1 } }).toArray();
  const countOf = new Map();
  for (const o of orders) {
    const owner = o.customer_id != null ? o.customer_id : customerByPhone.get(o.phone_norm);
    if (owner != null) countOf.set(owner, (countOf.get(owner) || 0) + 1);
  }
  res.json(customers.map((c) => ({
    id: c._id, name: c.name, phone: c.phone, created_at: c.created_at, orders_count: countOf.get(c._id) || 0,
  })));
}));

// forgotten PIN: the owner sets a new one and tells the customer
app.patch('/api/admin/customers/:id/pin', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const pin = String(req.body.pin || '');
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const result = id && await db.customers.updateOne(
    { _id: id },
    { $set: { pin_salt: salt, pin_hash: hashPin(pin, salt), failed_attempts: 0, locked_until: null } }
  );
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Customer not found' });
  await db.sessions.deleteMany({ customer_id: id });
  res.json({ ok: true });
}));

app.delete('/api/admin/customers/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(404).json({ error: 'Customer not found' });
  await db.sessions.deleteMany({ customer_id: id });
  await db.orders.updateMany({ customer_id: id }, { $set: { customer_id: null, linked_by_phone: 0 } });
  await db.reservations.updateMany({ customer_id: id }, { $set: { customer_id: null } });
  const result = await db.customers.deleteOne({ _id: id });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Customer not found' });
  res.json({ deleted: true });
}));

// =====================================================================
// RESERVATIONS
// =====================================================================

// Create a reservation — called by the website's reservation form
app.post('/api/reservations', bookingLimiter, wrap(async (req, res) => {
  const errors = validateReservation(req.body);
  if (errors.length) {
    return res.status(400).json({ error: 'Invalid submission', details: errors });
  }
  const { name, phone, date, time, guests, message } = req.body;
  const loggedIn = await getCustomer(req);
  const doc = {
    _id: await db.nextId('reservations'),
    name: name.trim(),
    phone: phone.trim(),
    phone_norm: normalizePhone(phone),
    date,
    time,
    guests,
    message: str(message),
    status: 'pending',
    customer_id: loggedIn ? loggedIn.id : null,
    created_at: db.nowSql(),
  };
  await db.reservations.insertOne(doc);
  const reservation = publicReservation(doc);
  const emailResult = await sendReservationEmail(reservation);
  res.status(201).json({ message: 'Reservation received', reservation, emailSent: emailResult.sent });
}));

// List reservations — admin only (newest first)
app.get('/api/reservations', requireAdmin, wrap(async (req, res) => {
  const rows = await db.reservations.find({}).sort({ _id: -1 }).limit(1000).toArray();
  res.json(rows.map(publicReservation));
}));

// Update a reservation's status (e.g. confirmed / cancelled) — admin only
app.patch('/api/reservations/:id', requireAdmin, wrap(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const id = idParam(req);
  const result = id && await db.reservations.updateOne({ _id: id }, { $set: { status } });
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Reservation not found' });
  res.json(publicReservation(await db.reservations.findOne({ _id: id })));
}));

// =====================================================================
// FOOD ORDERS
// =====================================================================
async function getSetting(key) {
  const row = await db.settings.findOne({ _id: key });
  const value = row ? String(row.value) : '';
  // optional fallback: UPI_ID / UPI_NAME in .env, used when nothing is saved in the admin panel
  if (!value.trim() && key === 'upi_id') return process.env.UPI_ID || '';
  if (!value.trim() && key === 'upi_name') return process.env.UPI_NAME || '';
  return value;
}
const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z0-9.-]{2,}$/;
const UTR_REUSED = { error: 'This reference number was already used for another order. Please check it and try again.' };

app.post('/api/orders', orderLimiter, wrap(async (req, res) => {
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
  const unavailable = [];
  const lines = [];
  for (const item of items) {
    const row = await db.menu.findOne({ name: item.name });
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
    if (!VPA_PATTERN.test((await getSetting('upi_id')).trim())) {
      return res.status(400).json({ error: 'UPI payment is not available right now. Please choose pay at cafe / on delivery.' });
    }
    paymentRef = String(req.body.payment_ref).replace(/\s+/g, '');
    if (await db.orders.findOne({ payment_ref: paymentRef })) return res.status(409).json(UTR_REUSED);
  }
  const claimToken = crypto.randomBytes(16).toString('hex');   // returned once, so a guest's phone can attach this order after logging in
  const loggedIn = await getCustomer(req);

  const doc = {
    _id: await db.nextId('orders'),
    name: name.trim(),
    phone: phone.trim(),
    phone_norm: normalizePhone(phone),
    order_type: orderType,
    table_number: tableNumber,
    address: str(address),
    items: lines,
    total,
    notes: str(notes),
    status: 'pending',
    payment_method,
    payment_status: payment_method === 'upi' ? 'claimed' : 'unpaid',
    payment_ref: paymentRef,
    customer_id: loggedIn ? loggedIn.id : null,
    linked_by_phone: 0,
    claim_token: claimToken,
    created_at: db.nowSql(),
  };
  try {
    await db.orders.insertOne(doc);
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json(UTR_REUSED);   // the same UTR arrived twice at once
    throw err;
  }

  const order = publicOrder(doc);
  const emailResult = await sendOrderEmail(order);
  res.status(201).json({ message: 'Order received', order, emailSent: emailResult.sent, claim_token: claimToken });
}));

// List orders — admin only (newest first)
app.get('/api/orders', requireAdmin, wrap(async (req, res) => {
  const rows = await db.orders.find({}).sort({ _id: -1 }).limit(1000).toArray();
  res.json(rows.map(publicOrder));
}));

// Update an order's status (e.g. preparing / ready / delivered / cancelled) — admin only
app.patch('/api/orders/:id', requireAdmin, wrap(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'ready', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  }
  const id = idParam(req);
  const result = id && await db.orders.updateOne({ _id: id }, { $set: { status } });
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrder(await db.orders.findOne({ _id: id })));
}));

// Owner marks a UPI order as paid (after checking their UPI app) — admin only
app.patch('/api/orders/:id/payment-status', requireAdmin, wrap(async (req, res) => {
  const { payment_status } = req.body;
  if (!['unpaid', 'claimed', 'paid'].includes(payment_status)) {
    return res.status(400).json({ error: 'payment_status must be unpaid, claimed or paid' });
  }
  const id = idParam(req);
  const result = id && await db.orders.updateOne({ _id: id }, { $set: { payment_status } });
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrder(await db.orders.findOne({ _id: id })));
}));

// =====================================================================
// CONTENT API — lets the admin edit site text, menu, gallery and news
// from the admin panel, no code changes needed. Public GET endpoints
// are read by the website itself on every page load; the write
// endpoints below are admin-only.
// =====================================================================

// ---------- settings (hero text, about text, contact info, footer) ----------
async function allSettings() {
  const rows = await db.settings.find({}).toArray();
  const settings = {};
  rows.forEach((r) => (settings[r._id] = r.value));
  return settings;
}

app.get('/api/content/settings', wrap(async (req, res) => {
  const settings = await allSettings();
  if (!(settings.upi_id || '').trim() && process.env.UPI_ID) settings.upi_id = process.env.UPI_ID;
  if (!(settings.upi_name || '').trim() && process.env.UPI_NAME) settings.upi_name = process.env.UPI_NAME;
  res.json(settings);
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'Body must be an object of key/value pairs' });
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z0-9_]{1,60}$/.test(key)) return res.status(400).json({ error: 'Invalid setting name: ' + key });
    // site photos (hero/about/dining): delete the old uploaded photo when it is replaced
    if (/_image2?$/.test(key)) {
      const old = await db.settings.findOne({ _id: key });
      if (old && old.value !== String(value)) removeUploadedFile(old.value);
    }
    await db.settings.updateOne({ _id: key }, { $set: { value: String(value) } }, { upsert: true });
  }
  res.json(await allSettings());
}));

// ---------- menu items ----------
app.get('/api/content/menu', wrap(async (req, res) => {
  const rows = await db.menu.find({}).sort({ category: 1, sort_order: 1, _id: 1 }).toArray();
  res.json(rows.map(db.toApi));
}));

function validateMenuItem(body) {
  const errors = [];
  if (!body.category || typeof body.category !== 'string') errors.push('category is required');
  if (!body.name || typeof body.name !== 'string') errors.push('name is required');
  if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0) errors.push('price must be a non-negative number');
  return errors;
}

app.post('/api/admin/menu', requireAdmin, wrap(async (req, res) => {
  const errors = validateMenuItem(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid item', details: errors });
  const { category, name, description, price, sort_order, image_url } = req.body;
  const doc = {
    _id: await db.nextId('menu_items'), category: str(category), name: str(name), description: str(description),
    price, image_url: str(image_url), available: 1, sort_order: Number(sort_order) || 0, created_at: db.nowSql(),
  };
  await db.menu.insertOne(doc);
  res.status(201).json(db.toApi(doc));
}));

app.put('/api/admin/menu/:id', requireAdmin, wrap(async (req, res) => {
  const errors = validateMenuItem(req.body);
  if (errors.length) return res.status(400).json({ error: 'Invalid item', details: errors });
  const id = idParam(req);
  const existing = id && await db.menu.findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Menu item not found' });
  const { category, name, description, price, sort_order, image_url } = req.body;
  const newImage = image_url === undefined ? existing.image_url || '' : str(image_url);
  if (newImage !== (existing.image_url || '')) removeUploadedFile(existing.image_url);
  await db.menu.updateOne({ _id: id }, { $set: {
    category: str(category), name: str(name), description: str(description), price, image_url: newImage, sort_order: Number(sort_order) || 0,
  } });
  res.json(db.toApi(await db.menu.findOne({ _id: id })));
}));

// Switch a single menu item between available / unavailable — admin only
app.patch('/api/admin/menu/:id/availability', requireAdmin, wrap(async (req, res) => {
  if (typeof req.body.available !== 'boolean') {
    return res.status(400).json({ error: 'available must be true or false' });
  }
  const id = idParam(req);
  const result = id && await db.menu.updateOne({ _id: id }, { $set: { available: req.body.available ? 1 : 0 } });
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Menu item not found' });
  res.json(db.toApi(await db.menu.findOne({ _id: id })));
}));

app.delete('/api/admin/menu/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const row = id && await db.menu.findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Menu item not found' });
  removeUploadedFile(row.image_url);
  await db.menu.deleteOne({ _id: id });
  res.json({ deleted: true });
}));

// ---------- photo upload (admin picks a file from their device) ----------
// Receives one image as a base64 data URL, saves it in MongoDB and returns the public
// path (e.g. /uploads/ab12cd.jpg) to store in the gallery / menu / news.
app.post('/api/admin/upload', requireAdmin, express.json({ limit: '12mb' }), wrap(async (req, res) => {
  const { data } = req.body || {};
  const match = typeof data === 'string' && data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match || !UPLOAD_TYPES[match[1]]) {
    return res.status(400).json({ error: 'Please upload a JPG, PNG, WEBP or GIF image.' });
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'Image must be smaller than 8 MB.' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  await db.uploads.insertOne({ _id: id, contentType: match[1], size: buffer.length, data: buffer, created_at: db.nowSql() });
  res.status(201).json({ url: '/uploads/' + id + UPLOAD_TYPES[match[1]] });
}));

// ---------- gallery images ----------
app.get('/api/content/gallery', wrap(async (req, res) => {
  const rows = await db.gallery.find({}).sort({ sort_order: 1, _id: 1 }).toArray();
  res.json(rows.map(db.toApi));
}));

app.post('/api/admin/gallery', requireAdmin, wrap(async (req, res) => {
  const { image_url, caption, sort_order } = req.body;
  if (!image_url || typeof image_url !== 'string') {
    return res.status(400).json({ error: 'image_url is required' });
  }
  const doc = { _id: await db.nextId('gallery_images'), image_url: str(image_url), caption: str(caption), sort_order: Number(sort_order) || 0, created_at: db.nowSql() };
  await db.gallery.insertOne(doc);
  res.status(201).json(db.toApi(doc));
}));

app.put('/api/admin/gallery/:id', requireAdmin, wrap(async (req, res) => {
  const { image_url, caption, sort_order } = req.body;
  if (!image_url || typeof image_url !== 'string') {
    return res.status(400).json({ error: 'image_url is required' });
  }
  const id = idParam(req);
  const result = id && await db.gallery.updateOne({ _id: id }, { $set: { image_url: str(image_url), caption: str(caption), sort_order: Number(sort_order) || 0 } });
  if (!result || result.matchedCount === 0) return res.status(404).json({ error: 'Image not found' });
  res.json(db.toApi(await db.gallery.findOne({ _id: id })));
}));

app.delete('/api/admin/gallery/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const row = id && await db.gallery.findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Image not found' });
  removeUploadedFile(row.image_url);
  await db.gallery.deleteOne({ _id: id });
  res.json({ deleted: true });
}));

// ---------- news posts ----------
app.get('/api/content/news', wrap(async (req, res) => {
  const rows = await db.news.find({}).sort({ sort_order: 1, _id: 1 }).toArray();
  res.json(rows.map(db.toApi));
}));

app.post('/api/admin/news', requireAdmin, wrap(async (req, res) => {
  const { title, excerpt, image_url, date_label, link, sort_order } = req.body;
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  const doc = {
    _id: await db.nextId('news_posts'), title: str(title), excerpt: str(excerpt), image_url: str(image_url),
    date_label: str(date_label), link: str(link), sort_order: Number(sort_order) || 0, created_at: db.nowSql(),
  };
  await db.news.insertOne(doc);
  res.status(201).json(db.toApi(doc));
}));

app.put('/api/admin/news/:id', requireAdmin, wrap(async (req, res) => {
  const { title, excerpt, image_url, date_label, link, sort_order } = req.body;
  if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
  const id = idParam(req);
  const existing = id && await db.news.findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: 'Post not found' });
  if (str(image_url) !== (existing.image_url || '')) removeUploadedFile(existing.image_url);
  await db.news.updateOne({ _id: id }, { $set: {
    title: str(title), excerpt: str(excerpt), image_url: str(image_url), date_label: str(date_label), link: str(link), sort_order: Number(sort_order) || 0,
  } });
  res.json(db.toApi(await db.news.findOne({ _id: id })));
}));

app.delete('/api/admin/news/:id', requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const row = id && await db.news.findOne({ _id: id });
  if (!row) return res.status(404).json({ error: 'Post not found' });
  removeUploadedFile(row.image_url);
  await db.news.deleteOne({ _id: id });
  res.json({ deleted: true });
}));

// ---------- anything that goes wrong inside a route ----------
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, '-', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(err && err.status ? err.status : 500).json({ error: 'Something went wrong on our side. Please try again in a moment.' });
});

// ---------- start: connect to MongoDB first, then listen ----------
const PORT = process.env.PORT || 4000;
const ready = db.connect().then(() => new Promise((resolve) => {
  app.listen(PORT, () => {
    console.log(`Musafir Cafe API running on http://localhost:${PORT}  (MongoDB connected)`);
    resolve();
  });
}));
ready.catch((err) => {
  console.error('\nCould not start the server: ' + err.message + '\n');
  process.exit(1);
});

module.exports = { app, ready };
