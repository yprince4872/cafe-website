// account.js — the "My account" page (account.html).
// Needs script.js first: API_URL, getSession / setSession / clearSession, authHeaders, claimGuestOrders,
// getCart / saveCart.

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const show = (el, on) => el.classList.toggle('is-hidden', !on);

  const authBox = $('authBox');
  const accountBox = $('accountBox');

  function say(el, text, isError) {
    el.textContent = text;
    el.className = 'form-msg show' + (isError ? ' error' : ' ok');
  }

  async function api(path, options) {
    const opts = Object.assign({}, options);
    opts.headers = authHeaders(opts.body ? { 'Content-Type': 'application/json' } : {});
    const res = await fetch(API_URL + path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && getSession() && path.startsWith('/api/account/') && !path.includes('login') && !path.includes('change-pin')) {
      clearSession();            // the saved login has expired
      render();
      throw new Error('Please log in again.');
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- which screen ----------
  function render() {
    const session = getSession();
    show(authBox, !session);
    show(accountBox, !!session);
    if (!session) document.querySelector('.auth-tab[data-auth="login"]').click();   // logged-out screen always starts on "Log in"
    $('pageTitle').textContent = session ? 'My orders' : 'Log in to see your orders';
    $('pageSub').textContent = session
      ? 'Everything you have ordered and booked with us, including earlier orders made with your mobile number.'
      : 'Use your mobile number and a 6-digit PIN. All your past orders and bookings are kept here.';
    if (session) {
      document.querySelector('.acct-tab[data-acct="orders"]').click();     // always start on "My orders"
      $('acctName').textContent = 'Hello, ' + session.customer.name;
      $('acctPhoneLine').textContent = '+91 ' + session.customer.phone;
      loadOrders();
      loadBookings();
    }
  }

  // ---------- log in / create account ----------
  document.querySelectorAll('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      show($('loginForm'), tab.dataset.auth === 'login');
      show($('signupForm'), tab.dataset.auth === 'signup');
    });
  });

  async function finishLogin(data, button, label) {
    setSession({ token: data.token, customer: data.customer });
    await claimGuestOrders();       // orders placed earlier on this phone join the account
    button.disabled = false; button.textContent = label;
    render();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginBtn'), msg = $('loginMsg');
    const phone = $('loginPhone').value, pin = $('loginPin').value;
    if (!phone.trim() || !/^\d{6}$/.test(pin)) { say(msg, 'Please enter your mobile number and your 6-digit PIN.', true); return; }
    btn.disabled = true; btn.textContent = 'Logging in...'; msg.className = 'form-msg';
    try {
      const data = await api('/api/account/login', { method: 'POST', body: JSON.stringify({ phone, pin }) });
      $('loginPin').value = '';
      await finishLogin(data, btn, 'Log in');
    } catch (err) {
      say(msg, err.message === 'Failed to fetch' ? 'Could not reach the server. Please try again.' : err.message, true);
      btn.disabled = false; btn.textContent = 'Log in';
    }
  });

  $('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('signupBtn'), msg = $('signupMsg');
    const name = $('signupName').value, phone = $('signupPhone').value, pin = $('signupPin').value;
    if (name.trim().length < 2) { say(msg, 'Please enter your name.', true); return; }
    if (!phone.trim()) { say(msg, 'Please enter your mobile number.', true); return; }
    if (!/^\d{6}$/.test(pin)) { say(msg, 'The PIN must be exactly 6 digits.', true); return; }
    if (pin !== $('signupPin2').value) { say(msg, 'The two PINs do not match.', true); return; }
    btn.disabled = true; btn.textContent = 'Creating...'; msg.className = 'form-msg';
    try {
      const data = await api('/api/account/signup', { method: 'POST', body: JSON.stringify({ name, phone, pin }) });
      $('signupPin').value = ''; $('signupPin2').value = '';
      await finishLogin(data, btn, 'Create my account');
    } catch (err) {
      say(msg, err.message === 'Failed to fetch' ? 'Could not reach the server. Please try again.' : err.message, true);
      btn.disabled = false; btn.textContent = 'Create my account';
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('/api/account/logout', { method: 'POST', body: '{}' }); } catch (e) { /* log out on this phone anyway */ }
    clearSession();
    searchBox.value = '';
    render();
  });

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('pinMsg');
    const old_pin = $('oldPin').value, new_pin = $('newPin').value;
    if (!/^\d{6}$/.test(old_pin) || !/^\d{6}$/.test(new_pin)) { say(msg, 'Both PINs must be exactly 6 digits.', true); return; }
    try {
      await api('/api/account/change-pin', { method: 'POST', body: JSON.stringify({ old_pin, new_pin }) });
      $('oldPin').value = ''; $('newPin').value = '';
      say(msg, '✓ Your PIN has been changed.', false);
    } catch (err) { say(msg, err.message, true); }
  });

  // ---------- history ----------
  function when(iso) {
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  const STATUS = {
    pending: ['Received', 'st-pending'], preparing: ['Being prepared', 'st-preparing'], ready: ['Ready', 'st-ready'],
    delivered: ['Delivered', 'st-delivered'], cancelled: ['Cancelled', 'st-cancelled'],
    confirmed: ['Confirmed', 'st-ready'],
  };
  function pill(status) {
    const [label, cls] = STATUS[status] || [status, 'st-pending'];
    return `<span class="acct-pill ${cls}">${esc(label)}</span>`;
  }

  function payText(o) {
    if (o.payment_method === 'upi') {
      if (o.payment_status === 'paid') return 'Paid by UPI ✓';
      if (o.payment_status === 'claimed') return 'UPI payment is being checked';
      return 'UPI payment pending';
    }
    return 'Pay at cafe / on delivery';
  }
  function whereText(o) {
    if (o.order_type === 'dine-in') return '🪑 Dine-in' + (o.table_number ? ' · Table ' + o.table_number : '');
    if (o.order_type === 'delivery') return '🛵 Delivery' + (o.address ? ' · ' + o.address : '');
    return '🛍️ Pickup';
  }

  // ---------- search ----------
  let ordersCache = [];
  let bookingsCache = [];
  let currentTab = 'orders';

  // everything a customer might type to find an order (number, item, status, date, table, payment...)
  function orderText(o) {
    return [
      '#' + o.id, 'order ' + o.id, when(o.created_at), o.status, (STATUS[o.status] || [''])[0],
      whereText(o), payText(o), '₹' + o.total, o.total,
      (o.items || []).map((i) => i.name + ' ' + i.qty + 'x').join(' '), o.notes || '',
    ].join(' ').toLowerCase();
  }
  function bookingText(r) {
    return ['booking', r.guests, r.date, r.time, r.status, (STATUS[r.status] || [''])[0], r.message || ''].join(' ').toLowerCase();
  }
  // every word typed must be found (so "chai delivered" narrows down)
  function matches(text, query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));
  }

  const searchBox = $('acctSearch');
  function applySearch() {
    const query = searchBox.value.trim();
    show($('acctSearchClear'), query.length > 0);
    drawOrders(query);
    drawBookings(query);
    const list = currentTab === 'orders' ? ordersCache : bookingsCache;
    const total = list.length;
    const shown = currentTab === 'orders'
      ? ordersCache.filter((o) => !query || matches(orderText(o), query)).length
      : bookingsCache.filter((r) => !query || matches(bookingText(r), query)).length;
    const count = $('acctCount');
    show(count, !!query && total > 0);
    count.textContent = shown + ' of ' + total + ' ' + (currentTab === 'orders' ? 'orders' : 'bookings') + ' match "' + query + '"';
  }
  searchBox.addEventListener('input', applySearch);
  $('acctSearchClear').addEventListener('click', () => { searchBox.value = ''; applySearch(); searchBox.focus(); });

  async function loadOrders() {
    const box = $('ordersList');
    box.innerHTML = '<p class="acct-empty">Loading your orders…</p>';
    try {
      ordersCache = await api('/api/account/orders');
    } catch (err) { box.innerHTML = `<p class="acct-empty">${esc(err.message)}</p>`; return; }
    drawOrders(searchBox.value.trim());
  }

  function drawOrders(query) {
    const box = $('ordersList');
    if (!ordersCache.length) {
      box.innerHTML = '<p class="acct-empty">No orders yet. Orders you place while logged in will appear here.<br><a class="btn btn-primary" href="menu.html" style="margin-top:16px;">Browse the menu</a></p>';
      return;
    }
    const list = ordersCache.filter((o) => !query || matches(orderText(o), query));
    if (!list.length) {
      box.innerHTML = '<p class="acct-empty">No orders match your search.</p>';
      return;
    }
    box.innerHTML = list.map((o) => `
      <div class="acct-card">
        <div class="acct-card-top">
          <div><strong>Order #${esc(o.id)}</strong><span class="acct-when">${esc(when(o.created_at))}</span></div>
          ${pill(o.status)}
        </div>
        <div class="acct-where">${esc(whereText(o))}</div>
        <ul class="acct-items">
          ${(o.items || []).map((i) => `<li><span class="q">${esc(i.qty)}×</span> <span class="n">${esc(i.name)}</span></li>`).join('')}
        </ul>
        <div class="acct-foot">
          <div><div class="acct-total">₹${esc(o.total)}</div><div class="acct-pay">${esc(payText(o))}</div></div>
          <button type="button" class="btn btn-ghost acct-again" data-again="${esc(o.id)}">Order again</button>
        </div>
      </div>`).join('');
    box.querySelectorAll('[data-again]').forEach((b) => b.addEventListener('click', () => orderAgain(b)));
  }

  // puts the same items in the cart (at today's prices, skipping anything unavailable) and opens it
  async function orderAgain(button) {
    const order = ordersCache.find((o) => String(o.id) === button.dataset.again);
    if (!order) return;
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Adding…';
    try {
      const res = await fetch(API_URL + '/api/content/menu');
      const menu = await res.json();
      const cart = getCart();
      const skipped = [];
      (order.items || []).forEach((item) => {
        const now = menu.find((m) => m.name === item.name);
        if (!now || now.available === 0) { skipped.push(item.name); return; }
        const line = cart.find((c) => c.name === now.name);
        if (line) { line.qty += item.qty; line.price = now.price; }
        else cart.push({ name: now.name, price: now.price, qty: item.qty });
      });
      if (skipped.length === (order.items || []).length) {
        alert('Sorry, none of these items are available right now.');
        button.disabled = false; button.textContent = original;
        return;
      }
      saveCart(cart);
      if (skipped.length) alert('Added to your cart. These are not available right now, so they were left out:\n\n' + skipped.join('\n'));
      location.href = 'menu.html?cart=1';
    } catch (e) {
      alert('Could not load the menu. Please try again.');
      button.disabled = false; button.textContent = original;
    }
  }

  async function loadBookings() {
    const box = $('bookingsList');
    try {
      bookingsCache = await api('/api/account/reservations');
    } catch (err) { box.innerHTML = `<p class="acct-empty">${esc(err.message)}</p>`; return; }
    drawBookings(searchBox.value.trim());
  }

  function drawBookings(query) {
    const box = $('bookingsList');
    if (!bookingsCache.length) {
      box.innerHTML = '<p class="acct-empty">No bookings yet. Tables you book while logged in will appear here.</p>';
      return;
    }
    const list = bookingsCache.filter((r) => !query || matches(bookingText(r), query));
    box.innerHTML = list.length ? list.map((r) => `
      <div class="acct-card">
        <div class="acct-card-top">
          <div><strong>Table for ${esc(r.guests)}</strong><span class="acct-when">${esc(r.date)} at ${esc(r.time)}</span></div>
          ${pill(r.status)}
        </div>
        ${r.message ? `<div class="acct-where">Note: ${esc(r.message)}</div>` : ''}
      </div>`).join('')
      : '<p class="acct-empty">No bookings match your search.</p>';
  }

  document.querySelectorAll('.acct-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      currentTab = tab.dataset.acct;
      document.querySelectorAll('.acct-tab').forEach((t) => t.classList.toggle('active', t === tab));
      show($('ordersList'), currentTab === 'orders');
      show($('bookingsList'), currentTab === 'bookings');
      show($('settingsPane'), currentTab === 'settings');
      show($('listTools'), currentTab !== 'settings');
      searchBox.placeholder = currentTab === 'bookings'
        ? 'Search bookings — date, time, status…'
        : 'Search orders — item, order number, status, date…';
      if (currentTab === 'settings') show($('acctCount'), false); else applySearch();
    });
  });
  $('refreshBtn').addEventListener('click', () => { loadOrders(); loadBookings(); });
  // coming back to this page (e.g. from the payment app) shows the latest status
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getSession()) { loadOrders(); loadBookings(); } });

  // the cafe's phone number for the "forgot PIN" hint
  fetch(API_URL + '/api/content/settings').then((r) => r.json()).then((s) => {
    if (s.contact_phone) document.querySelectorAll('.acct-cafe-phone').forEach((el) => (el.textContent = s.contact_phone));
  }).catch(() => {});

  render();
})();
