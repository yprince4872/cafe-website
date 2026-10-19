// db.js — sets up a local SQLite database file (reservations.db) and the
// reservations table. better-sqlite3 is synchronous and file-based, so
// there's nothing extra to install or run — the .db file is created
// automatically next to this script the first time the server starts.

const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'reservations.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    guests TEXT NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'pickup',
    address TEXT,
    items TEXT NOT NULL,
    total REAL NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- key/value store for editable site text (hero, about, contact, footer...)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image_url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS gallery_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT NOT NULL,
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS news_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    excerpt TEXT,
    image_url TEXT,
    date_label TEXT,
    link TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------- upgrade older databases ----------
// Databases created before menu photos existed don't have the image_url
// column yet. Add it once, keeping all existing data.
const menuColumns = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
if (!menuColumns.includes('image_url')) {
  db.exec('ALTER TABLE menu_items ADD COLUMN image_url TEXT');
}

// Adds a column to an existing table if it isn't there yet (keeps all data).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// per-item "unavailable" switch (1 = available, 0 = unavailable)
addColumnIfMissing('menu_items', 'available', 'INTEGER NOT NULL DEFAULT 1');
// UPI payment tracking on orders
addColumnIfMissing('orders', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'");
addColumnIfMissing('orders', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'");
addColumnIfMissing('orders', 'payment_ref', 'TEXT');
addColumnIfMissing('orders', 'pay_token', 'TEXT');
// dine-in orders carry the customer's table number
addColumnIfMissing('orders', 'table_number', 'TEXT');

// ---------- customer accounts (login with mobile number + 6-digit PIN) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    pin_salt TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- a logged-in phone keeps a random token; only its hash is stored here
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);
// orders / reservations made while logged in belong to that customer
addColumnIfMissing('orders', 'customer_id', 'INTEGER');
addColumnIfMissing('orders', 'claim_token', 'TEXT');     // lets a guest's earlier orders be attached after they log in on the same phone
addColumnIfMissing('reservations', 'customer_id', 'INTEGER');

// ---------- one-time seed, only runs if tables are empty ----------
// This gives the admin a working website on first run instead of a blank
// one. Every value seeded here can be edited or deleted from the admin
// panel afterwards — this just fills in what's already live today.

const settingsCount = db.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
if (settingsCount === 0) {
  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  const defaults = {
    hero_badge: 'EST. MORADABAD',
    hero_title: 'Warmth & memories, one cup at a time',
    hero_lede: "Musafir means traveler — and every journey deserves a peaceful pause. Come sip a fresh coffee or evening chai, and let a quiet corner find you here.",
    about_heading: 'Welcome, whoever you are',
    about_text1: "Whether you're a student preparing for what's next, a professional catching a peaceful break, a family spending time together, or a traveler passing through — Musafir Cafe opens its doors with the same warmth for everyone.",
    about_text2: "We believe some of life's best conversations happen over a steaming cup of tea or fresh coffee. Every table here has seen its share of laughter, dreams and reunions — and every sip is meant to feel like a small comfort.",
    mission_text: "We don't just serve beverages — we serve experiences that stay with you long after you've left. Because Musafir Cafe isn't just a café, it's a place where every traveler finds a pause, every heart finds a little peace, and every cup creates a memory.",
    footer_tagline: "At Musafir Cafe, we don't just serve food and coffee — we create moments where every traveler finds comfort, every conversation becomes a memory, and every visit feels like coming home.",
    contact_address: 'Moradabad, Uttar Pradesh 244001, India',
    contact_phone: '+91 7248315496',
    contact_email: 'yprince4872@gmail.com',
  };
  for (const [key, value] of Object.entries(defaults)) insertSetting.run(key, value);
}

const menuCount = db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c;
if (menuCount === 0) {
  const insertItem = db.prepare(`
    INSERT INTO menu_items (category, name, description, price, sort_order) VALUES (?, ?, ?, ?, ?)
  `);
  const items = [
    ['coffee', 'Musafir Signature Chai', 'Slow-brewed with cardamom, ginger and a hint of jaggery.', 60, 1],
    ['coffee', 'Moradabad Kulhad Chai', 'Served in a traditional clay cup, the local way.', 70, 2],
    ['coffee', 'Filter Coffee', 'Freshly brewed, strong and smooth, no shortcuts taken.', 90, 3],
    ['coffee', 'Cappuccino', 'Silky microfoam over a double shot of espresso.', 130, 4],
    ['coffee', 'Cold Brew', 'Steeped for 18 hours, served over ice, gently sweetened.', 150, 5],
    ['coffee', 'Masala Lemon Tea', 'Bright, tangy and lightly spiced — a Musafir favorite.', 65, 6],
    ['snacks', 'Moradabad Kachori Sabzi', 'Flaky kachori with a warmly spiced potato curry.', 110, 1],
    ['snacks', 'Musafir Chaat Platter', 'A little of everything tangy, crunchy and sweet.', 140, 2],
    ['snacks', 'Cheese Loaded Nachos', 'Crisp nachos under a blanket of melted cheese and salsa.', 180, 3],
    ['snacks', 'Veg Cheese Sandwich', 'Grilled golden, stuffed generously, served with chutney.', 120, 4],
    ['snacks', 'Peri Peri Fries', 'Hand-cut fries tossed in a fiery peri peri seasoning.', 100, 5],
    ['snacks', 'Paneer Tikka Roll', 'Smoky grilled paneer rolled in a soft paratha.', 150, 6],
    ['mains', 'Musafir Special Pizza', 'Wood-fired base, house sauce, a stack of fresh toppings.', 250, 1],
    ['mains', 'Fusion Alfredo Pasta', 'Creamy alfredo with an Indian-spiced finish.', 220, 2],
    ['mains', 'Musafir Burger', 'A hearty veg patty, melted cheese, house sauce.', 180, 3],
    ['mains', 'Paneer Fried Rice Bowl', 'Wok-tossed rice, spiced paneer, crunchy vegetables.', 190, 4],
    ['sweets', 'Moradabad Malaiyyo', 'Seasonal, cloud-light and saffron-scented — when available.', 120, 1],
    ['sweets', 'Chocolate Lava Cake', 'Warm, gooey centre with a scoop of vanilla on the side.', 140, 2],
    ['sweets', 'Musafir Cold Coffee', 'Blended thick, topped with ice cream and chocolate shavings.', 160, 3],
    ['sweets', 'Rose Falooda', 'Layers of vermicelli, jelly, rose syrup and ice cream.', 150, 4],
  ];
  for (const row of items) insertItem.run(...row);
}

const galleryCount = db.prepare('SELECT COUNT(*) AS c FROM gallery_images').get().c;
if (galleryCount === 0) {
  const insertImg = db.prepare('INSERT INTO gallery_images (image_url, caption, sort_order) VALUES (?, ?, ?)');
  const images = [
    ['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=500&q=80', 'Evening chai ritual', 1],
    ['https://images.unsplash.com/photo-1445116572660-236099ec97a0?auto=format&fit=crop&w=500&q=80', 'The reading corner', 2],
    ['https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&w=500&q=80', "Today's fusion plate", 3],
    ['https://images.unsplash.com/photo-1447933601403-0c6688de566e?auto=format&fit=crop&w=500&q=80', 'Golden hour by the window', 4],
    ['https://images.unsplash.com/photo-1509785307050-d4066910ec1e?auto=format&fit=crop&w=500&q=80', 'Filter coffee, always fresh', 5],
    ['https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=500&q=80', 'Friday evenings, full tables', 6],
    ['https://images.unsplash.com/photo-1481833761820-0509d3217039?auto=format&fit=crop&w=500&q=80', 'The chaat platter, shared', 7],
    ['https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=500&q=80', 'A quiet hour, alone', 8],
    ['https://images.unsplash.com/photo-1522992319-0365e5f11656?auto=format&fit=crop&w=500&q=80', 'Fresh from the counter', 9],
  ];
  for (const row of images) insertImg.run(...row);
}

const newsCount = db.prepare('SELECT COUNT(*) AS c FROM news_posts').get().c;
if (newsCount === 0) {
  const insertPost = db.prepare(`
    INSERT INTO news_posts (title, excerpt, image_url, date_label, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const posts = [
    ['Our new filter coffee is here', 'A stronger, smoother blend has joined the menu — sourced fresh and brewed the traditional way, every morning.', 'https://images.unsplash.com/photo-1509785307050-d4066910ec1e?auto=format&fit=crop&w=500&q=80', 'Sep 2026', 'menu.html', 1],
    ['The Musafir Chaat Platter is back', 'A guest favorite returns for the season — tangy, crunchy, and best shared across the table.', 'https://images.unsplash.com/photo-1481833761820-0509d3217039?auto=format&fit=crop&w=500&q=80', 'Aug 2026', 'menu.html', 2],
    ['Evenings just got cozier', "We've added a few extra low-lit corners for evening chai and long, unhurried conversations.", 'https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=500&q=80', 'Jul 2026', 'gallery.html', 3],
  ];
  for (const row of posts) insertPost.run(...row);
}

module.exports = db;
