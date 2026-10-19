// content.js — makes the site "dynamic": every page fetches its text,
// menu, gallery and news from the backend on load, instead of having it
// hardcoded in the HTML. Edit any of it from admin.html and it shows up
// here automatically — no code changes needed.
//
// Requires API_URL from script.js (loaded before this file).

(function () {
  const money = (n) => '₹' + Number(n).toFixed(2);
  // uploaded photos come back as /uploads/xyz.jpg — they live on the backend
  const imgSrc = (u) => (u && u.startsWith('/uploads/') ? API_URL + u : u || '');

  // ---------- settings: hero / about / contact / footer text ----------
  async function loadSettings() {
    try {
      const res = await fetch(API_URL + '/api/content/settings');
      if (!res.ok) return;
      const s = await res.json();

      const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== undefined) el.textContent = value;
      };

      // Hero (home page)
      setText('heroBadge', s.hero_badge);
      setText('heroTitle', s.hero_title);
      setText('heroLede', s.hero_lede);

      // About page
      setText('aboutHeading', s.about_heading);
      setText('aboutText1', s.about_text1);
      setText('aboutText2', s.about_text2);
      setText('missionText', s.mission_text);

      // Contact page
      setText('contactAddress1', s.contact_address);
      setText('contactPhone1', s.contact_phone);
      setText('contactEmail1', s.contact_email);
      setText('contactMapText', '📍 ' + (s.contact_address || ''));

      // Site photos uploaded from the admin panel (only replaced if one was set)
      const setImg = (id, url) => {
        const el = document.getElementById(id);
        if (el && url) el.src = imgSrc(url);
      };
      setImg('heroImage', s.hero_image);
      setImg('heroImage2', s.hero_image2);
      setImg('diningImage', s.dining_image);
      setImg('aboutImage', s.about_image);

      // UPI payment (checkout offers it only when a UPI ID is set)
      window.CAFE_UPI = { id: (s.upi_id || '').trim(), name: (s.upi_name || '').trim() };
      if (typeof window.refreshPaymentOptions === 'function') window.refreshPaymentOptions();

      // Footer (every page)
      setText('footerTagline', s.footer_tagline);
      if (s.contact_address) {
        setText('footerAddress', s.contact_address);
      }
      const footerPhone = document.getElementById('footerPhone');
      if (footerPhone && s.contact_phone) {
        footerPhone.textContent = s.contact_phone;
        footerPhone.href = 'tel:' + s.contact_phone.replace(/[^+\d]/g, '');
      }
      const footerEmail = document.getElementById('footerEmail');
      if (footerEmail && s.contact_email) {
        footerEmail.textContent = s.contact_email;
        footerEmail.href = 'mailto:' + s.contact_email;
      }
    } catch (e) {
      console.warn('[content] could not load settings', e);
    }
  }

  // ---------- menu page ----------
  async function loadMenu() {
    const tabsEl = document.getElementById('menuTabs');
    const panelsEl = document.getElementById('menuPanels');
    if (!tabsEl || !panelsEl) return;

    try {
      const res = await fetch(API_URL + '/api/content/menu');
      const items = await res.json();
      if (!items.length) return;

      const categories = [...new Set(items.map((i) => i.category))];
      const labels = { coffee: 'Coffee & Chai', snacks: 'Snacks & Chaat', mains: 'Fusion Mains', sweets: 'Sweets & Cold' };

      tabsEl.innerHTML = categories
        .map((c, i) => `<button class="m-tab${i === 0 ? ' active' : ''}" data-tab="${c}">${labels[c] || c}</button>`)
        .join('');

      panelsEl.innerHTML = categories
        .map((c, i) => {
          const rows = items
            .filter((item) => item.category === c)
            .map(
              (item) => `
              <div class="m-item${item.available === 0 ? ' unavailable' : ''}">
                ${item.image_url ? `<img class="m-photo" src="${imgSrc(item.image_url)}" alt="${item.name.replace(/"/g, '&quot;')}" loading="lazy">` : ''}
                <div class="m-body">
                  <h4>${item.name}</h4>
                  <p>${item.description || ''}</p>
                  ${item.available === 0 ? '<span class="badge-unavail">Currently unavailable</span>' : `<div class="qty-ctrl" data-item-ctrl data-name="${item.name.replace(/"/g, '&quot;')}" data-price="${item.price}">
                    <button class="add-cart-btn" type="button" data-add-cart data-name="${item.name.replace(/"/g, '&quot;')}" data-price="${item.price}">Add to cart</button>
                    <div class="stepper">
                      <button type="button" data-step-minus aria-label="Remove one">−</button>
                      <span class="stepper-qty">0</span>
                      <button type="button" data-step-plus aria-label="Add one">+</button>
                    </div>
                  </div>`}
                </div>
                <span class="m-price">${money(item.price)}</span>
              </div>`
            )
            .join('');
          return `<div class="menu-panel${i === 0 ? ' active' : ''}" id="panel-${c}">${rows}</div>`;
        })
        .join('');

      tabsEl.querySelectorAll('.m-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          tabsEl.querySelectorAll('.m-tab').forEach((t) => t.classList.remove('active'));
          panelsEl.querySelectorAll('.menu-panel').forEach((p) => p.classList.remove('active'));
          tab.classList.add('active');
          document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
        });
      });

      // items the cafe switched to "unavailable" can't stay in a customer's cart
      try {
        const unavailableNames = items.filter((i) => i.available === 0).map((i) => i.name);
        const cartNow = typeof getCart === 'function' ? getCart() : [];
        const stuck = cartNow.filter((c) => unavailableNames.includes(c.name));
        if (stuck.length) {
          saveCart(cartNow.filter((c) => !unavailableNames.includes(c.name)));
          const note = document.createElement('div');
          note.className = 'menu-notice';
          note.textContent = `Sorry — ${stuck.map((c) => c.name).join(', ')} ${stuck.length > 1 ? 'are' : 'is'} currently unavailable, so we removed ${stuck.length > 1 ? 'them' : 'it'} from your cart.`;
          tabsEl.parentNode.insertBefore(note, tabsEl);
        }
      } catch (e) { /* cart helpers not available on this page */ }

      // let script.js's cart buttons attach (menu items now exist in the DOM)
      if (typeof window.initCartButtons === 'function') window.initCartButtons();
    } catch (e) {
      panelsEl.innerHTML = '<p>Could not load the menu right now.</p>';
    }
  }

  // ---------- gallery page ----------
  async function loadGallery() {
    const grid = document.getElementById('galleryGrid');
    if (!grid) return;
    try {
      const res = await fetch(API_URL + '/api/content/gallery');
      const images = await res.json();
      grid.innerHTML = images
        .map(
          (img) => `
          <div class="g-item"><img src="${imgSrc(img.image_url)}" alt="${img.caption || ''}" loading="lazy"><div class="g-cap">${img.caption || ''}</div></div>`
        )
        .join('');
    } catch (e) {
      grid.innerHTML = '<p>Could not load the gallery right now.</p>';
    }
  }

  // ---------- news page ----------
  async function loadNews() {
    const grid = document.getElementById('newsGrid');
    if (!grid) return;
    try {
      const res = await fetch(API_URL + '/api/content/news');
      const posts = await res.json();
      grid.innerHTML = posts
        .map(
          (p) => `
          <article class="news-card">
            <img src="${imgSrc(p.image_url)}" alt="${p.title}">
            <div class="news-body">
              <span class="news-date">${p.date_label || ''}</span>
              <h4>${p.title}</h4>
              <p>${p.excerpt || ''}</p>
              ${p.link ? `<a href="${p.link}" class="news-link">Read more →</a>` : ''}
            </div>
          </article>`
        )
        .join('');
    } catch (e) {
      grid.innerHTML = '<p>Could not load news right now.</p>';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadMenu();
    loadGallery();
    loadNews();
  });
})();
