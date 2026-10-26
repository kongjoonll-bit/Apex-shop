/* ============================================================
   APEX SHOP — storefront (회원 로그인 · 자동지급 보관함 · 프리미엄 FX)
   ============================================================ */
'use strict';

(function () {
  const CART_KEY = 'apex_cart_v2';
  const $ = (id) => document.getElementById(id);
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const state = {
    settings: {},
    automation: {},
    products: [],
    reviews: [],
    games: [],
    cart: [],
    user: null,
    orders: [],
    reviewable: [],
    myReviews: [],
    reviewTarget: null,
    reviewRating: 5,
    authMode: 'login',
    afterAuth: null,
    filter: { category: '전체', game: '전체' },
    sort: 'recommend',
    pollTimer: null
  };

  /* ---------- utils ---------- */
  const won = (value) => Number(value || 0).toLocaleString('ko-KR') + '원';
  const numeric = (value) => Number(value || 0).toLocaleString('ko-KR');

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  }

  function dateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return shortDate(iso) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function safeHref(url) {
    const value = String(url || '').trim();
    return /^https?:\/\/\S+/i.test(value) ? value : '';
  }

  function starsHtml(rating) {
    const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    let out = '<span class="stars">';
    for (let i = 0; i < 5; i += 1) out += '<span class="star' + (i < n ? ' is-on' : '') + '">★</span>';
    return out + '</span>';
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {}, credentials: 'same-origin' }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.error) || '요청을 처리하지 못했습니다.');
    return data;
  }

  function toast(message, type) {
    const stack = $('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    const icon = type === 'ok' ? 'i-check' : type === 'error' ? 'i-close' : 'i-bolt';
    el.innerHTML = '<svg class="ico"><use href="#' + icon + '"/></svg><span>' + esc(message) + '</span>';
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }, 2800);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('복사했습니다.', 'ok');
      sparkleBurst(window.innerWidth / 2, 140);
    } catch (err) {
      toast('복사에 실패했습니다. 직접 선택해 주세요.', 'warn');
    }
  }
  /* ---------- premium fx ---------- */
  function ripple(el, event) {
    if (reduceMotion) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 2.1;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = size + 'px';
    span.style.height = size + 'px';
    span.style.left = (event.clientX - rect.left - size / 2) + 'px';
    span.style.top = (event.clientY - rect.top - size / 2) + 'px';
    el.appendChild(span);
    setTimeout(() => span.remove(), 720);
  }

  function sparkleBurst(x, y) {
    if (reduceMotion) return;
    const layer = $('fxLayer');
    if (!layer) return;
    for (let i = 0; i < 10; i += 1) {
      const spark = document.createElement('span');
      spark.className = 'spark';
      const angle = (Math.PI * 2 * i) / 10 + Math.random() * 0.4;
      const dist = 16 + Math.random() * 46;
      spark.style.left = x + 'px';
      spark.style.top = y + 'px';
      spark.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
      spark.style.setProperty('--dy', (Math.sin(angle) * dist - 12).toFixed(1) + 'px');
      spark.style.animationDelay = (i * 12) + 'ms';
      layer.appendChild(spark);
      setTimeout(() => spark.remove(), 760 + i * 12);
    }
  }

  function countUp(el, target) {
    if (!el) return;
    const to = Math.max(0, Number(target) || 0);
    if (reduceMotion) {
      el.textContent = numeric(to);
      return;
    }
    const from = Number(String(el.textContent).replace(/[^0-9]/g, '')) || 0;
    const start = performance.now();
    function frame(now) {
      const p = Math.min(1, (now - start) / 760);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = numeric(Math.round(from + (to - from) * eased));
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function initReveal() {
    const items = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
    if (!items.length) return;
    if (!('IntersectionObserver' in window) || reduceMotion) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el) => observer.observe(el));
  }

  function initFx() {
    const bar = $('scrollProgress');
    const hdr = document.querySelector('.hdr');
    const onScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const y = window.scrollY || doc.scrollTop || 0;
      if (bar) bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, y / max) : 0) + ')';
      if (hdr) hdr.classList.toggle('is-scrolled', y > 10);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    document.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element)) return;
      const el = event.target.closest('.btn, .card-add, .card-buy, .cart-btn, .account-btn, .tab, .game-chip, .auth-tab, .stepper button');
      if (!el || el.hasAttribute('disabled')) return;
      ripple(el, event);
      if (el.classList.contains('btn') || el.classList.contains('card-buy')) sparkleBurst(event.clientX, event.clientY);
    }, { passive: true });

    document.addEventListener('pointermove', (event) => {
      if (reduceMotion || !(event.target instanceof Element)) return;
      /* 터치·펜 드래그에서는 카드가 흔들리지 않도록 마우스에서만 반응합니다. */
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const card = event.target.closest('.card');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const px = (event.clientX - rect.left) / Math.max(1, rect.width);
      const py = (event.clientY - rect.top) / Math.max(1, rect.height);
      card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      /* 마우스를 따라 살짝 기울어지는 3D 틸트 */
      card.style.setProperty('--ry', ((px - 0.5) * 6).toFixed(2) + 'deg');
      card.style.setProperty('--rx', ((0.5 - py) * 5).toFixed(2) + 'deg');
    }, { passive: true });

    initReveal();
  }
  /* ---------- cart ---------- */
  const productById = (id) => state.products.find((product) => product.id === Number(id));

  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      state.cart = Array.isArray(raw)
        ? raw.map((line) => ({ productId: Number(line.productId), qty: Math.max(1, Math.min(20, Number(line.qty) || 1)) }))
            .filter((line) => line.productId)
        : [];
    } catch (err) {
      state.cart = [];
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
    } catch (err) {
      /* 저장 불가 환경 무시 */
    }
  }

  function cartCount() {
    return state.cart.reduce((sum, line) => sum + line.qty, 0);
  }

  function cartTotal() {
    return state.cart.reduce((sum, line) => {
      const product = productById(line.productId);
      return sum + (product ? product.price * line.qty : 0);
    }, 0);
  }

  function renderCartCount() {
    const badge = $('cartCount');
    if (!badge) return;
    const count = cartCount();
    if (badge.textContent !== String(count)) {
      badge.textContent = String(count);
      badge.classList.remove('pop');
      void badge.offsetWidth;
      badge.classList.add('pop');
    }
  }

  function addToCart(productId, qty) {
    const product = productById(productId);
    if (!product) return;
    const line = state.cart.find((item) => item.productId === product.id);
    if (line) line.qty = Math.min(product.stock, line.qty + qty);
    else state.cart.push({ productId: product.id, qty: Math.min(product.stock, qty) });
    state.cart = state.cart.filter((item) => item.qty > 0);
    saveCart();
    renderCart();
    toast(product.name + '을(를) 담았습니다.', 'ok');
  }

  function changeQty(productId, delta) {
    const product = productById(productId);
    const line = state.cart.find((item) => item.productId === Number(productId));
    if (!product || !line) return;
    line.qty = Math.max(0, Math.min(product.stock, line.qty + delta));
    state.cart = state.cart.filter((item) => item.qty > 0);
    saveCart();
    renderCart();
  }

  function removeLine(productId) {
    state.cart = state.cart.filter((item) => item.productId !== Number(productId));
    saveCart();
    renderCart();
  }

  function cartItemHtml(line) {
    const product = productById(line.productId);
    if (!product) return '';
    return (
      '<div class="cart-item">' +
      '<div class="cart-thumb tint-' + esc(product.tint || 'violet') + '" aria-hidden="true">' +
      (product.image
        ? '<img class="cart-thumb-img" src="' + esc(product.image) + '" alt="">'
        : esc(product.emoji || '🎮')) +
      '</div>' +
      '<div class="cart-info">' +
      '<p class="cart-name">' + esc(product.name) + '</p>' +
      '<p class="cart-price">' + won(product.price) + ' × ' + line.qty + ' = ' + won(product.price * line.qty) + '</p>' +
      '</div>' +
      '<div class="cart-side">' +
      '<button class="cart-remove" type="button" data-action="remove" data-id="' + product.id + '" aria-label="삭제">' +
      '<svg class="ico"><use href="#i-close"/></svg></button>' +
      '<div class="stepper">' +
      '<button type="button" data-action="dec" data-id="' + product.id + '" aria-label="수량 줄이기"><svg class="ico"><use href="#i-minus"/></svg></button>' +
      '<span class="stepper-val">' + line.qty + '</span>' +
      '<button type="button" data-action="inc" data-id="' + product.id + '" aria-label="수량 늘리기"><svg class="ico"><use href="#i-plus"/></svg></button>' +
      '</div></div></div>'
    );
  }

  function renderCart() {
    const body = $('cartBody');
    const total = $('cartTotal');
    const checkout = $('cartCheckout');
    const count = $('cartDrawerCount');
    if (!body) return;
    renderCartCount();
    if (count) count.textContent = cartCount() + '개';
    if (!state.cart.length) {
      body.innerHTML =
        '<div class="cart-empty"><svg class="ico"><use href="#i-bag"/></svg>' +
        '<p>장바구니가 비어 있습니다</p><span>마음에 드는 상품을 담아 보세요.</span>' +
        '<button class="btn quiet" type="button" data-action="browse">상품 둘러보기</button></div>';
      if (total) total.textContent = won(0);
      if (checkout) checkout.disabled = true;
      return;
    }
    body.innerHTML = state.cart.map(cartItemHtml).join('');
    if (total) total.textContent = won(cartTotal());
    if (checkout) checkout.disabled = false;
  }

  function syncLock() {
    let anyModal = false;
    document.querySelectorAll('.modal-backdrop').forEach((el) => {
      if (!el.hidden) anyModal = true;
    });
    const drawer = $('cartDrawer');
    const drawerOpen = !!drawer && drawer.classList.contains('is-open');
    document.body.classList.toggle('locked', anyModal || drawerOpen);
  }

  function openCart() {
    const scrim = $('cartBackdrop');
    const drawer = $('cartDrawer');
    if (!scrim || !drawer) return;
    renderCart();
    scrim.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => {
      scrim.classList.add('is-open');
      drawer.classList.add('is-open');
      syncLock();
    });
    syncLock();
  }

  function closeCart() {
    const scrim = $('cartBackdrop');
    const drawer = $('cartDrawer');
    if (!scrim || !drawer) return;
    scrim.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    syncLock();
    setTimeout(() => {
      if (!drawer.classList.contains('is-open')) scrim.hidden = true;
    }, 300);
  }

  function openModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = false;
    syncLock();
  }

  function closeModal(id) {
    const el = $(id);
    if (!el) return;
    el.hidden = true;
    syncLock();
  }
  /* ---------- quantity ---------- */
  const qtyCtx = { productId: 0, max: 1, mode: 'add' };

  function openQty(productId, mode) {
    const product = productById(productId);
    if (!product) return;
    if (product.stock <= 0) {
      openDetail(product.id);
      return;
    }
    qtyCtx.productId = product.id;
    qtyCtx.max = Math.max(1, product.stock);
    qtyCtx.mode = mode === 'buy' ? 'buy' : 'add';
    const title = $('qtyTitle');
    if (title) title.textContent = qtyCtx.mode === 'buy' ? '바로 구매' : '장바구니 담기';
    const name = $('qtyName');
    if (name) name.textContent = product.name;
    const unit = $('qtyUnit');
    if (unit) unit.textContent = won(product.price) + ' · 재고 ' + product.stock + '개';
    const thumb = $('qtyThumb');
    if (thumb) {
      thumb.className = 'qty-thumb tint-' + (product.tint || 'violet');
      if (product.image) {
        thumb.innerHTML = '<img class="qty-thumb-img" src="' + esc(product.image) + '" alt="">';
      } else {
        thumb.textContent = product.emoji || '🎮';
      }
    }
    const input = $('qtyInput');
    if (input) input.value = '1';
    syncQtyTotal();
    openModal('qtyBackdrop');
  }

  function syncQtyTotal() {
    const input = $('qtyInput');
    const total = $('qtyTotal');
    if (!input || !total) return;
    let qty = Math.round(Number(String(input.value).replace(/[^0-9]/g, '')) || 1);
    qty = Math.min(Math.max(1, qty), qtyCtx.max);
    input.value = String(qty);
    const product = productById(qtyCtx.productId);
    total.textContent = won(product ? product.price * qty : 0);
  }

  function confirmQty() {
    const input = $('qtyInput');
    const qty = Math.max(1, Math.round(Number(input ? input.value : 1) || 1));
    const mode = qtyCtx.mode;
    const productId = qtyCtx.productId;
    closeModal('qtyBackdrop');
    addToCart(productId, qty);
    if (mode === 'buy') openCart();
  }

  /* ---------- auth ---------- */
  function setAuthMode(mode) {
    state.authMode = mode === 'register' ? 'register' : 'login';
    const registering = state.authMode === 'register';
    document.querySelectorAll('.auth-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.getAttribute('data-auth-tab') === state.authMode);
    });
    const title = $('authTitle');
    const lead = $('authLead');
    const submit = $('authSubmit');
    const nameField = $('authNameField');
    const password = $('authPassword');
    const error = $('authError');
    if (title) title.textContent = registering ? '회원가입' : '로그인';
    if (lead) lead.textContent = registering
      ? '아이디만 있으면 바로 시작할 수 있습니다. 지급 정보는 이 계정에만 보관됩니다.'
      : '구매와 지급 정보를 내 계정에 안전하게 보관합니다.';
    if (submit) submit.textContent = registering ? '계정 만들기' : '로그인';
    if (nameField) nameField.hidden = !registering;
    if (password) password.autocomplete = registering ? 'new-password' : 'current-password';
    if (error) error.hidden = true;
  }

  function openAuth(mode, afterAuth) {
    state.afterAuth = typeof afterAuth === 'function' ? afterAuth : null;
    setAuthMode(mode || 'login');
    openModal('authBackdrop');
    setTimeout(() => {
      const username = $('authUsername');
      if (username) username.focus();
    }, 90);
  }

  async function submitAuth(event) {
    if (event) event.preventDefault();
    const username = String(($('authUsername') || {}).value || '').trim();
    const password = String(($('authPassword') || {}).value || '');
    const displayName = String(($('authDisplayName') || {}).value || '').trim();
    const errorBox = $('authError');
    const button = $('authSubmit');
    if (errorBox) errorBox.hidden = true;
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
      if (errorBox) {
        errorBox.textContent = '아이디는 영문·숫자·밑줄 4~20자로 입력해 주세요.';
        errorBox.hidden = false;
      }
      return;
    }
    if (password.length < 6) {
      if (errorBox) {
        errorBox.textContent = '비밀번호는 6자 이상이어야 합니다.';
        errorBox.hidden = false;
      }
      return;
    }
    if (button) {
      button.disabled = true;
      button.textContent = '처리 중…';
    }
    try {
      const path = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const data = await api(path, { method: 'POST', body: { username, password, displayName } });
      state.user = data.user;
      state.orders = Array.isArray(data.orders) ? data.orders : [];
      state.reviewable = Array.isArray(data.reviewable) ? data.reviewable : [];
      state.myReviews = Array.isArray(data.myReviews) ? data.myReviews : [];
      applyUser();
      renderAccount();
      renderReviews();
      closeModal('authBackdrop');
      toast(state.authMode === 'register' ? '환영합니다! 계정이 만들어졌습니다.' : '로그인했습니다.', 'ok');
      sparkleBurst(window.innerWidth / 2, window.innerHeight / 3);
      const next = state.afterAuth;
      state.afterAuth = null;
      startPolling();
      if (next) setTimeout(next, 220);
    } catch (err) {
      if (errorBox) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      }
      toast(err.message, 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = state.authMode === 'register' ? '계정 만들기' : '로그인';
      }
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      /* 무시 */
    }
    state.user = null;
    state.orders = [];
    state.reviewable = [];
    state.myReviews = [];
    applyUser();
    renderReviews();
    closeModal('accountBackdrop');
    toast('로그아웃했습니다.', 'ok');
  }

  async function loadMe() {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      state.orders = Array.isArray(data.orders) ? data.orders : [];
      state.reviewable = Array.isArray(data.reviewable) ? data.reviewable : [];
      state.myReviews = Array.isArray(data.myReviews) ? data.myReviews : [];
      state.automation = data.automation || state.automation;
    } catch (err) {
      state.user = null;
      state.orders = [];
      state.reviewable = [];
      state.myReviews = [];
    }
    applyUser();
    renderReviews();
  }
  /* ---------- account / vault ---------- */
  function statusPill(order) {
    return '<span class="status-pill is-' + esc(order.status) + '">' + esc(order.statusLabel) + '</span>';
  }

  function credentialsHtml(item) {
    if (!Array.isArray(item.credentials) || !item.credentials.length) return '';
    const raw = item.credentials.join('\n');
    return '<div class="cred-box"><div class="cred-head"><span><svg class="ico"><use href="#i-key"/></svg>지급 정보</span>' +
      '<button class="copy-btn" type="button" data-copy="' + esc(raw) + '"><svg class="ico"><use href="#i-copy"/></svg>복사</button></div>' +
      '<pre class="cred">' + esc(raw) + '</pre></div>';
  }

  function reviewBadgeHtml(item, order) {
    if (!item.productId || order.status !== 'delivered') return '';
    const mine = (state.myReviews || []).find((review) => review.productId === item.productId);
    if (mine) {
      return '<span class="review-done"><svg class="ico"><use href="#i-check"/></svg>후기 완료</span>';
    }
    return '<button class="review-open" type="button" data-review-product="' + item.productId +
      '" data-review-name="' + esc(item.name) + '">후기 작성</button>';
  }

  function vaultOrderHtml(order) {
    const items = (order.items || []).map((item) =>
      '<div class="vault-item"><div class="vault-item-head"><span>' + esc(item.name) + ' × ' + item.qty + '</span>' +
      '<span class="vault-item-right"><strong>' + won(item.subtotal) + '</strong>' + reviewBadgeHtml(item, order) + '</span></div>' +
      credentialsHtml(item) + '</div>'
    ).join('');
    const pending = order.status === 'pending';
    return '<article class="vault-order' + (pending ? ' is-pending' : '') + '">' +
      '<header class="vault-order-head"><div><span class="vault-code">' + esc(order.code) + '</span>' +
      '<span class="vault-date">' + esc(dateTime(order.createdAt)) + '</span></div>' + statusPill(order) + '</header>' +
      '<div class="vault-items">' + items + '</div>' +
      '<footer class="vault-order-foot"><span>총 ' + won(order.total) + '</span>' +
      (pending ? '<span class="vault-wait"><i></i>입금 확인 중</span>' : '<span class="vault-ok"><svg class="ico"><use href="#i-check"/></svg>자동 지급 완료</span>') +
      '</footer></article>';
  }

  function renderAccount() {
    if (!state.user) return;
    const initial = String(state.user.displayName || state.user.username || 'A').slice(0, 1).toUpperCase();
    const setText = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    setText('accountInitial', initial);
    setText('accountNickname', state.user.displayName || state.user.username);
    setText('accountUsername', '@' + state.user.username);
    const delivered = state.orders.filter((order) => order.status === 'delivered' || order.status === 'paid');
    const credCount = delivered.reduce((sum, order) => sum + (order.items || []).reduce((n, item) => n + ((item.credentials || []).length), 0), 0);
    setText('accountOrderCount', String(state.orders.length));
    setText('accountDeliveredCount', String(delivered.length));
    setText('accountCredCount', String(credCount));
    const box = $('accountOrders');
    if (!box) return;
    if (!state.orders.length) {
      box.innerHTML = '<div class="vault-empty"><span class="vault-empty-icon"><svg class="ico"><use href="#i-key"/></svg></span>' +
        '<p>아직 구매한 상품이 없습니다.</p><span>구매하면 지급 정보가 이곳에 자동으로 보관됩니다.</span>' +
        '<a class="btn primary" href="#shop" data-close="accountBackdrop">상품 보러가기</a></div>';
      return;
    }
    box.innerHTML = state.orders.map(vaultOrderHtml).join('');
  }

  function applyUser() {
    const label = $('accountLabel');
    const avatar = $('accountAvatar');
    const box = $('cartAuthBox');
    const buyer = document.querySelector('#cartForm [name="buyerName"]');
    if (state.user) {
      if (label) label.textContent = state.user.displayName || state.user.username;
      if (avatar) avatar.innerHTML = '<b>' + esc(String(state.user.displayName || state.user.username).slice(0, 1).toUpperCase()) + '</b>';
      if (box) box.hidden = true;
      if (buyer && !buyer.value.trim()) buyer.value = state.user.displayName || state.user.username;
    } else {
      if (label) label.textContent = '로그인';
      if (avatar) avatar.innerHTML = '<svg class="ico"><use href="#i-user"/></svg>';
      if (box) box.hidden = false;
      if (buyer) buyer.value = '';
    }
    const hint = $('checkoutHint');
    if (hint) {
      hint.textContent = state.automation && state.automation.enabled
        ? '자동입금확인 중 · 확인 즉시 지급 정보가 내 보관함에 담깁니다.'
        : '입금 확인 후 지급 정보가 내 보관함에 담깁니다.';
    }
  }

  function openAccount() {
    if (!state.user) {
      openAuth('login', openAccount);
      return;
    }
    renderAccount();
    openModal('accountBackdrop');
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (!state.user || !state.orders.some((order) => order.status === 'pending')) return;
      const previous = {};
      state.orders.forEach((order) => { previous[order.id] = order.status; });
      try {
        const data = await api('/api/auth/me');
        state.orders = Array.isArray(data.orders) ? data.orders : [];
        state.reviewable = Array.isArray(data.reviewable) ? data.reviewable : [];
        state.myReviews = Array.isArray(data.myReviews) ? data.myReviews : [];
        state.orders.forEach((order) => {
          if (previous[order.id] === 'pending' && order.status === 'delivered') {
            toast('입금 확인 완료 · 계정이 자동 지급되었습니다!', 'ok');
            sparkleBurst(window.innerWidth / 2, 120);
          }
        });
        renderAccount();
      } catch (err) {
        /* 일시 오류 무시 */
      }
    }, 12000);
  }
  /* ---------- branding ---------- */
  function applySettings() {
    const s = state.settings || {};
    const setText = (id, value) => {
      const el = $(id);
      if (el && value) el.textContent = value;
    };
    setText('storeName', s.store_name);
    setText('storeTagline', s.tagline);
    setText('footStoreName', s.store_name);
    setText('heroKicker', s.hero_kicker);
    setText('heroTitle', s.hero_title);
    setText('heroDesc', s.hero_desc);
    setText('contactHours', s.open_hours);
    setText('footHours', s.open_hours);
    setText('footNote', s.notice);
    setText('footBusiness', s.business_info);
    setText('footCopy', '© ' + (s.store_name || 'Apex shop') + ' · 자동입금확인 · 자동지급');
    document.title = (s.store_name || 'Apex shop') + ' — Apex 레전드 계정 · 코인';

    const href = safeHref(s.contact_url);
    const label = s.contact_label || '디스코드 문의';
    ['contactLink', 'footContact', 'heroContact'].forEach((id) => {
      const link = $(id);
      if (!link) return;
      if (href) {
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
      }
      const span = link.querySelector('span');
      if (span) span.textContent = label;
      else link.textContent = label;
    });

    const chip = $('autoChip');
    if (chip) {
      if (state.automation && state.automation.enabled) {
        const delay = Math.max(0, Number(state.automation.delayMinutes) || 0);
        const text = $('autoChipText');
        if (text) {
          text.textContent = '자동입금확인 ON · ' + (delay === 0 ? '결제 즉시 자동지급' : delay + '분 내 자동 확인 · 즉시 지급');
        }
        chip.hidden = false;
      } else {
        chip.hidden = true;
      }
    }

    const notice = $('noticeBar');
    if (notice) {
      if (s.notice) {
        notice.textContent = s.notice;
        notice.hidden = false;
      } else {
        notice.hidden = true;
      }
    }
  }

  function renderStats() {
    countUp($('statProducts'), state.products.length);
    countUp($('statStock'), state.products.reduce((sum, product) => sum + Math.max(0, product.stock), 0));
    countUp($('statReviews'), state.reviews.length);
  }

  /* ---------- filters ---------- */
  function uniqueValues(list, key) {
    const out = [];
    list.forEach((item) => {
      const value = item[key];
      if (value && out.indexOf(value) === -1) out.push(value);
    });
    return out;
  }

  function renderTabs() {
    const box = $('catTabs');
    if (!box) return;
    const categories = ['전체'].concat(uniqueValues(state.products, 'category'));
    box.innerHTML = categories.map((category) => {
      const count = category === '전체'
        ? state.products.length
        : state.products.filter((product) => product.category === category).length;
      const active = state.filter.category === category;
      return '<button type="button" class="tab' + (active ? ' is-active' : '') + '" role="tab" aria-selected="' +
        active + '" data-cat="' + esc(category) + '">' + esc(category) +
        '<span class="tab-count">' + count + '</span></button>';
    }).join('');
  }

  function renderGameRow() {
    const box = $('gameChips');
    if (!box) return;
    const games = uniqueValues(state.products, 'game');
    if (games.length < 2) {
      box.hidden = true;
      box.innerHTML = '';
      state.filter.game = '전체';
      return;
    }
    box.hidden = false;
    box.innerHTML = ['전체'].concat(games).map((game) =>
      '<button type="button" class="game-chip' + (state.filter.game === game ? ' is-active' : '') +
      '" data-game="' + esc(game) + '"><i class="dot"></i>' + esc(game) + '</button>'
    ).join('');
  }

  function filteredProducts() {
    const list = state.products.filter((product) => {
      if (state.filter.category !== '전체' && product.category !== state.filter.category) return false;
      if (state.filter.game !== '전체' && product.game !== state.filter.game) return false;
      return true;
    });
    const sorted = list.slice();
    if (state.sort === 'priceAsc') sorted.sort((a, b) => a.price - b.price);
    else if (state.sort === 'priceDesc') sorted.sort((a, b) => b.price - a.price);
    else if (state.sort === 'popular') sorted.sort((a, b) => b.stockUsed - a.stockUsed || a.price - b.price);
    else sorted.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return sorted;
  }
  /* ---------- product grid ---------- */
  function gradeClass(grade) {
    const value = String(grade || '');
    if (/프레데터|전설|신화|한정|legend|mythic|predator/i.test(value)) return 'is-legend';
    if (/마스터|에픽|영웅|epic|hero|master/i.test(value)) return 'is-epic';
    if (/다이아|레어|희귀|rare|diamond/i.test(value)) return 'is-rare';
    return '';
  }

  function stockLabel(product) {
    if (product.stock <= 0) return '<span class="stock is-oos">재고 없음</span>';
    if (product.stock <= 2) return '<span class="stock is-low">' + product.stock + '개 남음</span>';
    return '<span class="stock">재고 ' + product.stock + '개</span>';
  }

  function cardHtml(product, index) {
    const soldOut = product.stock <= 0;
    const spec = product.summary || product.description || '';
    const gameLabel = state.games.length > 1 ? '<p class="card-game">' + esc(product.game) + '</p>' : '';
    const actions = soldOut
      ? ''
      : '<div class="card-actions">' +
        '<button class="card-add" type="button" data-action="add" data-id="' + product.id + '">담기</button>' +
        '<button class="card-buy" type="button" data-action="buy" data-id="' + product.id + '">구매</button>' +
        '</div>';
    const image = String(product.image || '');
    /* 이미지가 있으면 사진을, 없으면 이모지를 크게 보여줍니다. */
    const media = image
      ? '<img class="card-img" src="' + esc(image) + '" alt="' + esc(product.name) + '" loading="lazy" decoding="async">'
      : '<span class="card-glyph" aria-hidden="true">' + esc(product.emoji || '🎮') + '</span>';
    const order = Math.max(0, Number(index) || 0);
    return '<article class="card' + (soldOut ? ' is-oos' : '') + (image ? ' has-img' : '') +
      '" data-id="' + product.id + '" data-action="detail" style="--i:' + order + '">' +
      '<div class="card-media tint-' + esc(product.tint || 'violet') + '">' +
      '<span class="grade ' + gradeClass(product.grade) + '">' + esc(product.grade || '일반') + '</span>' +
      (soldOut ? '<span class="oos">품절</span>' : '<span class="card-live"><i></i>즉시지급</span>') +
      media +
      '<span class="card-shine" aria-hidden="true"></span>' +
      '<button class="card-hit" type="button" data-action="detail" data-id="' + product.id +
      '" aria-label="' + esc(product.name) + ' 상세 보기"></button></div>' +
      '<div class="card-body">' + gameLabel +
      '<h3 class="card-name">' + esc(product.name) + '</h3>' +
      '<p class="card-spec">' + esc(spec) + '</p>' +
      '<div class="card-foot"><div class="card-price">' +
      '<span class="price">' + numeric(product.price) + '<small>원</small></span>' + stockLabel(product) +
      '</div>' + actions + '</div>' +
      '</div></article>';
  }

  function renderShop() {
    const root = $('productAreas');
    if (!root) return;
    const list = filteredProducts();
    const countTag = $('resultCount');
    if (countTag) countTag.textContent = list.length + '개';
    const empty = $('emptyState');
    if (empty) empty.hidden = list.length > 0;
    if (!list.length) {
      root.innerHTML = '';
      return;
    }
    const groups = [];
    list.forEach((product) => {
      const found = groups.find((group) => group.category === product.category);
      if (found) found.items.push(product);
      else groups.push({ category: product.category, items: [product] });
    });
    root.innerHTML = groups.map((group) =>
      '<section class="group" data-reveal><div class="group-head">' +
      '<h2>' + esc(group.category) + '</h2>' +
      '<span class="sec-count">' + group.items.length + '개</span></div>' +
      '<div class="grid">' + group.items.map((item, index) => cardHtml(item, index)).join('') + '</div></section>'
    ).join('');
    initReveal();
  }

  function renderSkeleton() {
    const root = $('productAreas');
    if (!root) return;
    const card = '<div class="skel"><div class="skel-media"></div><div class="skel-line"></div><div class="skel-line short"></div></div>';
    root.innerHTML = '<div class="skel-grid">' + card.repeat(6) + '</div>';
  }
  /* ---------- checkout ---------- */
  async function submitCheckout() {
    if (!state.cart.length) {
      toast('장바구니가 비어 있습니다.', 'warn');
      return;
    }
    if (!state.user) {
      closeCart();
      openAuth('login', () => {
        openCart();
        submitCheckout();
      });
      toast('로그인하면 바로 주문할 수 있습니다.', 'warn');
      return;
    }
    const form = $('cartForm');
    const fields = form ? form.elements : {};
    const nameInput = fields.buyerName || null;
    const memoInput = fields.memo || null;
    const agreeInput = fields.agree || null;
    const buyerName = String(nameInput ? nameInput.value : '').trim();
    const memo = String(memoInput ? memoInput.value : '').trim();
    const agree = !!(agreeInput && agreeInput.checked);
    if (buyerName.length < 2) {
      toast('입금자명을 2자 이상 입력해 주세요.', 'warn');
      if (nameInput) nameInput.focus();
      return;
    }
    if (!agree) {
      toast('지급 후 환불 불가 안내에 동의해 주세요.', 'warn');
      return;
    }
    const button = $('cartCheckout');
    if (button) {
      button.disabled = true;
      button.textContent = '주문 처리 중…';
    }
    try {
      const result = await api('/api/orders', {
        method: 'POST',
        body: {
          buyerName,
          memo,
          agree,
          items: state.cart.map((line) => ({ productId: line.productId, qty: line.qty }))
        }
      });
      state.cart = [];
      saveCart();
      renderCart();
      closeCart();
      if (form) form.reset();
      renderOrder(result);
      openModal('orderBackdrop');
      toast(result.order && result.order.status === 'delivered'
        ? '입금 확인 · 계정이 자동 지급되었습니다!'
        : '주문이 접수되었습니다.', 'ok');
      if (result.order && result.order.status === 'delivered') sparkleBurst(window.innerWidth / 2, 140);
      await refresh();
      await loadMe();
      renderAccount();
      startPolling();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '주문하기';
      }
    }
  }

  function renderOrder(result) {
    const order = result.order || {};
    const bank = result.bank || {};
    const body = $('orderBody');
    const foot = $('orderFoot');
    if (!body || !foot) return;
    const delivered = order.status === 'delivered';
    const paid = delivered || order.status === 'paid';
    const items = (order.items || []).map((item) =>
      '<li class="order-item"><div class="order-item-line"><span>' + esc(item.name) + ' × ' + item.qty + '</span>' +
      '<strong>' + won(item.subtotal) + '</strong></div>' + credentialsHtml(item) + '</li>'
    ).join('');
    const delay = Math.max(0, Number(state.automation && state.automation.delayMinutes) || 0);
    const bankBlock = paid ? '' :
      '<div class="order-bank">' +
      '<div class="order-line"><span>입금 은행</span><strong>' + esc(bank.name || '-') + '</strong></div>' +
      '<div class="order-line"><span>계좌번호</span><strong>' + esc(bank.account || '-') + '</strong>' +
      '<button class="copy-btn" type="button" data-copy="' + esc(bank.account || '') + '"><svg class="ico"><use href="#i-copy"/></svg>복사</button></div>' +
      '<div class="order-line"><span>예금주</span><strong>' + esc(bank.holder || '-') + '</strong></div>' +
      '<div class="order-line"><span>입금자명</span><strong>' + esc(bank.depositor || '-') + '</strong></div>' +
      '<div class="order-total"><span>입금 금액</span><strong>' + won(order.total) + '</strong></div></div>';
    body.innerHTML =
      '<div class="order-hero ' + (paid ? 'is-ok' : 'is-wait') + '">' +
      '<span class="order-check"><svg class="ico"><use href="#i-' + (paid ? 'check' : 'clock') + '"/></svg></span>' +
      '<span class="eyebrow">' + (delivered ? 'Auto delivered' : paid ? 'Payment confirmed' : 'Order received') + '</span>' +
      '<h2 id="orderTitle">' + (delivered ? '자동 지급 완료!' : paid ? '입금 확인 완료' : '주문이 접수되었습니다') + '</h2>' +
      '<p>' + (paid ? '계정 정보가 내 보관함에 안전하게 저장되었습니다.' : '입금이 확인되는 즉시 계정 정보가 자동 지급됩니다.') + '</p></div>' +
      '<div class="order-code"><span>주문번호</span><strong>' + esc(order.code) + '</strong>' +
      '<button class="copy-btn" type="button" data-copy="' + esc(order.code) + '"><svg class="ico"><use href="#i-copy"/></svg>복사</button></div>' +
      bankBlock +
      '<ul class="order-items">' + items + '</ul>' +
      '<p class="order-note">' + (paid
        ? '지급 정보는 로그인한 계정의 [내 보관함]에서 언제든 다시 확인할 수 있습니다.'
        : '자동입금확인 ' + (delay === 0 ? '즉시' : delay + '분') + ' 설정 · 확인 후 바로 자동 지급됩니다.') + '</p>';
    foot.innerHTML =
      '<button class="btn primary" type="button" data-action="open-account">내 보관함 확인</button>' +
      '<button class="btn quiet" type="button" data-action="close-order">계속 쇼핑하기</button>';
  }
  /* ---------- product detail ---------- */
  const detailCtx = { productId: 0 };

  function setDetailText(id, value) {
    const el = $(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function openDetail(productId) {
    const product = productById(productId);
    if (!product) return;
    detailCtx.productId = product.id;
    const soldOut = product.stock <= 0;

    const media = $('detailMedia');
    if (media) {
      media.className = 'detail-media tint-' + (product.tint || 'violet');
      media.innerHTML = product.image
        ? '<img class="detail-img" src="' + esc(product.image) + '" alt="' + esc(product.name) + '">'
        : '<span class="detail-glyph">' + esc(product.emoji || '🎮') + '</span>';
    }
    const grade = $('detailGrade');
    if (grade) {
      grade.className = 'detail-grade ' + gradeClass(product.grade);
      grade.textContent = product.grade || '일반';
    }
    setDetailText('detailTitle', product.name || '상품 상세');
    setDetailText('detailName', product.name);
    setDetailText('detailSummary', product.summary || '');
    setDetailText('detailPrice', won(product.price));
    setDetailText('detailStock', soldOut ? '품절' : '재고 ' + product.stock + '개');

    /* 상세 설명은 관리자에서 입력한 그대로(줄바꿈 포함) 보여 줍니다. */
    const desc = String(product.description || '').trim();
    const body = $('detailBody');
    if (body) {
      body.textContent = desc || '등록된 상세 설명이 없습니다.';
      body.classList.toggle('is-empty', !desc);
    }

    const addBtn = $('detailAdd');
    if (addBtn) {
      addBtn.disabled = soldOut;
      addBtn.textContent = soldOut ? '품절' : '장바구니 담기';
    }
    const buyBtn = $('detailBuy');
    if (buyBtn) {
      buyBtn.disabled = soldOut;
      buyBtn.textContent = soldOut ? '품절' : '바로 구매';
    }
    openModal('detailBackdrop');
  }

  function detailOrder(mode) {
    const product = productById(detailCtx.productId);
    if (!product) return;
    if (product.stock <= 0) {
      toast('재고가 없습니다. 다음 입고를 기다려 주세요.', 'warn');
      return;
    }
    closeModal('detailBackdrop');
    openQty(product.id, mode);
  }

  /* ---------- reviews ---------- */
  function renderReviews() {
    const section = $('reviews');
    const list = $('reviewList');
    const avg = $('reviewAvg');
    const writeBtn = $('reviewWriteBtn');
    if (!list) return;
    const canWrite = (state.reviewable || []).length > 0;
    if (writeBtn) writeBtn.hidden = !canWrite;
    const reviews = state.reviews.slice(0, 9);
    if (!reviews.length && !canWrite) {
      if (section) section.hidden = true;
      list.innerHTML = '';
      return;
    }
    if (section) section.hidden = false;
    if (avg) {
      if (!state.reviews.length) {
        avg.innerHTML = '아직 후기 없음';
      } else {
        const mean = state.reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / state.reviews.length;
        avg.innerHTML = '<span class="star is-on">★</span>' + mean.toFixed(1) + ' / 5 · 후기 ' + state.reviews.length + '건';
      }
    }
    if (!reviews.length) {
      list.innerHTML = '<p class="review-empty">아직 등록된 후기가 없습니다. 구매하신 상품의 첫 후기를 남겨보세요!</p>';
      return;
    }
    list.innerHTML = reviews.map((review) =>
      '<article class="review" data-reveal><div class="review-top">' + starsHtml(review.rating) +
      (review.verified ? '<span class="verified"><svg class="ico"><use href="#i-check"/></svg>구매 인증</span>' : '') +
      '</div><p class="review-body">' + esc(review.body) + '</p>' +
      '<div class="review-foot"><span class="review-product">' + esc(review.productName || '') + '</span>' +
      '<span>' + esc(review.author) + ' · ' + esc(shortDate(review.createdAt)) + '</span></div></article>'
    ).join('');
    initReveal();
  }

  function syncReviewStars() {
    const buttons = document.querySelectorAll('#reviewStars [data-star]');
    Array.prototype.forEach.call(buttons, (button) => {
      const value = Number(button.getAttribute('data-star'));
      button.classList.toggle('is-on', value <= state.reviewRating);
      button.setAttribute('aria-checked', String(value === state.reviewRating));
    });
  }

  function openReview(productId) {
    if (!state.user) {
      openAuth('login', () => openReview(productId));
      return;
    }
    const items = state.reviewable || [];
    if (!items.length) {
      toast('후기를 작성할 수 있는 상품이 없습니다. 지급 완료 후 다시 시도해 주세요.', 'warn');
      return;
    }
    const targetId = Number(productId);
    state.reviewTarget = items.find((item) => item.productId === targetId) || items[0];
    state.reviewRating = 5;
    const nameEl = $('reviewProductName');
    if (nameEl) nameEl.textContent = state.reviewTarget.productName + ' · ' + state.reviewTarget.orderCode;
    const bodyEl = $('reviewBody');
    if (bodyEl) bodyEl.value = '';
    const errEl = $('reviewError');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    syncReviewStars();
    openModal('reviewBackdrop');
    if (bodyEl) bodyEl.focus();
  }

  async function submitReview(event) {
    if (event) event.preventDefault();
    if (!state.reviewTarget) return;
    const bodyEl = $('reviewBody');
    const errEl = $('reviewError');
    const button = $('reviewSubmit');
    const body = String((bodyEl && bodyEl.value) || '').trim();
    const fail = (message) => {
      if (errEl) {
        errEl.textContent = message;
        errEl.hidden = false;
      }
      toast(message, 'error');
    };
    if (body.length < 5) {
      fail('후기 내용을 5자 이상 입력해 주세요.');
      return;
    }
    if (button) button.disabled = true;
    try {
      const data = await api('/api/reviews', {
        method: 'POST',
        body: { productId: state.reviewTarget.productId, rating: state.reviewRating, body: body }
      });
      state.reviewable = Array.isArray(data.reviewable) ? data.reviewable : [];
      if (Array.isArray(data.reviews)) state.reviews = data.reviews;
      if (data.review) state.myReviews = [data.review].concat(state.myReviews || []);
      state.reviewTarget = null;
      closeModal('reviewBackdrop');
      renderReviews();
      renderStats();
      renderAccount();
      toast('구매 인증 후기가 등록되었습니다. 감사합니다!', 'ok');
      sparkleBurst(window.innerWidth / 2, 140);
    } catch (err) {
      fail(err.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ---------- data ---------- */
  async function refresh() {
    try {
      const data = await api('/api/store');
      state.settings = data.settings || {};
      state.automation = data.automation || {};
      state.products = Array.isArray(data.products) ? data.products : [];
      state.reviews = Array.isArray(data.reviews) ? data.reviews : [];
      state.games = Array.isArray(data.games) ? data.games : [];
      state.cart = state.cart.filter((line) => {
        const product = productById(line.productId);
        if (!product || product.stock <= 0) return false;
        line.qty = Math.min(line.qty, product.stock);
        return true;
      });
      saveCart();
      applySettings();
      renderStats();
      renderTabs();
      renderGameRow();
      renderShop();
      renderReviews();
      renderCart();
    } catch (err) {
      toast('상품 정보를 불러오지 못했습니다. 페이지를 새로고침해 주세요.', 'error');
      const root = $('productAreas');
      if (root) root.innerHTML = '';
      const empty = $('emptyState');
      if (empty) empty.hidden = false;
    }
  }

  /* ---------- scroll ---------- */
  function initScrollSpy() {
    const links = Array.prototype.slice.call(document.querySelectorAll('.nav-link'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    const map = new Map();
    links.forEach((link) => {
      const id = (link.getAttribute('href') || '').replace('#', '');
      const section = id ? document.getElementById(id) : null;
      if (section) map.set(section, link);
    });
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((link) => link.classList.remove('is-active'));
        const link = map.get(entry.target);
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    map.forEach((link, section) => observer.observe(section));
  }

  function scrollToEl(el) {
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  /* ---------- actions ---------- */
  function handleAction(action, el) {
    const id = Number(el.getAttribute('data-id'));
    if (action === 'add') {
      openQty(id, 'add');
    } else if (action === 'detail') {
      openDetail(id);
    } else if (action === 'buy') {
      openQty(id, 'buy');
    } else if (action === 'inc') {
      changeQty(id, 1);
    } else if (action === 'dec') {
      changeQty(id, -1);
    } else if (action === 'remove') {
      removeLine(id);
    } else if (action === 'browse') {
      closeCart();
      scrollToEl($('shop'));
    } else if (action === 'close-order') {
      closeModal('orderBackdrop');
    } else if (action === 'open-account') {
      closeModal('orderBackdrop');
      openAccount();
    }
  }

  /* ---------- events ---------- */
  function bindEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const closeTrigger = target.closest('[data-close]');
      if (closeTrigger) {
        closeModal(closeTrigger.getAttribute('data-close'));
        return;
      }

      const copyTrigger = target.closest('[data-copy]');
      if (copyTrigger) {
        copyText(copyTrigger.getAttribute('data-copy') || '');
        return;
      }

      const authTab = target.closest('[data-auth-tab]');
      if (authTab) {
        setAuthMode(authTab.getAttribute('data-auth-tab'));
        return;
      }

      if (target.closest('[data-open-account]')) {
        openAccount();
        return;
      }

      const reviewTrigger = target.closest('[data-review-product]');
      if (reviewTrigger) {
        openReview(Number(reviewTrigger.getAttribute('data-review-product')));
        return;
      }

      const reviewStar = target.closest('#reviewStars [data-star]');
      if (reviewStar) {
        state.reviewRating = Number(reviewStar.getAttribute('data-star')) || 5;
        syncReviewStars();
        return;
      }

      const actionEl = target.closest('[data-action]');
      if (actionEl && !actionEl.hasAttribute('data-close')) {
        handleAction(actionEl.getAttribute('data-action'), actionEl);
        return;
      }

      const tab = target.closest('[data-cat]');
      if (tab) {
        state.filter.category = tab.getAttribute('data-cat');
        renderTabs();
        renderShop();
        return;
      }

      const game = target.closest('[data-game]');
      if (game) {
        state.filter.game = game.getAttribute('data-game');
        renderGameRow();
        renderShop();
      }
    });

    const accountButton = $('accountButton');
    if (accountButton) accountButton.addEventListener('click', openAccount);
    const reviewWriteBtn = $('reviewWriteBtn');
    if (reviewWriteBtn) reviewWriteBtn.addEventListener('click', () => openReview());
    const reviewForm = $('reviewForm');
    if (reviewForm) reviewForm.addEventListener('submit', submitReview);
    const accountShop = $('accountShopBtn');
    if (accountShop) accountShop.addEventListener('click', () => closeModal('accountBackdrop'));
    const accountLogout = $('accountLogout');
    if (accountLogout) accountLogout.addEventListener('click', logout);

    const cartButton = $('cartButton');
    if (cartButton) cartButton.addEventListener('click', openCart);
    const cartClose = $('cartClose');
    if (cartClose) cartClose.addEventListener('click', closeCart);
    const cartBackdrop = $('cartBackdrop');
    if (cartBackdrop) cartBackdrop.addEventListener('click', closeCart);
    const cartContinue = $('cartContinue');
    if (cartContinue) {
      cartContinue.addEventListener('click', () => {
        closeCart();
        scrollToEl($('shop'));
      });
    }
    const cartAuthBtn = $('cartAuthBtn');
    if (cartAuthBtn) cartAuthBtn.addEventListener('click', () => openAuth('login'));
    const cartCheckout = $('cartCheckout');
    if (cartCheckout) cartCheckout.addEventListener('click', submitCheckout);
    const cartForm = $('cartForm');
    if (cartForm) {
      cartForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitCheckout();
      });
    }

    const authForm = $('authForm');
    if (authForm) authForm.addEventListener('submit', submitAuth);

    const qtyInput = $('qtyInput');
    const qtyMinus = $('qtyMinus');
    if (qtyMinus) {
      qtyMinus.addEventListener('click', () => {
        if (!qtyInput) return;
        qtyInput.value = String(Math.max(1, (Number(qtyInput.value) || 1) - 1));
        syncQtyTotal();
      });
    }
    const qtyPlus = $('qtyPlus');
    if (qtyPlus) {
      qtyPlus.addEventListener('click', () => {
        if (!qtyInput) return;
        qtyInput.value = String((Number(qtyInput.value) || 1) + 1);
        syncQtyTotal();
      });
    }
    if (qtyInput) {
      qtyInput.addEventListener('input', syncQtyTotal);
      qtyInput.addEventListener('blur', syncQtyTotal);
    }
    const qtyConfirm = $('qtyConfirm');
    if (qtyConfirm) qtyConfirm.addEventListener('click', confirmQty);

    const detailAdd = $('detailAdd');
    if (detailAdd) detailAdd.addEventListener('click', () => detailOrder('add'));
    const detailBuy = $('detailBuy');
    if (detailBuy) detailBuy.addEventListener('click', () => detailOrder('buy'));

    const sort = $('sortSelect');
    if (sort) {
      sort.addEventListener('change', () => {
        state.sort = sort.value;
        renderShop();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const order = ['accountBackdrop', 'authBackdrop', 'orderBackdrop', 'qtyBackdrop', 'detailBackdrop'];
      for (let i = 0; i < order.length; i += 1) {
        const el = $(order[i]);
        if (el && !el.hidden) {
          closeModal(order[i]);
          return;
        }
      }
      const drawer = $('cartDrawer');
      if (drawer && drawer.classList.contains('is-open')) closeCart();
    });

    initScrollSpy();
  }

  /* ---------- init ---------- */
  function init() {
    loadCart();
    renderSkeleton();
    renderCart();
    bindEvents();
    initFx();
    refresh();
    loadMe().then(() => {
      applyUser();
      startPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }









})();
