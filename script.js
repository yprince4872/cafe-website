// ---------- backend connection ----------
// Point this at wherever the musafir-cafe-backend API is running.
// Local testing: http://localhost:4000   Production: your deployed backend URL.
const API_URL = 'http://localhost:4000';

// ---------- customer login (mobile number + PIN) ----------
// The login is kept on this phone, so the customer stays logged in.
const SESSION_KEY = 'musafir-session';            // { token, customer: { id, name, phone } }
const GUEST_ORDERS_KEY = 'musafir-guest-orders';  // orders placed while logged out: [{ id, token }]

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
}
function setSession(session) { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); updateNavAccount(); }
function clearSession() { localStorage.removeItem(SESSION_KEY); updateNavAccount(); }
// headers for a request to the backend; includes the login when there is one
function authHeaders(extra) {
  const session = getSession();
  return Object.assign({}, extra || {}, session ? { Authorization: 'Bearer ' + session.token } : {});
}

// "👤 Login" in the menu becomes "👤 Ravi" once logged in
function updateNavAccount() {
  const session = getSession();
  const first = session && session.customer ? String(session.customer.name || '').trim().split(/\s+/)[0].slice(0, 12) : '';
  document.querySelectorAll('[data-nav-account]').forEach(a => {
    a.textContent = session ? '👤 ' + (first || 'My account') : '👤 Login';
  });
}

// Remember orders placed while logged out, so they can be attached to the
// account if the customer logs in later on this same phone.
function rememberGuestOrder(id, token) {
  if (!id || !token) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(GUEST_ORDERS_KEY) || '[]'); } catch (e) { list = []; }
  list.push({ id, token });
  localStorage.setItem(GUEST_ORDERS_KEY, JSON.stringify(list.slice(-30)));
}
async function claimGuestOrders() {
  const session = getSession();
  let list = [];
  try { list = JSON.parse(localStorage.getItem(GUEST_ORDERS_KEY) || '[]'); } catch (e) { list = []; }
  if (!session || !list.length) return 0;
  try {
    const res = await fetch(`${API_URL}/api/account/claim`, {
      method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ orders: list }),
    });
    if (!res.ok) return 0;
    localStorage.removeItem(GUEST_ORDERS_KEY);
    return (await res.json()).linked || 0;
  } catch (e) { return 0; }
}

// fills the name / phone boxes of the order and booking forms for a logged-in customer
function prefillFromAccount() {
  const session = getSession();
  if (!session || !session.customer) return;
  const fill = (ids, value) => ids.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = value;
  });
  fill(['coName', 'rname', 'cname'], session.customer.name);
  fill(['coPhone', 'rphone', 'cphone'], session.customer.phone);
}

// ---------- sticky header ----------
const header = document.getElementById('siteHeader');
if(header){
  window.addEventListener('scroll', () => header.classList.toggle('solid', window.scrollY > 30));
}

// ---------- mobile menu ----------
const burgerBtn = document.getElementById('burgerBtn');
const mobilePanel = document.getElementById('mobilePanel');
if(burgerBtn && mobilePanel){
  burgerBtn.addEventListener('click', () => {
    const open = mobilePanel.classList.toggle('open');
    burgerBtn.setAttribute('aria-expanded', open);
  });
  mobilePanel.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    mobilePanel.classList.remove('open');
    burgerBtn.setAttribute('aria-expanded', 'false');
  }));
}

// ---------- reservation modal (site-wide) ----------
const modalBackdrop = document.getElementById('reserveModal');
const openTriggers = document.querySelectorAll('[data-open-reserve]');
const closeTriggers = document.querySelectorAll('[data-close-reserve]');
openTriggers.forEach(btn => btn.addEventListener('click', (e) => {
  e.preventDefault();
  if(modalBackdrop){ modalBackdrop.classList.add('open'); }
  if(mobilePanel){ mobilePanel.classList.remove('open'); }
}));
closeTriggers.forEach(btn => btn.addEventListener('click', () => modalBackdrop && modalBackdrop.classList.remove('open')));
if(modalBackdrop){
  modalBackdrop.addEventListener('click', (e) => { if(e.target === modalBackdrop) modalBackdrop.classList.remove('open'); });
}

// ---------- reservation form (posts to the backend) ----------
document.querySelectorAll('.reserve-form').forEach(form => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = form.querySelector('.confirm-msg');
    const btn = form.querySelector('button[type="submit"]');
    const nameEl = form.querySelector('input[id$="name"]');
    const dateEl = form.querySelector('input[id$="date"]');
    const timeEl = form.querySelector('input[id$="time"]');
    const guestsEl = form.querySelector('select[id$="guests"]');
    const phoneEl = form.querySelector('input[id$="phone"]');
    const notesEl = form.querySelector('textarea[id$="notes"]');

    const payload = {
      name: nameEl ? nameEl.value : '',
      date: dateEl ? dateEl.value : '',
      time: timeEl ? timeEl.value : '',
      guests: guestsEl ? guestsEl.value : '',
      phone: phoneEl ? phoneEl.value : '',
      message: notesEl ? notesEl.value : '',
    };

    const originalLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

    try {
      const res = await fetch(`${API_URL}/api/reservations`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Request failed');
      if (msg) { msg.textContent = '🍵 Thank you — your table request has been sent. We\'ll call to confirm shortly.'; msg.classList.add('show'); }
      if (btn) btn.textContent = 'Table requested ✓';
      form.reset();
      prefillFromAccount();
    } catch (err) {
      if (msg) {
        msg.textContent = '⚠️ Could not reach the reservation service. Please call us instead, or try again shortly.';
        msg.style.background = '#F7E6E6';
        msg.style.borderColor = '#B94A4A';
        msg.style.color = '#8A2E2E';
        msg.classList.add('show');
      }
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
  });
});

// ---------- menu tabs (menu page) ----------
const mTabs = document.querySelectorAll('.m-tab');
const mPanels = document.querySelectorAll('.menu-panel');
mTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    mTabs.forEach(t => t.classList.remove('active'));
    mPanels.forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ---------- food ordering cart (menu page) ----------
const CART_KEY = 'musafir-cart';

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
  catch { return []; }
}
function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  renderCart();
}
function addToCart(name, price) {
  hideOrderDone();
  const cart = getCart();
  const existing = cart.find(i => i.name === name);
  if (existing) existing.qty += 1;
  else cart.push({ name, price, qty: 1 });
  saveCart(cart);
}
function changeQty(name, delta) {
  let cart = getCart();
  const item = cart.find(i => i.name === name);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(i => i.name !== name);
  saveCart(cart);
}
function cartTotal(cart) { return cart.reduce((sum, i) => sum + i.price * i.qty, 0); }
function cartCount(cart) { return cart.reduce((sum, i) => sum + i.qty, 0); }

const cartFab = document.getElementById('cartFab');
const cartPanel = document.getElementById('cartPanel');
const cartItemsEl = document.getElementById('cartItems');
const cartTotalEl = document.getElementById('cartTotalValue');
const cartCountEl = document.getElementById('cartCount');
const cartEmptyEl = document.getElementById('cartEmpty');
const checkoutForm = document.getElementById('checkoutForm');
const deliveryAddressField = document.getElementById('deliveryAddressField');
const orderDoneEl = document.getElementById('orderDone');

function hideOrderDone() {
  if (orderDoneEl) { orderDoneEl.classList.remove('show'); orderDoneEl.innerHTML = ''; }
}
function showOrderDone(html) {
  if (!orderDoneEl) return;
  orderDoneEl.innerHTML = html;
  orderDoneEl.classList.add('show');
  if (cartEmptyEl) cartEmptyEl.style.display = 'none';
  openCart();
}
const escHTML = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// dark layer behind the cart; tapping it closes the cart
let cartBackdrop = null;
if (cartPanel) {
  cartBackdrop = document.createElement('div');
  cartBackdrop.className = 'cart-backdrop';
  cartBackdrop.addEventListener('click', () => closeCart());
  document.body.appendChild(cartBackdrop);
}
function openCart() {
  if (!cartPanel) return;
  cartPanel.classList.add('open');
  document.body.classList.add('cart-open');   // page behind stops scrolling
  if (cartBackdrop) cartBackdrop.classList.add('show');
}
function closeCart() {
  if (!cartPanel) return;
  hideOrderDone();     // an old "order placed" message must not stay behind in the cart
  renderCart();
  cartPanel.classList.remove('open');
  document.body.classList.remove('cart-open');
  if (cartBackdrop) cartBackdrop.classList.remove('show');
}

// Shows "Add to cart" when an item isn't in the cart, and a big − qty +
// stepper right on the menu item once it is.
function syncMenuSteppers() {
  const cart = getCart();
  document.querySelectorAll('[data-item-ctrl]').forEach(ctrl => {
    const found = cart.find(i => i.name === ctrl.dataset.name);
    const qty = found ? found.qty : 0;
    ctrl.classList.toggle('has-qty', qty > 0);
    const q = ctrl.querySelector('.stepper-qty');
    if (q) q.textContent = qty;
  });
}

function renderCart() {
  syncMenuSteppers();
  if (!cartItemsEl) return; // not on this page
  const cart = getCart();

  cartItemsEl.innerHTML = '';
  cart.forEach(item => {
    const row = document.createElement('div');
    row.className = 'cart-row';
    row.innerHTML = `
      <div class="cart-row-info">
        <span class="cart-row-name">${item.name}</span>
        <span class="cart-row-price">₹${item.price} × ${item.qty}</span>
      </div>
      <div class="cart-row-qty">
        <button type="button" data-minus="${item.name}" aria-label="Remove one">−</button>
        <span>${item.qty}</span>
        <button type="button" data-plus="${item.name}" aria-label="Add one">+</button>
      </div>
    `;
    cartItemsEl.appendChild(row);
  });

  cartItemsEl.querySelectorAll('[data-plus]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.plus, 1)));
  cartItemsEl.querySelectorAll('[data-minus]').forEach(b => b.addEventListener('click', () => changeQty(b.dataset.minus, -1)));

  if (cartTotalEl) cartTotalEl.textContent = `₹${cartTotal(cart)}`;
  if (cartCountEl) cartCountEl.textContent = cartCount(cart);
  if (cartEmptyEl) cartEmptyEl.style.display = (cart.length || (orderDoneEl && orderDoneEl.classList.contains('show'))) ? 'none' : 'block';
  if (checkoutForm) checkoutForm.style.display = cart.length ? 'block' : 'none';
  if (typeof updateOrderButton === 'function') updateOrderButton();
  if (typeof updateUpiInline === 'function') updateUpiInline();
}

// menu items can arrive later (loaded dynamically from the backend by
// content.js), so this is re-run after they're injected — data-cart-bound
// stops the same button from getting a second click listener.
function initCartButtons() {
  document.querySelectorAll('[data-add-cart]').forEach(btn => {
    if (btn.dataset.cartBound) return;
    btn.dataset.cartBound = '1';
    btn.addEventListener('click', () => addToCart(btn.dataset.name, Number(btn.dataset.price)));
  });
  document.querySelectorAll('[data-step-plus]').forEach(btn => {
    if (btn.dataset.cartBound) return;
    btn.dataset.cartBound = '1';
    btn.addEventListener('click', () => {
      const c = btn.closest('[data-item-ctrl]');
      addToCart(c.dataset.name, Number(c.dataset.price));
    });
  });
  document.querySelectorAll('[data-step-minus]').forEach(btn => {
    if (btn.dataset.cartBound) return;
    btn.dataset.cartBound = '1';
    btn.addEventListener('click', () => changeQty(btn.closest('[data-item-ctrl]').dataset.name, -1));
  });
  syncMenuSteppers();
}
window.initCartButtons = initCartButtons;
initCartButtons();
if (cartFab) cartFab.addEventListener('click', () => (cartPanel.classList.contains('open') ? closeCart() : openCart()));
document.querySelectorAll('[data-close-cart]').forEach(b => b.addEventListener('click', closeCart));

// Dine-in asks for a table number, delivery asks for an address, pickup asks for neither.
const tableNumberField = document.getElementById('tableNumberField');
const tableInput = document.getElementById('coTable');

function applyOrderType() {
  const checked = document.querySelector('input[name="orderType"]:checked');
  const type = checked ? checked.value : 'pickup';
  if (deliveryAddressField) deliveryAddressField.style.display = type === 'delivery' ? 'block' : 'none';
  if (tableNumberField) tableNumberField.style.display = type === 'dine-in' ? 'block' : 'none';
  if (tableInput) tableInput.required = type === 'dine-in';
}
document.querySelectorAll('input[name="orderType"]').forEach(input => input.addEventListener('change', applyOrderType));

// A QR code on the table can open the menu as menu.html?table=5 — fill that number in automatically.
function prefillTableFromLink() {
  const fromLink = new URLSearchParams(location.search).get('table');
  if (fromLink && /^[A-Za-z0-9 -]{1,10}$/.test(fromLink.trim())) {
    sessionStorage.setItem('musafir-table', fromLink.trim());
  }
  const saved = sessionStorage.getItem('musafir-table');
  if (saved && tableInput) {
    tableInput.value = saved;
    const dineIn = document.querySelector('input[name="orderType"][value="dine-in"]');
    if (dineIn) dineIn.checked = true;
  }
  applyOrderType();
}
prefillTableFromLink();

// "Place order" — or, when paying by UPI, "I have paid ₹250 — Place order"
function orderButtonLabel() {
  const method = (document.querySelector('input[name="payMethod"]:checked') || {}).value;
  return method === 'upi' ? `✓ I have paid ₹${cartTotal(getCart())} — Place order` : 'Place order';
}
function updateOrderButton() {
  const btn = checkoutForm && checkoutForm.querySelector('button[type="submit"]');
  if (btn && !btn.disabled) btn.textContent = orderButtonLabel();
}
document.querySelectorAll('input[name="payMethod"]').forEach(r => r.addEventListener('change', () => { updateOrderButton(); updateUpiInline(); }));

// ---------- UPI option (only offered when the cafe has set a UPI ID) ----------
window.refreshPaymentOptions = function () {
  const hasUpi = !!(window.CAFE_UPI && window.CAFE_UPI.id);
  const upiOpt = document.getElementById('upiOption');
  if (!upiOpt) return;
  upiOpt.style.display = hasUpi ? '' : 'none';
  // when UPI is available it is pre-selected (customers can switch to cash)
  if (!hasUpi || !window._payChoiceTouched) {
    const radio = document.querySelector(`input[name="payMethod"][value="${hasUpi ? 'upi' : 'cash'}"]`);
    if (radio) radio.checked = true;
  }
  updateOrderButton();
  updateUpiInline();
  maybeResumePayment();
};
document.querySelectorAll('input[name="payMethod"]').forEach(r =>
  r.addEventListener('change', () => { window._payChoiceTouched = true; }));

function showCheckoutError(text) {
  const msg = document.getElementById('checkoutMsg');
  if (!msg) return;
  msg.textContent = text;
  msg.style.background = '#F7E6E6'; msg.style.borderColor = '#B94A4A'; msg.style.color = '#8A2E2E';
  msg.classList.add('show');
}
function clearCheckoutMsg() {
  const msg = document.getElementById('checkoutMsg');
  if (msg) { msg.classList.remove('show'); msg.textContent = ''; }
}

// ---------- UPI payment, right inside the order form ----------
// The customer PAYS FIRST (GPay / PhonePe / Paytm / any UPI app, or the QR code),
// then types the 12-digit UPI reference (UTR) and places the order.
const upiInline = document.getElementById('upiInline');
const DRAFT_KEY = 'musafir-checkout-draft';     // what was typed, kept while the customer is in their UPI app
const RETURN_KEY = 'musafir-return-to-pay';

function upiSelected() {
  const r = document.querySelector('input[name="payMethod"]:checked');
  return !!r && r.value === 'upi';
}

// each UPI app understands the standard upi://pay link; GPay, PhonePe and Paytm also
// have their own links that open that app directly
function buildUpiLink(amount) {
  const upi = window.CAFE_UPI || {};
  const params = new URLSearchParams({ pa: upi.id, pn: upi.name || 'Musafir Cafe', am: Number(amount).toFixed(2), cu: 'INR', tn: 'Musafir Cafe order' });
  return 'upi://pay?' + params.toString().replace(/\+/g, '%20');
}
function upiAppLinks(link) {
  const query = link.split('?')[1] || '';
  return { any: link, gpay: 'gpay://upi/pay?' + query, phonepe: 'phonepe://pay?' + query, paytm: 'paytmmp://pay?' + query };
}

function updateUpiInline() {
  if (!upiInline) return;
  const upi = window.CAFE_UPI || {};
  const cart = getCart();
  const visible = upiSelected() && !!upi.id && cart.length > 0;
  upiInline.style.display = visible ? 'block' : 'none';
  if (!visible) return;

  if (!upiInline.dataset.built) {
    upiInline.innerHTML = `
      <div class="upi-inline-head">Pay ₹<span id="upiAmount"></span> with UPI</div>
      <p class="done-sub"><b>Step 1:</b> pay with any UPI app. <b>Step 2:</b> type the 12-digit reference number below. <b>Step 3:</b> place your order.</p>
      <a class="btn btn-primary upi-pay-btn" id="upiAnyBtn" href="#">📱 Pay with any UPI app</a>
      <div class="upi-apps">
        <a class="upi-app" id="upiGpay" href="#">Google Pay</a>
        <a class="upi-app" id="upiPhonepe" href="#">PhonePe</a>
        <a class="upi-app" id="upiPaytm" href="#">Paytm</a>
      </div>
      <p class="done-hint">The amount is filled in for you — please do not change it. If an app does not open, scan the QR code or use the UPI ID.</p>
      <div class="upi-qr" id="upiQr"></div>
      <p class="upi-id-row">UPI ID: <strong id="upiIdText"></strong> <button type="button" class="upi-copy" id="upiCopy">Copy</button></p>
      <div class="upi-confirm">
        <label for="upiRef"><b>Step 2:</b> UPI reference number (UTR) — 12 digits</label>
        <input type="text" id="upiRef" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="e.g. 412345678901">
        <p class="done-hint" style="margin:-4px 0 0;">Find it in your payment app, in the payment details (it is called "UPI transaction ID", "UTR" or "Ref No.").</p>
      </div>`;
    upiInline.dataset.built = '1';
    // going to the UPI app may reload this page: remember what was typed and bring the customer back here
    upiInline.querySelectorAll('.upi-pay-btn, .upi-app').forEach(a => a.addEventListener('click', () => {
      saveDraft();
      sessionStorage.setItem(RETURN_KEY, '1');
    }));
    document.getElementById('upiCopy').addEventListener('click', () => {
      if (navigator.clipboard) navigator.clipboard.writeText(upi.id);
      document.getElementById('upiCopy').textContent = 'Copied ✓';
    });
  }

  const amount = cartTotal(cart);
  const link = buildUpiLink(amount);
  const l = upiAppLinks(link);
  document.getElementById('upiAmount').textContent = amount;
  document.getElementById('upiIdText').textContent = upi.id;
  document.getElementById('upiAnyBtn').href = l.any;
  document.getElementById('upiGpay').href = l.gpay;
  document.getElementById('upiPhonepe').href = l.phonepe;
  document.getElementById('upiPaytm').href = l.paytm;
  if (upiInline.dataset.qrFor !== link) {            // redraw the QR only when the amount changed
    const qr = document.getElementById('upiQr');
    qr.innerHTML = '';
    if (typeof QRCode !== 'undefined') new QRCode(qr, { text: link, width: 170, height: 170 });
    upiInline.dataset.qrFor = link;
  }
}

// back from the UPI app: reopen the cart at the reference-number box
function maybeResumePayment() {
  if (sessionStorage.getItem(RETURN_KEY) !== '1') return;
  sessionStorage.removeItem(RETURN_KEY);
  if (!getCart().length || !upiSelected()) return;
  openCart();
  setTimeout(() => { const el = document.getElementById('upiRef'); if (el) el.scrollIntoView({ block: 'center' }); }, 350);
}

// ---------- keep what the customer typed (the UPI app can reload the page) ----------
const DRAFT_FIELDS = ['coName', 'coPhone', 'coTable', 'coAddress', 'coNotes', 'upiRef'];
function saveDraft() {
  if (!checkoutForm) return;
  const draft = { fields: {} };
  const type = document.querySelector('input[name="orderType"]:checked');
  const pay = document.querySelector('input[name="payMethod"]:checked');
  draft.type = type ? type.value : null;
  draft.pay = pay ? pay.value : null;
  DRAFT_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) draft.fields[id] = el.value; });
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}
function clearDraft() {
  sessionStorage.removeItem(DRAFT_KEY);
  sessionStorage.removeItem(RETURN_KEY);
}
function restoreDraft() {
  if (!checkoutForm) return;
  let draft = null;
  try { draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { draft = null; }
  if (!draft) return;
  const tableFromLink = new URLSearchParams(location.search).get('table');
  Object.entries(draft.fields || {}).forEach(([id, value]) => {
    if (id === 'coTable' && tableFromLink) return;          // a table QR code always wins
    const el = document.getElementById(id);
    if (el && value) el.value = value;
  });
  if (draft.type) { const r = document.querySelector(`input[name="orderType"][value="${draft.type}"]`); if (r && !tableFromLink) r.checked = true; }
  if (draft.pay) {
    const r = document.querySelector(`input[name="payMethod"][value="${draft.pay}"]`);
    if (r) { r.checked = true; window._payChoiceTouched = true; }   // keep the customer's own choice
  }
  applyOrderType();
}
if (checkoutForm) {
  checkoutForm.addEventListener('input', saveDraft);
  checkoutForm.addEventListener('change', saveDraft);
}

// ---------- checkout ----------
if (checkoutForm) {
  checkoutForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cart = getCart();
    if (!cart.length) return;

    const name = document.getElementById('coName').value;
    const phone = document.getElementById('coPhone').value;
    const orderType = document.querySelector('input[name="orderType"]:checked').value;
    const payMethod = (document.querySelector('input[name="payMethod"]:checked') || {}).value || 'cash';
    const address = document.getElementById('coAddress').value;
    const notes = document.getElementById('coNotes').value;
    const btn = checkoutForm.querySelector('button[type="submit"]');

    clearCheckoutMsg();
    // UPI: the customer must have paid already and typed the 12-digit reference (UTR)
    let upiRef = '';
    if (payMethod === 'upi') {
      upiRef = (document.getElementById('upiRef') ? document.getElementById('upiRef').value : '').replace(/\s+/g, '');
      if (!/^\d{12}$/.test(upiRef)) {
        showCheckoutError('Please pay with your UPI app first, then type the 12-digit UPI reference (UTR) number from the payment details.');
        const box = document.getElementById('upiRef');
        if (box) { box.scrollIntoView({ block: 'center' }); box.focus(); }
        return;
      }
    }
    btn.disabled = true; btn.textContent = 'Placing order...';

    try {
      const res = await fetch(`${API_URL}/api/orders`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        // prices are decided by the server from the menu; only names + quantities are sent
        body: JSON.stringify({
          name, phone, order_type: orderType, address, notes, payment_method: payMethod, payment_ref: upiRef || undefined,
          table_number: orderType === 'dine-in' ? tableInput.value.trim() : undefined,
          items: cart.map(i => ({ name: i.name, qty: i.qty })),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 409 && data.unavailable) {
        // some items were switched to "unavailable" — tell the customer and drop them from the cart
        const remaining = getCart().filter(i => !data.unavailable.includes(i.name));
        saveCart(remaining);
        showCheckoutError(data.message || 'Some items are currently unavailable.');
        btn.disabled = false; btn.textContent = orderButtonLabel();
        return;
      }
      if (!res.ok) {
        showCheckoutError(data.error || '⚠️ Could not place the order. Please try again, or call us.');
        btn.disabled = false; btn.textContent = orderButtonLabel();
        return;
      }

      if (!getSession()) rememberGuestOrder(data.order.id, data.claim_token);   // can be attached to an account later
      const whereText = orderType === 'dine-in' ? ' for Table ' + tableInput.value.trim() : '';
      saveCart([]);                    // the cart is empty again — nothing of this order stays in it
      clearDraft();
      checkoutForm.reset();
      prefillFromAccount();
      prefillTableFromLink();
      window._payChoiceTouched = false;
      if (typeof window.refreshPaymentOptions === 'function') window.refreshPaymentOptions();
      btn.disabled = false; btn.textContent = orderButtonLabel();

      showOrderDone(`
        <h4>🎉 Order placed!</h4>
        <p class="done-sub">Order #${escHTML(data.order.id)}${escHTML(whereText)} — total ₹${escHTML(data.order.total)}. ${
          payMethod === 'upi'
            ? `We have your UPI payment reference (${escHTML(upiRef)}). We will check the payment and start preparing your order.`
            : (orderType === 'dine-in' ? 'We will bring it to your table. Please pay at the counter.' : "We'll call you to confirm. Please pay at the cafe / on delivery.")
        }</p>
      `);
    } catch (err) {
      showCheckoutError('⚠️ Could not reach the order service. Please call us instead, or try again shortly.');
      btn.disabled = false; btn.textContent = orderButtonLabel();
    }
  });
}

// the old flow kept a "pending payment" screen on this phone — remove any leftover so it never comes back
localStorage.removeItem('musafir-pending-payment');
restoreDraft();

renderCart();

// ---------- scroll reveal ----------
const revealEls = document.querySelectorAll('.reveal');
if('IntersectionObserver' in window){
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
    });
  }, { threshold: 0.15 });
  revealEls.forEach(el => io.observe(el));
} else {
  revealEls.forEach(el => el.classList.add('in'));
}

// =====================================================================
// INSTALL AS AN APP — service worker + "Install" bar
// =====================================================================
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

(function setupInstallBar() {
  const alreadyInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (alreadyInstalled) return;

  const DISMISS_KEY = 'musafir-install-dismissed';
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
  if (Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000) return;   // asked recently, stay quiet for a week

  let deferredPrompt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  function showBar(html, withButton) {
    if (document.getElementById('installBar')) return;
    const bar = document.createElement('div');
    bar.className = 'install-bar show';
    bar.id = 'installBar';
    bar.innerHTML = `<span class="install-text">${html}</span>` +
      (withButton ? '<button type="button" class="install-go">Install</button>' : '') +
      '<button type="button" class="install-x" aria-label="Close">&times;</button>';
    // on the menu page, sit above the floating cart button
    if (document.getElementById('cartFab')) bar.style.bottom = 'calc(88px + env(safe-area-inset-bottom, 0px))';
    document.body.appendChild(bar);
    bar.querySelector('.install-x').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
      bar.remove();
    });
    const go = bar.querySelector('.install-go');
    if (go) go.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
      bar.remove();
    });
  }

  // Android / Chrome: the browser tells us the site can be installed
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showBar('📲 Get the <b>Musafir Cafe app</b> on your phone', true);
  });
  window.addEventListener('appinstalled', () => {
    const bar = document.getElementById('installBar'); if (bar) bar.remove();
  });

  // iPhone / iPad: Safari has no install button, so show how to do it by hand
  if (isIOS) {
    setTimeout(() => showBar('📲 Install this app: tap <b>Share</b> <span aria-hidden="true">⬆️</span> then <b>Add to Home Screen</b>', false), 2500);
  }
})();

// =====================================================================
// LOGIN: header link, form prefill, "open my cart" link
// =====================================================================
updateNavAccount();
prefillFromAccount();

// a small reminder in the cart for customers who are not logged in
(function loginNudge() {
  if (!checkoutForm || getSession()) return;
  const note = document.createElement('p');
  note.className = 'login-nudge';
  note.innerHTML = '👤 <a href="account.html">Log in</a> to see this order in your account later.';
  checkoutForm.insertBefore(note, checkoutForm.firstChild);
})();

// account.html's "Order again" sends people to menu.html?cart=1 with the items already in the cart
if (new URLSearchParams(location.search).get('cart') === '1' && typeof openCart === 'function') {
  openCart();
}
