// db.js — the MongoDB database layer for Musafir Cafe.
//
// Connects to MongoDB (e.g. a free MongoDB Atlas cluster), creates the indexes it needs,
// and fills in the website's starting content the first time it runs.
//
// Needs one setting in .env:   MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/
//
// Ids: every record keeps a simple whole-number id (1, 2, 3 ...), exactly like before, so the
// website and the admin panel work unchanged. The number is stored as the record's _id.

const { MongoClient } = require('mongodb');

const db = {};

// ---------- small helpers used by server.js ----------

// "2026-10-18 09:30:00" (UTC) — the same text format the website already understands
db.nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// a stored record -> what the website receives:  _id becomes id
db.toApi = (doc) => {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
};

// accepts 98765 43210, +91 98765 43210, 098765 43210 ... returns the 10 digits, or null
db.normalizePhone = (input) => {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};

// next whole-number ids for a collection (1, 2, 3 ...). Safe even if two requests arrive together.
db.nextIds = async (name, count = 1) => {
  const result = await db.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = result && result.value !== undefined ? result.value : result;   // works with old and new driver versions
  const last = doc.seq;
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
};
db.nextId = async (name) => (await db.nextIds(name, 1))[0];

db.ping = async () => {
  await db.database.command({ ping: 1 });
  return true;
};

// ---------- connect ----------
db.connect = async function connect({ seed = true } = {}) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is missing. Add your MongoDB connection string to the .env file (see .env.example).');
  }
  db.client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await db.client.connect();
  db.database = db.client.db(process.env.MONGODB_DB || 'musafir_cafe');

  const c = (name) => db.database.collection(name);
  db.settings = c('settings');            // _id = setting name, value = text
  db.menu = c('menu_items');
  db.gallery = c('gallery_images');
  db.news = c('news_posts');
  db.reservations = c('reservations');
  db.orders = c('orders');
  db.customers = c('customers');
  db.sessions = c('sessions');
  db.uploads = c('uploads');              // photos uploaded from the admin panel (kept in the database, so they survive redeploys)
  db.counters = c('counters');

  await createIndexes();
  if (seed) await seedFirstRun();
  return db;
};

async function createIndexes() {
  await db.customers.createIndex({ phone: 1 }, { unique: true });
  await db.orders.createIndex({ customer_id: 1, _id: -1 });
  await db.orders.createIndex({ phone_norm: 1 });
  // a UPI reference (UTR) can only ever be used for one order (cash orders have no reference)
  await db.orders.createIndex({ payment_ref: 1 }, { unique: true, partialFilterExpression: { payment_ref: { $type: 'string' } } });
  await db.reservations.createIndex({ customer_id: 1, _id: -1 });
  await db.reservations.createIndex({ phone_norm: 1 });
  await db.sessions.createIndex({ customer_id: 1 });
  await db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });   // MongoDB removes expired logins by itself
  await db.menu.createIndex({ category: 1, sort_order: 1, _id: 1 });
  await db.menu.createIndex({ name: 1 });
}

// ---------- first run: give the website its starting content ----------
// Only runs when a collection is empty. Everything here can be edited or deleted from the
// admin panel afterwards.
async function seedFirstRun() {
  if ((await db.settings.countDocuments({})) === 0) {
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
    await db.settings.insertMany(Object.entries(defaults).map(([key, value]) => ({ _id: key, value })));
  }

  if ((await db.menu.countDocuments({})) === 0) {
    const rows = [
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
    const ids = await db.nextIds('menu_items', rows.length);
    const now = db.nowSql();
    await db.menu.insertMany(rows.map(([category, name, description, price, sort_order], i) => ({
      _id: ids[i], category, name, description, price, image_url: '', available: 1, sort_order, created_at: now,
    })));
  }

  if ((await db.gallery.countDocuments({})) === 0) {
    const images = [
      ['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=500&q=80', 'Evening chai ritual'],
      ['https://images.unsplash.com/photo-1445116572660-236099ec97a0?auto=format&fit=crop&w=500&q=80', 'The reading corner'],
      ['https://images.unsplash.com/photo-1554118811-1e0d58224f24?auto=format&fit=crop&w=500&q=80', "Today's fusion plate"],
      ['https://images.unsplash.com/photo-1447933601403-0c6688de566e?auto=format&fit=crop&w=500&q=80', 'Golden hour by the window'],
      ['https://images.unsplash.com/photo-1509785307050-d4066910ec1e?auto=format&fit=crop&w=500&q=80', 'Filter coffee, always fresh'],
      ['https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=500&q=80', 'Friday evenings, full tables'],
      ['https://images.unsplash.com/photo-1481833761820-0509d3217039?auto=format&fit=crop&w=500&q=80', 'The chaat platter, shared'],
      ['https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=500&q=80', 'A quiet hour, alone'],
      ['https://images.unsplash.com/photo-1522992319-0365e5f11656?auto=format&fit=crop&w=500&q=80', 'Fresh from the counter'],
    ];
    const ids = await db.nextIds('gallery_images', images.length);
    const now = db.nowSql();
    await db.gallery.insertMany(images.map(([image_url, caption], i) => ({
      _id: ids[i], image_url, caption, sort_order: i + 1, created_at: now,
    })));
  }

  if ((await db.news.countDocuments({})) === 0) {
    const posts = [
      ['Our new filter coffee is here', 'A stronger, smoother blend has joined the menu — sourced fresh and brewed the traditional way, every morning.', 'https://images.unsplash.com/photo-1509785307050-d4066910ec1e?auto=format&fit=crop&w=500&q=80', 'Sep 2026', 'menu.html'],
      ['The Musafir Chaat Platter is back', 'A guest favorite returns for the season — tangy, crunchy, and best shared across the table.', 'https://images.unsplash.com/photo-1481833761820-0509d3217039?auto=format&fit=crop&w=500&q=80', 'Aug 2026', 'menu.html'],
      ['Evenings just got cozier', "We've added a few extra low-lit corners for evening chai and long, unhurried conversations.", 'https://images.unsplash.com/photo-1521017432531-fbd92d768814?auto=format&fit=crop&w=500&q=80', 'Jul 2026', 'gallery.html'],
    ];
    const ids = await db.nextIds('news_posts', posts.length);
    const now = db.nowSql();
    await db.news.insertMany(posts.map(([title, excerpt, image_url, date_label, link], i) => ({
      _id: ids[i], title, excerpt, image_url, date_label, link, sort_order: i + 1, created_at: now,
    })));
  }
}

module.exports = db;
