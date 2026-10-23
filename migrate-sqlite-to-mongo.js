// migrate-sqlite-to-mongo.js — copies your OLD database (reservations.db, made by the previous
// version of this backend) into MongoDB. Run it ONCE, on your own computer:
//
//     npm install            (this also installs better-sqlite3, which is only needed here)
//     node migrate-sqlite-to-mongo.js                      (uses ./reservations.db and ./uploads)
//     node migrate-sqlite-to-mongo.js path/to/reservations.db
//
// What is copied: site text, menu (with prices, availability, photos), gallery, news, customers
// (their PINs keep working), orders, bookings, and the photos uploaded from the admin panel.
// Customers who were logged in on their phones will have to log in once more.
//
// If MongoDB already has data (for example you started the new server once and it added the
// starting content), the script stops so nothing is overwritten by mistake. To replace what is
// in MongoDB with your old data, add  --replace  at the end.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const dbPath = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'reservations.db'));
const uploadsDir = path.join(path.dirname(dbPath), 'uploads');

function openSqlite() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error('The "better-sqlite3" package is missing. Run:  npm install better-sqlite3   and try again.');
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Could not find your old database file at ${dbPath}\nPut reservations.db next to this script, or give its path:  node migrate-sqlite-to-mongo.js path/to/reservations.db`);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

// rows of a table; a table that does not exist in an older database simply gives nothing
function rows(sqlite, table) {
  try { return sqlite.prepare(`SELECT * FROM ${table}`).all(); } catch (e) { return []; }
}
const text = (v) => (v == null ? '' : String(v));
const orNull = (v) => (v == null || v === '' ? null : v);

async function main() {
  const sqlite = openSqlite();
  await db.connect({ seed: false });

  const targets = [
    ['settings', db.settings], ['menu_items', db.menu], ['gallery_images', db.gallery], ['news_posts', db.news],
    ['reservations', db.reservations], ['orders', db.orders], ['customers', db.customers], ['uploads', db.uploads],
  ];
  const existing = [];
  for (const [name, col] of targets) {
    const n = await col.countDocuments({});
    if (n > 0) existing.push(`${name} (${n})`);
  }
  if (existing.length && !replace) {
    console.log('\nMongoDB already contains data: ' + existing.join(', '));
    console.log('Nothing was changed. To replace it with your old database, run again with  --replace\n');
    return;
  }
  if (replace) {
    for (const [, col] of targets) await col.deleteMany({});
    await db.sessions.deleteMany({});
    await db.counters.deleteMany({});
  }

  const counts = {};
  const maxId = {};
  async function copy(table, collection, counterName, build) {
    const list = rows(sqlite, table);
    const docs = list.map(build);
    if (docs.length) await collection.insertMany(docs);
    counts[table] = docs.length;
    maxId[counterName] = docs.reduce((m, d) => Math.max(m, typeof d._id === 'number' ? d._id : 0), 0);
  }

  await copy('settings', db.settings, 'settings', (r) => ({ _id: r.key, value: text(r.value) }));

  await copy('menu_items', db.menu, 'menu_items', (r) => ({
    _id: r.id, category: text(r.category), name: text(r.name), description: text(r.description), price: Number(r.price) || 0,
    image_url: text(r.image_url), available: r.available === 0 ? 0 : 1, sort_order: Number(r.sort_order) || 0, created_at: text(r.created_at),
  }));

  await copy('gallery_images', db.gallery, 'gallery_images', (r) => ({
    _id: r.id, image_url: text(r.image_url), caption: text(r.caption), sort_order: Number(r.sort_order) || 0, created_at: text(r.created_at),
  }));

  await copy('news_posts', db.news, 'news_posts', (r) => ({
    _id: r.id, title: text(r.title), excerpt: text(r.excerpt), image_url: text(r.image_url), date_label: text(r.date_label),
    link: text(r.link), sort_order: Number(r.sort_order) || 0, created_at: text(r.created_at),
  }));

  await copy('customers', db.customers, 'customers', (r) => ({
    _id: r.id, name: text(r.name), phone: text(r.phone), pin_salt: text(r.pin_salt), pin_hash: text(r.pin_hash),
    failed_attempts: Number(r.failed_attempts) || 0, locked_until: orNull(r.locked_until), created_at: text(r.created_at),
  }));

  await copy('reservations', db.reservations, 'reservations', (r) => ({
    _id: r.id, name: text(r.name), phone: text(r.phone), phone_norm: db.normalizePhone(r.phone), date: text(r.date), time: text(r.time),
    guests: text(r.guests), message: text(r.message), status: text(r.status) || 'pending',
    customer_id: r.customer_id == null ? null : Number(r.customer_id), created_at: text(r.created_at),
  }));

  // a UPI reference may only appear once; if an old database has a repeat, keep it on the first order only
  const seenRefs = new Set();
  await copy('orders', db.orders, 'orders', (r) => {
    let items = [];
    try { items = JSON.parse(r.items); } catch (e) { items = []; }
    let ref = orNull(r.payment_ref);
    let notes = text(r.notes);
    if (ref !== null) {
      ref = String(ref);
      if (seenRefs.has(ref)) { notes = (notes + ' (UPI reference repeated: ' + ref + ')').trim(); ref = null; }
      else seenRefs.add(ref);
    }
    return {
      _id: r.id, name: text(r.name), phone: text(r.phone), phone_norm: db.normalizePhone(r.phone),
      order_type: text(r.order_type) || 'pickup', table_number: orNull(r.table_number), address: text(r.address),
      items: Array.isArray(items) ? items : [], total: Number(r.total) || 0, notes, status: text(r.status) || 'pending',
      payment_method: text(r.payment_method) || 'cash', payment_status: text(r.payment_status) || 'unpaid', payment_ref: ref,
      customer_id: r.customer_id == null ? null : Number(r.customer_id), linked_by_phone: 0,
      claim_token: orNull(r.claim_token), created_at: text(r.created_at),
    };
  });

  // photos uploaded from the admin panel used to be files in the "uploads" folder
  let photos = 0;
  if (fs.existsSync(uploadsDir)) {
    const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    for (const file of fs.readdirSync(uploadsDir)) {
      const m = file.match(/^([a-f0-9]{8,64})\.(jpg|jpeg|png|webp|gif)$/i);
      if (!m) continue;
      const data = fs.readFileSync(path.join(uploadsDir, file));
      await db.uploads.insertOne({ _id: m[1].toLowerCase(), contentType: types[m[2].toLowerCase()], size: data.length, data, created_at: db.nowSql() });
      photos++;
    }
  }
  counts.uploaded_photos = photos;

  // new records must continue after the highest old id
  for (const [name, last] of Object.entries(maxId)) {
    if (name !== 'settings' && last > 0) await db.counters.updateOne({ _id: name }, { $set: { seq: last } }, { upsert: true });
  }

  console.log('\nDone. Copied into MongoDB:');
  for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(16)} ${n}`);
  console.log('\nYou can now start the new backend with  npm start.\n');
}

main()
  .then(() => db.client && db.client.close())
  .catch((err) => {
    console.error('\nMigration stopped: ' + err.message + '\n');
    process.exit(1);
  });
