/* ============================================================
   판매자 관리 페이지 (/admin) — 로그인 · 주문 · 상품 · 후기 · 설정
   ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const wonFmt = new Intl.NumberFormat('ko-KR');
  const state = {
    data: null,
    tab: 'dashboard',
    editingId: null,
    stockProductId: null,
    orderQuery: '',
    orderStatus: 'all',
    userQuery: ''
  };

  const SETTING_GROUPS = [
    {
      title: '브랜드 · 메인 문구',
      fields: [
        { key: 'store_name', label: '상점 이름' },
        { key: 'tagline', label: '한 줄 소개' },
        { key: 'hero_kicker', label: '메인 상단 배지 문구' },
        { key: 'hero_title', label: '메인 제목', multiline: true },
        { key: 'hero_desc', label: '메인 설명', multiline: true },
        { key: 'open_hours', label: '운영 시간 문구' },
        { key: 'notice', label: '상단 공지 문구', multiline: true }
      ]
    },
    {
      title: '입금 · 자동화',
      fields: [
        { key: 'bank_name', label: '입금 은행' },
        { key: 'bank_account', label: '계좌번호' },
        { key: 'bank_holder', label: '예금주' },
        { key: 'auto_confirm', label: '자동입금확인', type: 'select', options: [['1', 'ON — 자동 확인'], ['0', 'OFF — 관리자 직접 확인']] },
        { key: 'auto_confirm_delay', label: '자동확인 지연 (분, 0=즉시)', type: 'number' },
        { key: 'auto_deliver', label: '입금확인 즉시 자동지급', type: 'select', options: [['1', 'ON — 즉시 지급'], ['0', 'OFF — 지급완료 수동 처리']] }
      ]
    },
    {
      title: '문의 · 사업자 정보',
      fields: [
        { key: 'contact_label', label: '문의 버튼 이름' },
        { key: 'contact_url', label: '문의 링크 (디스코드 초대 URL)' },
        { key: 'business_info', label: '사업자 정보', multiline: true }
      ]
    }
  ];
  const SETTING_FIELDS = SETTING_GROUPS.reduce((all, group) => all.concat(group.fields), []);

  const STATUS_LABEL = { pending: '입금대기', paid: '입금확인', delivered: '지급완료', canceled: '취소' };

  /* ---------- helpers ---------- */
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function won(value) {
    return wonFmt.format(Number(value) || 0) + '원';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.getFullYear() + '.' + pad2(d.getMonth() + 1) + '.' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function stars(rating) {
    const n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  }

  function toast(message, type) {
    const stack = $('toastStack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 260);
    }, 2600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(String(text));
      } else {
        const area = document.createElement('textarea');
        area.value = String(text);
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('복사했습니다.', 'ok');
    } catch (err) {
      toast('복사에 실패했습니다. 직접 선택해 주세요.', 'warn');
    }
  }

  function initClickFx() {
    document.addEventListener('pointerdown', (event) => {
      if (!(event.target instanceof Element)) return;
      const el = event.target.closest('.btn, .tab-btn, .stat-card');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = size + 'px';
      span.style.height = size + 'px';
      span.style.left = (event.clientX - rect.left - size / 2) + 'px';
      span.style.top = (event.clientY - rect.top - size / 2) + 'px';
      el.appendChild(span);
      setTimeout(() => span.remove(), 700);
    }, { passive: true });
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {}, credentials: 'same-origin' }, options || {});
    if (opts.body !== undefined && typeof opts.body !== 'string') {
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
    if (res.status === 401) showLogin();
    if (!res.ok) throw new Error((data && data.error) || '요청을 처리하지 못했습니다.');
    return data;
  }

  /* ---------- 화면 전환 ---------- */
  function showLogin() {
    $('adminApp').hidden = true;
    $('loginScreen').hidden = false;
    $('loginError').hidden = true;
    $('loginPassword').value = '';
  }

  function showApp() {
    $('loginScreen').hidden = true;
    $('adminApp').hidden = false;
    $('loginError').hidden = true;
  }

  /* ---------- 데이터 ---------- */
  async function loadData() {
    const data = await api('/api/admin/data');
    state.data = data;
    renderAll();
  }

  function renderAll() {
    if (!state.data) return;
    renderDashboard();
    renderOrders();
    renderProducts();
    renderReviews();
    renderRestock();
    renderUsers();
    renderSettings();
    renderBadges();
  }

  function renderBadges() {
    const stats = state.data.stats || {};
    const pending = $('badgeOrders');
    pending.textContent = String(stats.pendingCount || 0);
    pending.hidden = !stats.pendingCount;
    const restock = $('badgeRestock');
    restock.textContent = String(stats.restockWaiting || 0);
    restock.hidden = !stats.restockWaiting;
    const users = $('badgeUsers');
    if (users) {
      users.textContent = String(stats.userCount || 0);
      users.hidden = !stats.userCount;
    }
    $('adminStoreName').textContent = (state.data.settings && state.data.settings.store_name) || '판매자 관리';
  }

  /* ---------- 자동입금확인 ---------- */
  function renderAutoPanel() {
    const auto = state.data.automation || {};
    const box = $('autoPanel');
    if (!box) return;
    const delay = Math.max(0, Number(auto.delayMinutes) || 0);
    box.innerHTML =
      '<div class="auto-status ' + (auto.enabled ? 'on' : 'off') + '">' +
      '<span class="auto-dot"></span>' +
      '<div class="auto-copy"><strong>자동입금확인 ' + (auto.enabled ? 'ON' : 'OFF') + '</strong>' +
      '<span>' + (auto.enabled
        ? (delay === 0 ? '주문 즉시 확인 · 즉시 자동지급' : delay + '분 후 자동 확인 · 즉시 자동지급')
        : '입금대기 주문을 관리자가 직접 확인합니다.') + '</span></div>' +
      '<span class="pill-tag ' + (auto.autoDeliver ? 'on' : 'off') + '">' +
      (auto.autoDeliver ? '자동지급 ON' : '수동 지급') + '</span>' +
      '<button class="btn tiny ' + (auto.enabled ? 'ghost' : 'primary') + '" type="button" data-action="toggle-auto" data-enabled="' +
      (auto.enabled ? '0' : '1') + '">' + (auto.enabled ? '자동확인 끄기' : '자동확인 켜기') + '</button>' +
      '</div>';
  }

  /* ---------- 현황 ---------- */
  function renderDashboard() {
    const stats = state.data.stats || {};
    const orders = state.data.orders || [];
    const products = state.data.products || [];
    renderAutoPanel();

    const cards = [
      { label: '오늘 매출', value: won(stats.revenueToday), cls: '' },
      { label: '오늘 주문', value: (stats.ordersToday || 0) + '건', cls: '' },
      { label: '누적 매출', value: won(stats.revenueTotal), cls: '' },
      { label: '입금 대기', value: (stats.pendingCount || 0) + '건', cls: stats.pendingCount ? 'warn' : '' },
      { label: '회원', value: (stats.userCount || 0) + '명', cls: '' },
      { label: '재고 부족 상품', value: (stats.soldOutCount || 0) + '개', cls: stats.soldOutCount ? 'danger' : '' },
      { label: '남은 계정', value: (stats.stockCount || 0) + '개', cls: '' }
    ];
    $('statGrid').innerHTML = cards
      .map(
        (card) =>
          '<div class="stat-card ' + card.cls + '"><span>' + esc(card.label) + '</span><strong>' +
          esc(card.value) + '</strong></div>'
      )
      .join('');

    const pending = orders.filter((order) => order.status === 'pending').slice(0, 6);
    $('pendingList').innerHTML = pending.length
      ? pending
          .map(
            (order) =>
              '<div class="mini-row"><div><span class="mono">' + esc(order.code) + '</span>' +
              '<div class="muted">' + esc(order.buyerName) + ' · ' + esc(won(order.total)) + ' · ' +
              esc(dateTime(order.createdAt)) + '</div></div>' +
              '<div class="right"><button class="btn tiny primary" data-action="order-confirm" data-id="' +
              order.id + '">입금확인 → 즉시지급</button></div></div>'
          )
          .join('')
      : '<p class="mini-empty">입금 대기 중인 주문이 없습니다.</p>';

    const lowStock = products.filter((product) => product.visible && product.stock <= 0);
    $('lowStockList').innerHTML = lowStock.length
      ? lowStock
          .map(
            (product) =>
              '<div class="mini-row"><div><strong>' + esc(product.name) + '</strong>' +
              '<div class="muted">' + esc(product.game) + ' · ' +
              (product.stockMode === 'auto' ? '자동 재고' : '수동 재고') + '</div></div>' +
              '<div class="right"><button class="btn tiny ghost" data-action="stock-product" data-id="' +
              product.id + '">재고 관리</button></div></div>'
          )
          .join('')
      : '<p class="mini-empty">재고가 부족한 상품이 없습니다.</p>';
  }

  /* ---------- 주문 ---------- */
  function filteredOrders() {
    const query = state.orderQuery.trim().toLowerCase();
    return (state.data.orders || []).filter((order) => {
      if (state.orderStatus !== 'all' && order.status !== state.orderStatus) return false;
      if (!query) return true;
      return (
        String(order.code || '').toLowerCase().indexOf(query) !== -1 ||
        String(order.buyerName || '').toLowerCase().indexOf(query) !== -1 ||
        String(order.username || '').toLowerCase().indexOf(query) !== -1
      );
    });
  }

  function orderActions(order) {
    if (order.status === 'canceled') {
      return '<span class="muted small">취소된 주문입니다. 재고는 자동으로 복구되었습니다.</span>';
    }
    const buttons = [];
    if (order.status === 'pending') {
      buttons.push(
        '<button class="btn tiny primary" data-action="order-confirm" data-id="' + order.id +
        '">입금확인 → 즉시지급</button>'
      );
    }
    if (order.status === 'paid') {
      buttons.push(
        '<button class="btn tiny primary" data-action="order-status" data-id="' + order.id +
        '" data-status="delivered">지급완료 처리</button>'
      );
    }
    if (order.status === 'delivered') {
      buttons.push('<span class="pill-tag on">지급 완료</span>');
    }
    if (order.status === 'paid') {
      buttons.push(
        '<button class="btn tiny ghost" data-action="order-status" data-id="' + order.id +
        '" data-status="pending">입금대기로 되돌리기</button>'
      );
    }
    buttons.push(
      '<button class="btn tiny danger" data-action="order-status" data-id="' + order.id +
      '" data-status="canceled">주문 취소</button>'
    );
    return buttons.join('');
  }

  function renderOrders() {
    const list = filteredOrders();
    const box = $('orderList');
    if (!list.length) {
      box.innerHTML = '<p class="mini-empty">조건에 맞는 주문이 없습니다.</p>';
      return;
    }
    box.innerHTML = list
      .map((order) => {
        const items = (order.items || [])
          .map((item) => {
            const creds = Array.isArray(item.credentials) && item.credentials.length
              ? '<ul class="cred-list">' +
                item.credentials.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>'
              : '';
            return (
              '<div class="order-item-admin"><div class="line"><span>' + esc(item.name) + ' × ' +
              item.qty + '</span><strong>' + esc(won(item.subtotal)) + '</strong></div>' +
              creds + '</div>'
            );
          })
          .join('');
        return (
          '<article class="order-card ' + esc(order.status) + '">' +
          '<div class="order-top"><span class="code">' + esc(order.code) + '</span>' +
          '<span class="status ' + esc(order.status) + '">' +
          esc(order.statusLabel || STATUS_LABEL[order.status] || order.status) + '</span>' +
          '<span class="total">' + esc(won(order.total)) + '</span></div>' +
          '<div class="order-meta">' +
          '<span>입금자 <b>' + esc(order.buyerName) + '</b></span>' +
          (order.username ? '<span>회원 <b>@' + esc(order.username) + '</b></span>' : '') +
          '<span>주문 ' + esc(dateTime(order.createdAt)) + '</span>' +
          '<span>입금 ' + esc(dateTime(order.paidAt)) + '</span>' +
          '</div>' +
          '<div class="order-body">' + items +
          (order.memo ? '<div class="muted small">요청사항: ' + esc(order.memo) + '</div>' : '') +
          '</div>' +
          '<div class="order-actions">' + orderActions(order) + '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  /* ---------- 상품 ---------- */
  function renderProducts() {
    const list = state.data.products || [];
    const box = $('productList');
    box.innerHTML = list.length
      ? list
          .map((product) => {
            return (
              '<div class="table-row' + (product.visible ? '' : ' dim') + '">' +
              '<div class="table-main">' +
              '<div class="table-thumb tint-' + esc(product.tint) + '">' + esc(product.emoji) + '</div>' +
              '<div class="table-text"><strong>' + esc(product.name) + '</strong>' +
              '<small>' + esc(product.game) + ' · ' + esc(product.category) + ' · ' + esc(product.grade) +
              ' · ' + esc(won(product.price)) + '</small></div></div>' +
              '<div class="table-nums">' +
              '<span>재고 <b>' + product.stock + '</b></span>' +
              '<span>지급 <b>' + product.stockUsed + '</b></span>' +
              '<span class="pill-tag ' + (product.stockMode === 'auto' ? 'auto' : '') + '">' +
              (product.stockMode === 'auto' ? '자동' : '수동 ' + product.manualStock) + '</span>' +
              '<span class="pill-tag ' + (product.visible ? 'on' : 'off') + '">' +
              (product.visible ? '노출' : '숨김') + '</span>' +
              '</div>' +
              '<div class="table-actions">' +
              '<button class="btn tiny ghost" type="button" data-action="edit-product" data-id="' +
              product.id + '">수정</button>' +
              '<button class="btn tiny ghost" type="button" data-action="stock-product" data-id="' +
              product.id + '">재고</button>' +
              '<button class="btn tiny ghost" type="button" data-action="toggle-product" data-id="' +
              product.id + '" data-visible="' + (product.visible ? '0' : '1') + '">' +
              (product.visible ? '숨기기' : '노출') + '</button>' +
              '<button class="btn tiny danger" type="button" data-action="delete-product" data-id="' +
              product.id + '">삭제</button>' +
              '</div></div>'
            );
          })
          .join('')
      : '<p class="mini-empty">등록된 상품이 없습니다. 위 폼에서 첫 상품을 추가해 보세요.</p>';

    const select = $('reviewProduct');
    const current = select.value;
    select.innerHTML =
      '<option value="">상품 선택 안 함</option>' +
      list
        .map((product) => '<option value="' + product.id + '">' + esc(product.name) + '</option>')
        .join('');
    if (current) select.value = current;
  }

  function fillProductForm(product) {
    const form = $('productForm');
    state.editingId = product ? product.id : null;
    $('productFormTitle').textContent = product ? '상품 수정 — ' + product.name : '새 상품 추가';
    $('productSubmit').textContent = product ? '수정 저장' : '상품 저장';
    form.elements.id.value = product ? String(product.id) : '';
    if (!product) {
      form.reset();
      form.elements.sort_order.value = '100';
      form.elements.manual_stock.value = '0';
      form.elements.visible.value = '1';
      return;
    }
    form.elements.game.value = product.game;
    form.elements.category.value = product.category;
    form.elements.grade.value = product.grade;
    form.elements.emoji.value = product.emoji;
    form.elements.tint.value = product.tint;
    form.elements.price.value = String(product.price);
    form.elements.stock_mode.value = product.stockMode;
    form.elements.manual_stock.value = String(product.manualStock);
    form.elements.sort_order.value = String(product.sortOrder);
    form.elements.visible.value = product.visible ? '1' : '0';
    form.elements.name.value = product.name;
    form.elements.summary.value = product.summary || '';
    form.elements.description.value = product.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function submitProduct(form) {
    const fields = form.elements;
    const payload = {
      game: fields.game.value.trim(),
      category: fields.category.value.trim(),
      grade: fields.grade.value.trim(),
      name: fields.name.value.trim(),
      summary: fields.summary.value.trim(),
      description: fields.description.value.trim(),
      price: Number(fields.price.value) || 0,
      emoji: fields.emoji.value.trim(),
      tint: fields.tint.value,
      stockMode: fields.stock_mode.value,
      manualStock: Number(fields.manual_stock.value) || 0,
      sortOrder: Number(fields.sort_order.value) || 0,
      visible: fields.visible.value === '1'
    };
    if (!payload.name) {
      toast('상품명을 입력해 주세요.', 'warn');
      return;
    }
    const button = $('productSubmit');
    button.disabled = true;
    try {
      const editing = state.editingId;
      if (editing) {
        await api('/api/admin/products/' + editing, { method: 'PATCH', body: payload });
        toast('상품을 수정했습니다.', 'ok');
      } else {
        await api('/api/admin/products', { method: 'POST', body: payload });
        toast('상품을 추가했습니다.', 'ok');
      }
      fillProductForm(null);
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  /* ---------- 재고풀 ---------- */
  async function openStock(productId) {
    state.stockProductId = Number(productId);
    const product = (state.data.products || []).find((entry) => entry.id === Number(productId));
    $('stockTitle').textContent = '재고풀 — ' + (product ? product.name : '');
    $('stockBody').innerHTML = '<p class="mini-empty">불러오는 중…</p>';
    $('stockBackdrop').hidden = false;
    document.body.classList.add('locked');
    try {
      const data = await api('/api/admin/products/' + productId + '/stock');
      renderStock(data.stock || [], product);
    } catch (err) {
      $('stockBody').innerHTML = '<p class="mini-empty">' + esc(err.message) + '</p>';
    }
  }

  function closeStock() {
    $('stockBackdrop').hidden = true;
    document.body.classList.remove('locked');
    state.stockProductId = null;
  }

  function renderStock(stock, product) {
    const used = stock.filter((item) => item.used);
    const free = stock.filter((item) => !item.used);
    const manual = product && product.stockMode === 'manual';
    const rows = stock.length
      ? stock
          .map(
            (item) =>
              '<div class="stock-row' + (item.used ? ' used' : '') + '">' +
              '<span class="cred">' + esc(item.credential) + '</span>' +
              (item.note ? '<span class="meta">' + esc(item.note) + '</span>' : '') +
              '<span class="meta">' + (item.used ? '지급 ' + esc(item.orderCode || '') : '대기') + '</span>' +
              (item.used
                ? ''
                : '<button class="btn tiny danger" type="button" data-action="delete-stock" data-id="' +
                  item.id + '">삭제</button>') +
              '</div>'
          )
          .join('')
      : '<p class="mini-empty">등록된 지급 정보가 없습니다.</p>';

    $('stockBody').innerHTML =
      '<div class="stock-summary">' +
      '<span>사용 가능 <b>' + free.length + '</b>개</span>' +
      '<span>지급 완료 <b>' + used.length + '</b>개</span>' +
      (manual
        ? '<span class="pill-tag">수동 상품 — 실제 재고는 상품 수정에서 관리</span>'
        : '<span class="pill-tag auto">자동 상품 — 결제 확인 시 위에서 순서대로 지급</span>') +
      '</div>' +
      '<div class="stock-list">' + rows + '</div>' +
      '<div class="stock-add">' +
      '<p class="small muted">한 줄에 하나씩 입력 (예: <span class="mono">id / pw / 2차비번</span>)</p>' +
      '<textarea id="stockLines" placeholder="example@mail.com / P@ssw0rd! / 1234"></textarea>' +
      '<input type="text" id="stockNote" maxlength="200" placeholder="메모 (선택) 예: 2026년 생성 계정">' +
      '<button class="btn primary" type="button" data-action="stock-add">지급 정보 등록</button>' +
      '</div>';
  }

  async function addStock() {
    const lines = $('stockLines');
    const note = $('stockNote');
    if (!lines || !lines.value.trim()) {
      toast('지급 정보를 한 줄에 하나씩 입력해 주세요.', 'warn');
      return;
    }
    const productId = state.stockProductId;
    try {
      const result = await api('/api/admin/products/' + productId + '/stock', {
        method: 'POST',
        body: { credentials: lines.value, note: note ? note.value.trim() : '' }
      });
      toast((result.added || 0) + '개를 등록했습니다.', 'ok');
      const data = await api('/api/admin/products/' + productId + '/stock');
      const product = (state.data.products || []).find((entry) => entry.id === productId);
      renderStock(data.stock || [], product);
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 후기 ---------- */
  function renderReviews() {
    const list = state.data.reviews || [];
    const box = $('reviewListAdmin');
    box.innerHTML = list.length
      ? list
          .map(
            (review) =>
              '<div class="table-row' + (review.visible ? '' : ' dim') + '">' +
              '<div class="table-main"><div class="table-text">' +
              '<strong>' + esc(review.author) + ' <span class="stars">' + stars(review.rating) + '</span></strong>' +
              '<small>' + esc(review.productName || '상품 미지정') + ' · ' + esc(dateTime(review.createdAt)) +
              (review.verified ? ' · 구매인증' : '') + (review.visible ? '' : ' · 숨김 상태') + '</small>' +
              '<div class="review-text">' + esc(review.body) + '</div>' +
              '</div></div>' +
              '<div class="table-actions">' +
              '<button class="btn tiny ghost" type="button" data-action="review-toggle" data-id="' +
              review.id + '" data-visible="' + (review.visible ? '0' : '1') + '">' +
              (review.visible ? '숨기기' : '노출') + '</button>' +
              '<button class="btn tiny danger" type="button" data-action="delete-review" data-id="' +
              review.id + '">삭제</button>' +
              '</div></div>'
          )
          .join('')
      : '<p class="mini-empty">등록된 후기가 없습니다.</p>';
  }

  async function submitReview(form) {
    const data = new FormData(form);
    const payload = {
      productId: Number(data.get('productId')) || null,
      author: String(data.get('author') || '').trim(),
      rating: Number(data.get('rating')) || 5,
      verified: data.get('verified') === '1',
      body: String(data.get('body') || '').trim()
    };
    if (!payload.author || !payload.body) {
      toast('작성자와 후기 내용을 입력해 주세요.', 'warn');
      return;
    }
    try {
      await api('/api/admin/reviews', { method: 'POST', body: payload });
      form.reset();
      toast('후기를 등록했습니다.', 'ok');
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 재입고 ---------- */
  function renderRestock() {
    const list = state.data.restock || [];
    const box = $('restockListAdmin');
    box.innerHTML = list.length
      ? list
          .map(
            (item) =>
              '<div class="table-row' + (item.notifiedAt ? ' dim' : '') + '">' +
              '<div class="table-main"><div class="table-text">' +
              '<strong>' + esc(item.productName) + '</strong>' +
              '<small class="mono">@' + esc(item.username) + (item.displayName ? ' · ' + esc(item.displayName) : '') + '</small>' +
              '</div></div>' +
              '<div class="table-nums">' +
              '<span>신청 <b>' + esc(dateTime(item.createdAt)) + '</b></span>' +
              '<span class="pill-tag ' + (item.notifiedAt ? 'on' : 'off') + '">' +
              (item.notifiedAt ? '알림완료 ' + esc(dateTime(item.notifiedAt)) : '대기중') + '</span>' +
              '</div>' +
              '<div class="table-actions">' +
              (item.notifiedAt
                ? ''
                : '<button class="btn tiny primary" type="button" data-action="restock-notify" data-id="' +
                  item.id + '">알림완료</button>') +
              '</div></div>'
          )
          .join('')
      : '<p class="mini-empty">재입고 알림 신청이 없습니다.</p>';
  }

  /* ---------- 회원 ---------- */
  function filteredUsers() {
    const query = String(state.userQuery || '').trim().toLowerCase();
    const users = state.data.users || [];
    if (!query) return users;
    return users.filter((user) =>
      String(user.username || '').toLowerCase().indexOf(query) !== -1 ||
      String(user.displayName || '').toLowerCase().indexOf(query) !== -1
    );
  }

  function renderUsers() {
    const box = $('userList');
    if (!box) return;
    const list = filteredUsers();
    const tag = $('userCountTag');
    if (tag) tag.textContent = list.length + '명';
    box.innerHTML = list.length
      ? list.map((user) => {
        const initial = String(user.displayName || user.username || 'A').slice(0, 1).toUpperCase();
        return '<div class="table-row' + (user.status === 'blocked' ? ' dim' : '') + '">' +
          '<div class="table-main"><div class="table-thumb user-thumb">' + esc(initial) + '</div>' +
          '<div class="table-text"><strong>' + esc(user.displayName) +
          ' <small class="mono">@' + esc(user.username) + '</small></strong>' +
          '<small>가입 ' + esc(dateTime(user.createdAt)) + ' · 최근 로그인 ' + esc(dateTime(user.lastLoginAt)) + '</small></div></div>' +
          '<div class="table-nums">' +
          '<span>주문 <b>' + user.orderCount + '</b></span>' +
          '<span>결제 <b>' + esc(won(user.spent)) + '</b></span>' +
          '<span class="pill-tag ' + (user.status === 'active' ? 'on' : 'off') + '">' +
          (user.status === 'active' ? '정상' : '차단') + '</span></div>' +
          '<div class="table-actions">' +
          '<button class="btn tiny ghost" type="button" data-action="user-toggle" data-id="' + user.id +
          '" data-status="' + (user.status === 'active' ? 'blocked' : 'active') + '">' +
          (user.status === 'active' ? '차단' : '해제') + '</button>' +
          '<button class="btn tiny ghost" type="button" data-action="user-password" data-id="' + user.id + '">비밀번호 재설정</button>' +
          '<button class="btn tiny danger" type="button" data-action="delete-user" data-id="' + user.id + '">삭제</button>' +
          '</div></div>';
      }).join('')
      : '<p class="mini-empty">조건에 맞는 회원이 없습니다.</p>';
  }

  /* ---------- 설정 ---------- */
  function renderSettings() {
    const settings = state.data.settings || {};
    const fieldHtml = (field) => {
      const value = settings[field.key] === undefined || settings[field.key] === null ? '' : String(settings[field.key]);
      const escValue = esc(value);
      let control;
      if (field.type === 'select') {
        control = '<select name="' + field.key + '">' + (field.options || []).map((option) =>
          '<option value="' + esc(option[0]) + '"' + (String(option[0]) === value ? ' selected' : '') + '>' +
          esc(option[1]) + '</option>'
        ).join('') + '</select>';
      } else if (field.type === 'number') {
        control = '<input type="number" min="0" max="1440" step="1" name="' + field.key + '" value="' + escValue + '">';
      } else if (field.multiline) {
        control = '<textarea name="' + field.key + '" rows="3">' + escValue + '</textarea>';
      } else {
        control = '<input type="text" name="' + field.key + '" value="' + escValue + '">';
      }
      return '<label class="field' + (field.multiline ? ' field-wide' : '') + '">' + esc(field.label) + control + '</label>';
    };
    $('settingsFields').innerHTML = SETTING_GROUPS.map((group) =>
      '<div class="settings-group"><h4>' + esc(group.title) + '</h4>' +
      '<div class="settings-grid">' + group.fields.map(fieldHtml).join('') + '</div></div>'
    ).join('');
    renderWebhook();
  }

  function renderWebhook() {
    const hook = state.data.webhook || {};
    const url = window.location.origin + (hook.path || '/api/hooks/deposit');
    const token = hook.token || '';
    const urlEl = $('webhookUrl');
    const tokenEl = $('webhookToken');
    const sample = $('webhookSample');
    if (urlEl) urlEl.textContent = url;
    if (tokenEl) tokenEl.textContent = token || '-';
    if (sample) {
      sample.textContent = 'curl -X POST "' + url + '" \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        '  -H "x-deposit-token: ' + (token || 'TOKEN') + '" \\\n' +
        '  -d "{\\"code\\":\\"GS000000-XXXX\\"}"';
    }
  }

  async function submitSettings(form) {
    const data = new FormData(form);
    const payload = {};
    SETTING_FIELDS.forEach((field) => {
      payload[field.key] = String(data.get(field.key) || '');
    });
    try {
      await api('/api/admin/settings', { method: 'PATCH', body: payload });
      toast('설정을 저장했습니다.', 'ok');
      await loadData();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function submitPassword(form) {
    const data = new FormData(form);
    const current = String(data.get('current') || '');
    const next = String(data.get('next') || '');
    if (current === next) {
      toast('현재 비밀번호와 다른 값을 입력해 주세요.', 'warn');
      return;
    }
    try {
      await api('/api/admin/password', { method: 'POST', body: { current: current, next: next } });
      form.reset();
      toast('비밀번호를 변경했습니다. 다시 로그인해 주세요.', 'ok');
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------- 탭 ---------- */
  function setTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), (button) => {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.panel'), (panel) => {
      panel.classList.toggle('active', panel.id === 'tab-' + tab);
    });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const button = $('loginSubmit');
    const error = $('loginError');
    error.hidden = true;
    button.disabled = true;
    button.textContent = '확인 중…';
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: $('loginPassword').value } });
      showApp();
      await loadData();
      toast('로그인했습니다.', 'ok');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = '로그인';
    }
  }

  /* ---------- 이벤트 ---------- */
  function bindEvents() {
    $('loginForm').addEventListener('submit', handleLogin);

    $('logoutBtn').addEventListener('click', async () => {
      try {
        await api('/api/admin/logout', { method: 'POST' });
      } catch (err) {
        /* 세션이 이미 만료된 경우 무시 */
      }
      window.location.reload();
    });

    $('refreshBtn').addEventListener('click', async () => {
      try {
        await loadData();
        toast('최신 데이터로 갱신했습니다.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    $('adminTabs').addEventListener('click', (event) => {
      const button = event.target.closest('.tab-btn');
      if (button) setTab(button.getAttribute('data-tab'));
    });

    $('productForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitProduct(event.target);
    });
    $('productReset').addEventListener('click', () => fillProductForm(null));

    $('reviewForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitReview(event.target);
    });
    $('settingsForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitSettings(event.target);
    });
    $('passwordForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitPassword(event.target);
    });

    $('orderSearch').addEventListener('input', (event) => {
      state.orderQuery = event.target.value;
      renderOrders();
    });
    $('orderStatusFilter').addEventListener('change', (event) => {
      state.orderStatus = event.target.value;
      renderOrders();
    });

    const userSearch = $('userSearch');
    if (userSearch) {
      userSearch.addEventListener('input', (event) => {
        state.userQuery = event.target.value;
        renderUsers();
      });
    }

    const autoRun = $('autoRunBtn');
    if (autoRun) {
      autoRun.addEventListener('click', async () => {
        autoRun.disabled = true;
        try {
          const result = await api('/api/admin/auto-confirm', { method: 'POST' });
          toast((result.confirmed || 0) + '건을 자동 확인·지급했습니다.', 'ok');
          await loadData();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          autoRun.disabled = false;
        }
      });
    }

    const webhookCopy = $('webhookCopy');
    if (webhookCopy) {
      webhookCopy.addEventListener('click', () => {
        const url = $('webhookUrl');
        if (url) copyText(url.textContent);
      });
    }
    const tokenCopy = $('webhookTokenCopy');
    if (tokenCopy) {
      tokenCopy.addEventListener('click', () => {
        const token = $('webhookToken');
        if (token) copyText(token.textContent);
      });
    }

    $('stockBackdrop').addEventListener('click', (event) => {
      if (event.target === $('stockBackdrop')) closeStock();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('stockBackdrop').hidden) closeStock();
    });

    document.addEventListener('click', handleAction);
  }

  async function handleAction(event) {
    if (event.target.closest('[data-close]')) {
      closeStock();
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    const id = Number(button.getAttribute('data-id'));

    if (action === 'edit-product') {
      const product = (state.data.products || []).find((entry) => entry.id === id);
      if (product) fillProductForm(product);
      return;
    }

    if (action === 'stock-product') {
      openStock(id);
      return;
    }

    if (action === 'stock-add') {
      await addStock();
      return;
    }

    if (action === 'toggle-product') {
      const visible = button.getAttribute('data-visible') === '1';
      try {
        await api('/api/admin/products/' + id, { method: 'PATCH', body: { visible: visible } });
        toast(visible ? '상품을 노출했습니다.' : '상품을 숨겼습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'delete-product') {
      if (!window.confirm('상품을 삭제할까요? 되돌릴 수 없습니다.')) return;
      try {
        await api('/api/admin/products/' + id, { method: 'DELETE' });
        if (state.editingId === id) fillProductForm(null);
        toast('상품을 삭제했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'delete-stock') {
      if (!window.confirm('이 지급 정보를 삭제할까요?')) return;
      const productId = state.stockProductId;
      try {
        await api('/api/admin/stock/' + id, { method: 'DELETE' });
        toast('지급 정보를 삭제했습니다.', 'ok');
        await loadData();
        if (productId) openStock(productId);
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'order-status') {
      const status = button.getAttribute('data-status');
      if (status === 'canceled' && !window.confirm('주문을 취소할까요? 배정된 재고는 복구됩니다.')) return;
      button.disabled = true;
      try {
        await api('/api/admin/orders/' + id + '/status', { method: 'POST', body: { status: status } });
        toast('주문 상태를 "' + (STATUS_LABEL[status] || status) + '"(으)로 변경했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'order-confirm') {
      button.disabled = true;
      try {
        const result = await api('/api/admin/orders/' + id + '/confirm', { method: 'POST' });
        toast('입금 확인 · ' + ((result.order && result.order.statusLabel) || '지급완료') + ' 처리했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'toggle-auto') {
      const enabled = button.getAttribute('data-enabled') === '1';
      try {
        await api('/api/admin/settings', { method: 'PATCH', body: { auto_confirm: enabled ? '1' : '0' } });
        toast('자동입금확인을 ' + (enabled ? '켰습니다.' : '껐습니다.'), 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'user-toggle') {
      const status = button.getAttribute('data-status');
      try {
        await api('/api/admin/users/' + id, { method: 'PATCH', body: { status } });
        toast(status === 'blocked' ? '회원을 차단했습니다.' : '회원 차단을 해제했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'user-password') {
      const next = window.prompt('새 비밀번호를 입력하세요. (6자 이상)');
      if (!next) return;
      if (next.length < 6) {
        toast('비밀번호는 6자 이상이어야 합니다.', 'warn');
        return;
      }
      try {
        await api('/api/admin/users/' + id, { method: 'PATCH', body: { password: next } });
        toast('비밀번호를 재설정했습니다: ' + next, 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'delete-user') {
      if (!window.confirm('회원을 삭제할까요? 주문 기록은 남지만 계정은 복구할 수 없습니다.')) return;
      try {
        await api('/api/admin/users/' + id, { method: 'DELETE' });
        toast('회원을 삭제했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'review-toggle') {
      const visible = button.getAttribute('data-visible') === '1';
      try {
        await api('/api/admin/reviews/' + id, { method: 'PATCH', body: { visible: visible } });
        toast(visible ? '후기를 노출했습니다.' : '후기를 숨겼습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'delete-review') {
      if (!window.confirm('후기를 삭제할까요?')) return;
      try {
        await api('/api/admin/reviews/' + id, { method: 'DELETE' });
        toast('후기를 삭제했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    if (action === 'restock-notify') {
      try {
        await api('/api/admin/restock/' + id + '/notify', { method: 'POST' });
        toast('알림완료로 표시했습니다.', 'ok');
        await loadData();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }

  /* ---------- 시작 ---------- */
  async function init() {
    bindEvents();
    initClickFx();
    try {
      await api('/api/admin/session');
      showApp();
      await loadData();
    } catch (err) {
      showLogin();
    }
  }

  init();
})();








