/* ============================================================
   GAME SHOP — SQLite 데이터 계층 (Node.js 내장 node:sqlite 사용)
   별도 패키지 설치 없이 동작합니다. (Node 22.5+ / 24 확인)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const depositParser = require('./deposit-parser');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = process.env.SHOP_DB || path.join(DATA_DIR, 'shop.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const ORDER_STATUS = {
  pending: '입금대기',
  paid: '입금확인',
  delivered: '지급완료',
  canceled: '취소'
};

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '계정',
  grade TEXT NOT NULL DEFAULT '일반',
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  emoji TEXT NOT NULL DEFAULT '🎮',
  tint TEXT NOT NULL DEFAULT 'violet',
  image TEXT NOT NULL DEFAULT '',
  stock_mode TEXT NOT NULL DEFAULT 'auto',
  manual_stock INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  credential TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  order_item_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  buyer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  paid_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  product_name TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  body TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 1,
  visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  user_id INTEGER,
  order_id INTEGER
);

CREATE TABLE IF NOT EXISTS restock_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE (product_id, email)
);

CREATE TABLE IF NOT EXISTS restock_waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  UNIQUE (product_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_product ON stock_items(product_id, order_item_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
`);

/* 기존 DB 호환: orders.user_id 컬럼이 없으면 추가 */
(function ensureOrderUserColumn() {
  const columns = db.prepare('PRAGMA table_info(orders)').all();
  if (!columns.some((column) => column.name === 'user_id')) {
    db.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER');
  }
})();

/* 기존 DB 호환: reviews 에 구매 인증용 user_id / order_id 컬럼 추가 */
(function ensureReviewColumns() {
  const names = db.prepare('PRAGMA table_info(reviews)').all().map((column) => column.name);
  if (names.indexOf('user_id') === -1) db.exec('ALTER TABLE reviews ADD COLUMN user_id INTEGER');
  if (names.indexOf('order_id') === -1) db.exec('ALTER TABLE reviews ADD COLUMN order_id INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user_product ON reviews(user_id, product_id) WHERE user_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, visible)');
})();

/* 기존 DB 호환: products.image (상품 이미지) 컬럼 추가 */
(function ensureProductColumns() {
  const names = db.prepare('PRAGMA table_info(products)').all().map((column) => column.name);
  if (names.indexOf('image') === -1) db.exec("ALTER TABLE products ADD COLUMN image TEXT NOT NULL DEFAULT ''");
})();

db.exec(`
CREATE INDEX IF NOT EXISTS idx_stock_order_item ON stock_items(order_item_id);
`);

/* ---------- helpers ---------- */
function nowIso() {
  return new Date().toISOString();
}

function maskName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '구매자';
  if (raw.length === 1) return raw + '*';
  if (raw.length === 2) return raw[0] + '*';
  return raw[0] + '*'.repeat(Math.min(raw.length - 1, 2));
}

function maskEmail(email) {
  const [id, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return id.slice(0, 2) + '***@' + domain;
}

function orderCode() {
  const d = new Date();
  const ymd = String(d.getFullYear()).slice(2)
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i += 1) tail += alphabet[bytes[i] % alphabet.length];
  return 'GS' + ymd + '-' + tail;
}

/* ---------- settings ---------- */
const DEFAULT_SETTINGS = {
  store_name: 'Apex shop',
  tagline: 'Apex 레전드 계정 · 코인 전문 샵',
  hero_kicker: '24시간 자동입금확인 · 확인 즉시 자동지급',
  hero_title: 'Apex 계정, 결제 확인 후 바로 받으세요',
  hero_desc: '회원가입한 계정으로 구매하면 입금 확인 즉시 지급 정보가 내 보관함에 안전하게 담깁니다.',
  bank_name: '국민은행',
  bank_account: '000-000-0000-00',
  bank_holder: '예금주',
  contact_label: '디스코드 문의',
  contact_url: 'https://discord.gg/fUVeQMdWUJ',
  open_hours: '24시간 자동 구매 · 디스코드 문의 상시 접수',
  notice: '입금자명은 주문서와 동일하게 보내 주세요. 자동입금확인이 켜져 있으면 확인 즉시 계정이 자동 지급됩니다.',
  business_info: '상호 / 대표 / 사업자등록번호 / 통신판매업신고 / 고객센터',
  shipping_note: '지급된 계정 정보는 로그인 후 [내 보관함]에서 언제든 다시 확인할 수 있습니다.',
  auto_confirm: '1',
  auto_confirm_delay: '5',
  auto_deliver: '1',
  deposit_expire_minutes: '0',
  deposit_match_name: '1',
  deposit_webhook_key: '',
  webhook_token: ''
};

function ensureWebhookToken() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('webhook_token');
  if (row && row.value) return row.value;
  const token = crypto.randomBytes(18).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('webhook_token', token);
  return token;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  rows.forEach((row) => { stored[row.key] = row.value; });
  return Object.assign({}, DEFAULT_SETTINGS, stored);
}

function setSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  Object.keys(patch || {}).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
    if (key === 'admin_password') return;
    /* 웹훅 키는 관리자 화면의 전용 버튼(재발급)으로만 바꿉니다. */
    if (key === 'deposit_webhook_key' || key === 'webhook_token') return;
    stmt.run(key, String(patch[key] === undefined || patch[key] === null ? '' : patch[key]));
  });
  return getSettings();
}

/* ---------- products ---------- */
const PRODUCT_SELECT = `
  SELECT p.*,
    CASE
      WHEN p.stock_mode = 'manual' THEN p.manual_stock
      ELSE (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.order_item_id IS NULL)
    END AS stock,
    (SELECT COUNT(*) FROM stock_items s WHERE s.product_id = p.id AND s.order_item_id IS NOT NULL) AS stock_used
  FROM products p
`;

function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    game: row.game,
    category: row.category,
    grade: row.grade,
    name: row.name,
    summary: row.summary,
    description: row.description,
    price: row.price,
    emoji: row.emoji,
    tint: row.tint,
    image: row.image || '',
    stockMode: row.stock_mode,
    manualStock: row.manual_stock,
    stock: row.stock || 0,
    stockUsed: row.stock_used || 0,
    visible: !!row.visible,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function listProducts(options) {
  const opts = options || {};
  const where = opts.includeHidden ? '' : ' WHERE p.visible = 1';
  const rows = db.prepare(PRODUCT_SELECT + where + ' ORDER BY p.sort_order ASC, p.id ASC').all();
  return rows.map(mapProduct);
}

function getProduct(id) {
  const row = db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(Number(id));
  return mapProduct(row);
}

const PRODUCT_FIELDS = ['game', 'category', 'grade', 'name', 'summary', 'description', 'price', 'emoji', 'tint', 'image', 'stock_mode', 'manual_stock', 'visible', 'sort_order'];

/*
 * 상품 이미지 값 정규화
 *  - '' (없음)
 *  - /uploads/<파일명>  ← 관리자 페이지에서 업로드한 이미지
 *  - https://... 또는 http://...  ← 외부 이미지 주소
 * 그 외 값(스크립트/상대경로 트래버설 등)은 빈 값으로 떨어뜨립니다.
 */
const IMAGE_VALUE_MAX = 600;

function normalizeImage(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > IMAGE_VALUE_MAX) return '';
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(raw)) return raw;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return raw;
  return '';
}

function createProduct(data) {
  const now = nowIso();
  const row = {
    game: String(data.game || '').trim() || '기타',
    category: String(data.category || '계정').trim() || '계정',
    grade: String(data.grade || '일반').trim() || '일반',
    name: String(data.name || '').trim(),
    summary: String(data.summary || '').trim(),
    description: String(data.description || '').trim(),
    price: Math.max(0, Math.round(Number(data.price) || 0)),
    emoji: String(data.emoji || '🎮').slice(0, 8),
    tint: String(data.tint || 'violet').trim() || 'violet',
    image: normalizeImage(data.image),
    stock_mode: data.stockMode === 'manual' ? 'manual' : 'auto',
    manual_stock: Math.max(0, Math.round(Number(data.manualStock) || 0)),
    visible: data.visible === false ? 0 : 1,
    sort_order: Math.round(Number(data.sortOrder) || 0),
    created_at: now,
    updated_at: now
  };
  if (!row.name) throw new AppError(400, '상품명을 입력해 주세요.');
  const stmt = db.prepare(`INSERT INTO products (${PRODUCT_FIELDS.join(', ')}, created_at, updated_at)
    VALUES (${PRODUCT_FIELDS.map(() => '?').join(', ')}, ?, ?)`);
  const result = stmt.run(...PRODUCT_FIELDS.map((field) => row[field]), row.created_at, row.updated_at);
  return getProduct(Number(result.lastInsertRowid));
}

function updateProduct(id, data) {
  const current = getProduct(id);
  if (!current) throw new AppError(404, '상품을 찾을 수 없습니다.');
  const row = {
    game: data.game === undefined ? current.game : String(data.game).trim() || '기타',
    category: data.category === undefined ? current.category : String(data.category).trim() || '계정',
    grade: data.grade === undefined ? current.grade : String(data.grade).trim() || '일반',
    name: data.name === undefined ? current.name : String(data.name).trim(),
    summary: data.summary === undefined ? current.summary : String(data.summary).trim(),
    description: data.description === undefined ? current.description : String(data.description).trim(),
    price: data.price === undefined ? current.price : Math.max(0, Math.round(Number(data.price) || 0)),
    emoji: data.emoji === undefined ? current.emoji : String(data.emoji).slice(0, 8) || '🎮',
    tint: data.tint === undefined ? current.tint : String(data.tint).trim() || 'violet',
    image: data.image === undefined ? current.image : normalizeImage(data.image),
    stock_mode: data.stockMode === undefined ? (current.stockMode === 'manual' ? 'manual' : 'auto') : (data.stockMode === 'manual' ? 'manual' : 'auto'),
    manual_stock: data.manualStock === undefined ? current.manualStock : Math.max(0, Math.round(Number(data.manualStock) || 0)),
    visible: data.visible === undefined ? (current.visible ? 1 : 0) : (data.visible ? 1 : 0),
    sort_order: data.sortOrder === undefined ? current.sortOrder : Math.round(Number(data.sortOrder) || 0),
    updated_at: nowIso()
  };
  if (!row.name) throw new AppError(400, '상품명을 입력해 주세요.');
  db.prepare(`UPDATE products SET ${PRODUCT_FIELDS.map((field) => field + ' = ?').join(', ')} WHERE id = ?`)
    .run(...PRODUCT_FIELDS.map((field) => row[field]), Number(id));
  return getProduct(id);
}

function deleteProduct(id) {
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(Number(id));
  if (!result.changes) throw new AppError(404, '상품을 찾을 수 없습니다.');
  return { ok: true };
}

/* ---------- stock pool (지급 정보) ---------- */
function listStock(productId) {
  return db.prepare(`
    SELECT s.id, s.product_id, s.credential, s.note, s.order_item_id, s.created_at,
           oi.order_id, o.code AS order_code
    FROM stock_items s
    LEFT JOIN order_items oi ON oi.id = s.order_item_id
    LEFT JOIN orders o ON o.id = oi.order_id
    WHERE s.product_id = ?
    ORDER BY (s.order_item_id IS NOT NULL) ASC, s.id ASC
  `).all(Number(productId)).map((row) => ({
    id: row.id,
    productId: row.product_id,
    credential: row.credential,
    note: row.note,
    used: !!row.order_item_id,
    orderCode: row.order_code || null,
    createdAt: row.created_at
  }));
}

function addStock(productId, lines, note) {
  const product = getProduct(productId);
  if (!product) throw new AppError(404, '상품을 찾을 수 없습니다.');
  const list = String(lines || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!list.length) throw new AppError(400, '지급 정보를 한 줄에 하나씩 입력해 주세요.');
  if (list.length > 500) throw new AppError(400, '한 번에 최대 500개까지 등록할 수 있습니다.');
  const stmt = db.prepare('INSERT INTO stock_items (product_id, credential, note, created_at) VALUES (?, ?, ?, ?)');
  const now = nowIso();
  db.exec('BEGIN');
  try {
    list.forEach((credential) => stmt.run(Number(productId), credential.slice(0, 500), String(note || '').slice(0, 200), now));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added: list.length, product: getProduct(productId) };
}

function deleteStock(stockId) {
  const row = db.prepare('SELECT order_item_id FROM stock_items WHERE id = ?').get(Number(stockId));
  if (!row) throw new AppError(404, '지급 정보를 찾을 수 없습니다.');
  if (row.order_item_id) throw new AppError(409, '이미 지급된 정보는 삭제할 수 없습니다.');
  db.prepare('DELETE FROM stock_items WHERE id = ?').run(Number(stockId));
  return { ok: true };
}

/* ---------- order status transitions ---------- */
function orderItemRows(orderId) {
  return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC').all(Number(orderId));
}

function assignStock(orderId) {
  const items = orderItemRows(orderId);
  items.forEach((item) => {
    const assigned = db.prepare('SELECT COUNT(*) AS c FROM stock_items WHERE order_item_id = ?').get(item.id).c;
    if (assigned >= item.qty) return;
    const need = item.qty - assigned;
    const product = getProduct(item.product_id);
    if (!product) throw new AppError(409, '삭제된 상품이 포함되어 있어 자동 지급이 불가합니다. 주문을 확인해 주세요.');
    if (product.stockMode === 'manual') {
      if (product.manualStock < need) {
        throw new AppError(409, `'${item.name}' 재고가 부족합니다. (필요 ${need} / 남음 ${product.manualStock})`);
      }
      db.prepare('UPDATE products SET manual_stock = manual_stock - ?, updated_at = ? WHERE id = ?')
        .run(need, nowIso(), product.id);
      return;
    }
    const free = db.prepare('SELECT id FROM stock_items WHERE product_id = ? AND order_item_id IS NULL ORDER BY id ASC LIMIT ?')
      .all(product.id, need);
    if (free.length < need) {
      throw new AppError(409, `'${item.name}' 지급 정보가 부족합니다. (필요 ${need} / 남음 ${free.length}) 관리자 > 재고에서 계정을 추가해 주세요.`);
    }
    const stmt = db.prepare('UPDATE stock_items SET order_item_id = ? WHERE id = ?');
    free.forEach((row) => stmt.run(item.id, row.id));
  });
}

function releaseStock(orderId) {
  const items = orderItemRows(orderId);
  items.forEach((item) => {
    db.prepare('UPDATE stock_items SET order_item_id = NULL WHERE order_item_id = ?').run(item.id);
    const product = db.prepare('SELECT stock_mode FROM products WHERE id = ?').get(item.product_id);
    if (product && product.stock_mode === 'manual') {
      db.prepare('UPDATE products SET manual_stock = manual_stock + ?, updated_at = ? WHERE id = ?')
        .run(item.qty, nowIso(), item.product_id);
    }
  });
}

function setOrderStatus(id, status) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!row) throw new AppError(404, '주문을 찾을 수 없습니다.');
  if (['pending', 'paid', 'delivered', 'canceled'].indexOf(status) === -1) {
    throw new AppError(400, '알 수 없는 주문 상태입니다.');
  }
  if (row.status === 'canceled' && status !== 'canceled') {
    throw new AppError(409, '취소된 주문은 상태를 되돌릴 수 없습니다.');
  }
  const now = nowIso();
  db.exec('BEGIN');
  try {
    if (status === 'paid' || (status === 'delivered' && row.status === 'pending')) {
      assignStock(row.id);
      db.prepare("UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?) WHERE id = ?").run(now, row.id);
    }
    if (status === 'delivered') {
      db.prepare("UPDATE orders SET status = 'delivered', paid_at = COALESCE(paid_at, ?), delivered_at = COALESCE(delivered_at, ?) WHERE id = ?")
        .run(now, now, row.id);
    }
    if (status === 'canceled') {
      releaseStock(row.id);
      db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ?").run(row.id);
    }
    if (status === 'pending') {
      db.prepare("UPDATE orders SET status = 'pending', paid_at = NULL, delivered_at = NULL WHERE id = ?").run(row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return mapOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id), { forAdmin: true });
}

function getOrderByCode(code, email) {
  const row = findOrderByCode(code, email);
  return row ? mapOrder(row) : null;
}

/* ---------- reviews ---------- */
function mapReview(row, options) {
  const opts = options || {};
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    author: opts.raw ? row.author : maskName(row.author),
    rating: row.rating,
    body: row.body,
    verified: !!row.verified,
    visible: !!row.visible,
    createdAt: row.created_at,
    orderId: row.order_id || null,
    userId: opts.raw ? (row.user_id || null) : undefined
  };
}

function listReviews(options) {
  const opts = options || {};
  const where = opts.includeHidden ? '' : ' WHERE visible = 1';
  return db.prepare('SELECT * FROM reviews' + where + ' ORDER BY id DESC LIMIT 100').all()
    .map((row) => mapReview(row, { raw: !!opts.includeHidden }));
}

function createReview(data) {
  const productId = Number(data.productId) || null;
  const product = productId ? getProduct(productId) : null;
  const author = String(data.author || '').trim().slice(0, 20);
  const body = String(data.body || '').trim().slice(0, 300);
  const rating = Math.min(5, Math.max(1, Math.round(Number(data.rating) || 5)));
  if (!author) throw new AppError(400, '작성자 이름을 입력해 주세요.');
  if (!body) throw new AppError(400, '후기 내용을 입력해 주세요.');
  const result = db.prepare(`
    INSERT INTO reviews (product_id, product_name, author, rating, body, verified, visible, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(productId, product ? product.name : String(data.productName || '').slice(0, 80), author, rating, body, data.verified === false ? 0 : 1, nowIso());
  return mapReview(db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(result.lastInsertRowid)), { raw: true });
}

/* 내가 후기를 쓸 수 있는 상품 (지급 완료 + 아직 후기 없음) */
function listReviewableProducts(userId) {
  return db.prepare(`
    SELECT oi.product_id AS product_id, oi.name AS product_name,
           MAX(o.id) AS order_id, MAX(o.code) AS order_code, MAX(o.delivered_at) AS delivered_at
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.user_id = ? AND o.status = 'delivered' AND oi.product_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM reviews r WHERE r.user_id = ? AND r.product_id = oi.product_id
      )
    GROUP BY oi.product_id
    ORDER BY order_id DESC
  `).all(Number(userId), Number(userId)).map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    orderId: row.order_id,
    orderCode: row.order_code,
    deliveredAt: row.delivered_at || null
  }));
}

function listUserReviews(userId) {
  return db.prepare('SELECT * FROM reviews WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(Number(userId)).map((row) => mapReview(row, { raw: true }));
}

function createUserReview(userId, data) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw new AppError(401, '로그인이 필요합니다.');
  const productId = Number(data.productId);
  if (!productId) throw new AppError(400, '후기를 작성할 상품을 선택해 주세요.');
  const product = getProduct(productId);
  if (!product) throw new AppError(404, '상품을 찾을 수 없습니다.');
  const body = String(data.body || '').trim().slice(0, 300);
  if (body.length < 5) throw new AppError(400, '후기 내용을 5자 이상 입력해 주세요.');
  const rating = Math.min(5, Math.max(1, Math.round(Number(data.rating) || 5)));
  const order = db.prepare(`
    SELECT o.id, o.code
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = ? AND o.status = 'delivered' AND oi.product_id = ?
    ORDER BY o.id DESC LIMIT 1
  `).get(Number(userId), productId);
  if (!order) throw new AppError(403, '지급 완료된 상품에만 후기를 작성할 수 있습니다.');
  const duplicated = db.prepare('SELECT id FROM reviews WHERE user_id = ? AND product_id = ?')
    .get(Number(userId), productId);
  if (duplicated) throw new AppError(409, '이미 이 상품의 후기를 작성했습니다.');
  const author = user.display_name || user.username;
  const result = db.prepare(`
    INSERT INTO reviews (product_id, product_name, author, rating, body, verified, visible, created_at, user_id, order_id)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
  `).run(productId, product.name, author, rating, body, nowIso(), Number(userId), order.id);
  return mapReview(db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(result.lastInsertRowid)), { raw: true });
}

function deleteUserReview(userId, id) {
  const result = db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(Number(id), Number(userId));
  if (!result.changes) throw new AppError(404, '후기를 찾을 수 없습니다.');
  return { ok: true };
}

function toggleReview(id, visible) {
  const result = db.prepare('UPDATE reviews SET visible = ? WHERE id = ?').run(visible ? 1 : 0, Number(id));
  if (!result.changes) throw new AppError(404, '후기를 찾을 수 없습니다.');
  return { ok: true };
}

function deleteReview(id) {
  const result = db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(id));
  if (!result.changes) throw new AppError(404, '후기를 찾을 수 없습니다.');
  return { ok: true };
}

/* ---------- restock requests (회원 알림) ---------- */
function addRestockRequest(productId, userId) {
  const product = getProduct(productId);
  if (!product) throw new AppError(404, '상품을 찾을 수 없습니다.');
  if (product.stock > 0) throw new AppError(409, '이미 재고가 있습니다. 바로 구매할 수 있어요.');
  db.prepare(`
    INSERT INTO restock_waitlist (product_id, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(product_id, user_id) DO UPDATE SET created_at = excluded.created_at, notified_at = NULL
  `).run(product.id, Number(userId), nowIso());
  return { ok: true, productName: product.name };
}

function listRestockRequests() {
  return db.prepare(`
    SELECT r.id, r.product_id, r.user_id, r.created_at, r.notified_at,
           p.name AS product_name, u.username, u.display_name
    FROM restock_waitlist r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.id DESC
    LIMIT 300
  `).all().map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name || '(삭제된 상품)',
    userId: row.user_id,
    username: row.username || '(탈퇴 회원)',
    displayName: row.display_name || '',
    createdAt: row.created_at,
    notifiedAt: row.notified_at
  }));
}

function markRestockNotified(id) {
  const result = db.prepare('UPDATE restock_waitlist SET notified_at = ? WHERE id = ?').run(nowIso(), Number(id));
  if (!result.changes) throw new AppError(404, '알림 신청을 찾을 수 없습니다.');
  return { ok: true };
}

/* ---------- admin sessions ---------- */
const SESSION_HOURS = 12;

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS * 60 * 60 * 1000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
    return null;
  }
  return row;
}

function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

/* ---------- admin password ---------- */
const PASSWORD_KEY = 'admin_password';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), parts[1], 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function getAdminPasswordHash() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PASSWORD_KEY);
  if (row && row.value) return row.value;
  return null;
}

function setAdminPassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new AppError(400, '비밀번호는 8자 이상으로 설정해 주세요.');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(PASSWORD_KEY, hashPassword(value));
  db.prepare('DELETE FROM sessions').run();
  return { ok: true };
}

function checkAdminPassword(password) {
  const stored = getAdminPasswordHash();
  if (stored) return verifyPassword(password, stored);
  const fallback = process.env.ADMIN_PASSWORD || 'admin1234';
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(fallback);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------- shop users (회원) ---------- */
const USER_SESSION_DAYS = 30;
const USERNAME_RE = /^[a-zA-Z0-9_]{4,20}$/;

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null
  };
}

function createUser(payload) {
  const username = String((payload && payload.username) || '').trim();
  const password = String((payload && payload.password) || '');
  const displayName = String((payload && payload.displayName) || '').trim();
  if (!USERNAME_RE.test(username)) {
    throw new AppError(400, '아이디는 영문·숫자·밑줄 4~20자로 입력해 주세요.');
  }
  if (password.length < 6) throw new AppError(400, '비밀번호는 6자 이상으로 입력해 주세요.');
  if (password.length > 100) throw new AppError(400, '비밀번호가 너무 깁니다.');
  if (displayName.length > 20) throw new AppError(400, '닉네임은 20자 이하로 입력해 주세요.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new AppError(409, '이미 사용 중인 아이디입니다.');
  }
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), displayName || username, 'active', nowIso());
  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid)));
}

function authenticateUser(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  if (row.status !== 'active') throw new AppError(403, '이용이 제한된 계정입니다. 문의해 주세요.');
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
}

function createUserSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + USER_SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO user_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, Number(userId), now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

function getUserBySession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(String(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(String(token));
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.status !== 'active') return null;
  return mapUser(user);
}

function deleteUserSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM user_sessions WHERE token = ?').run(String(token));
}

function listUsers() {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
      (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','delivered')) AS spent,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'delivered') AS delivered_count
    FROM users u
    ORDER BY u.id DESC
  `).all().map((row) => Object.assign(mapUser(row), {
    orderCount: row.order_count || 0,
    spent: row.spent || 0,
    deliveredCount: row.delivered_count || 0
  }));
}

function listUserOrders(userId) {
  return db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100')
    .all(Number(userId)).map((row) => mapOrder(row));
}

function setUserStatus(id, status) {
  const value = status === 'blocked' ? 'blocked' : 'active';
  const result = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(value, Number(id));
  if (!result.changes) throw new AppError(404, '회원을 찾을 수 없습니다.');
  if (value === 'blocked') db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(Number(id));
  return { ok: true, status: value };
}

function setUserPassword(id, password) {
  const value = String(password || '');
  if (value.length < 6) throw new AppError(400, '비밀번호는 6자 이상으로 입력해 주세요.');
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(value), Number(id));
  if (!result.changes) throw new AppError(404, '회원을 찾을 수 없습니다.');
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(Number(id));
  return { ok: true };
}

function deleteUser(id) {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(id));
  if (!row) throw new AppError(404, '회원을 찾을 수 없습니다.');
  const active = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id = ? AND status IN ('pending','paid')").get(Number(id)).c;
  if (active > 0) throw new AppError(409, '진행 중인 주문이 있어 회원을 삭제할 수 없습니다. 주문을 먼저 처리해 주세요.');
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(id));
  return { ok: true };
}

/* ---------- stats ---------- */
function getStats() {
  const products = listProducts({ includeHidden: true });
  const paidStatuses = "status IN ('paid', 'delivered')";
  const totalRow = db.prepare(`SELECT COALESCE(SUM(total), 0) AS sum, COUNT(*) AS cnt FROM orders WHERE ${paidStatuses}`).get();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const todayRow = db.prepare(`SELECT COALESCE(SUM(total), 0) AS sum, COUNT(*) AS cnt FROM orders WHERE ${paidStatuses} AND paid_at >= ?`)
    .get(start.toISOString());
  const pending = db.prepare("SELECT COUNT(*) AS cnt FROM orders WHERE status = 'pending'").get().cnt;
  const reviewing = db.prepare('SELECT COUNT(*) AS cnt FROM restock_waitlist WHERE notified_at IS NULL').get().cnt;
  const users = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE status = 'active'").get().cnt;
  return {
    revenueTotal: totalRow.sum,
    ordersPaid: totalRow.cnt,
    revenueToday: todayRow.sum,
    ordersToday: todayRow.cnt,
    pendingCount: pending,
    restockWaiting: reviewing,
    userCount: users,
    productCount: products.length,
    visibleCount: products.filter((product) => product.visible).length,
    soldOutCount: products.filter((product) => product.visible && product.stock <= 0).length,
    stockCount: products.reduce((sum, product) => sum + (product.stockMode === 'auto' ? product.stock : 0), 0)
  };
}

function availableGames() {
  const rows = db.prepare('SELECT DISTINCT game FROM products WHERE visible = 1 ORDER BY game ASC').all();
  return rows.map((row) => row.game);
}

/* ---------- seed (첫 실행 시 Apex 샘플 상품) ---------- */
const DEMO_PRODUCTS = [
  {
    game: 'Apex 레전드', category: '계정', grade: '프레데터',
    name: 'Apex 프레데터 시즌 계정', summary: '프레데터 뱃지 · 스킨 다수 · 이메일 변경 지원',
    price: 120000, emoji: '👑', tint: 'rose',
    credentials: ['apex-predator01@example.com / Pass!2401 / 2차: 0000', 'apex-predator02@example.com / Pass!2402 / 2차: 0000']
  },
  {
    game: 'Apex 레전드', category: '계정', grade: '마스터',
    name: 'Apex 마스터 계정', summary: '마스터 랭크 · 하이브리드 스킨 보유',
    price: 45000, emoji: '🛡️', tint: 'violet',
    credentials: ['apex-master01@example.com / Pass!2403 / 2차: 0000', 'apex-master02@example.com / Pass!2404 / 2차: 0000']
  },
  {
    game: 'Apex 레전드', category: '계정', grade: '다이아',
    name: 'Apex 다이아 계정', summary: '다이아 랭크 · 바로 플레이 가능한 클린 계정',
    price: 18000, emoji: '💠', tint: 'cyan',
    credentials: ['apex-diamond01@example.com / Pass!2405 / 2차: 0000', 'apex-diamond02@example.com / Pass!2406 / 2차: 0000']
  },
  {
    game: 'Apex 레전드', category: '코인', grade: '일반',
    name: 'Apex 코인 1,000', summary: '닉네임 입력 후 순차 충전 · 24시간 접수',
    price: 12000, emoji: '🪙', tint: 'amber', stockMode: 'manual', manualStock: 10
  },
  {
    game: 'Apex 레전드', category: '코인', grade: '일반',
    name: 'Apex 배틀패스 시즌', summary: '시즌 배틀패스 1개 · 계정 닉네임으로 지급',
    price: 15000, emoji: '🎖️', tint: 'lime', stockMode: 'manual', manualStock: 10
  }
];

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count > 0) return;

  DEMO_PRODUCTS.forEach((item, index) => {
    const product = createProduct({
      game: item.game,
      category: item.category,
      grade: item.grade,
      name: item.name,
      summary: item.summary,
      description: item.summary,
      price: item.price,
      emoji: item.emoji,
      tint: item.tint,
      stockMode: item.stockMode || 'auto',
      manualStock: item.manualStock || 0,
      sortOrder: index
    });
    if (item.credentials) addStock(product.id, item.credentials.join('\n'), '샘플 지급 정보');
  });
}

/* ---------- error ---------- */
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status || 500;
  }
}

ensureWebhookToken();
seedIfEmpty();

module.exports = {
  db,
  dbFile: DB_FILE,
  AppError,
  ORDER_STATUS,
  nowIso,
  maskName,
  maskEmail,
  getSettings,
  setSettings,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  listStock,
  addStock,
  deleteStock,
  listOrders,
  createOrder,
  setOrderStatus,
  getOrderByCode,
  getUserOrderByCode,
  confirmOrderPayment,
  autoConfirmDueOrders,
  confirmDepositByCode,
  confirmDepositByAmount,
  getDepositWebhookKey,
  rotateDepositWebhookKey,
  depositKeySource,
  listPendingDepositOrders,
  matchPendingDeposit,
  expirePendingDepositOrders,
  listReviews,
  createReview,
  listReviewableProducts,
  listUserReviews,
  createUserReview,
  deleteUserReview,
  toggleReview,
  deleteReview,
  addRestockRequest,
  listRestockRequests,
  markRestockNotified,
  createSession,
  getSession,
  deleteSession,
  createUser,
  authenticateUser,
  createUserSession,
  getUserBySession,
  deleteUserSession,
  listUsers,
  listUserOrders,
  setUserStatus,
  setUserPassword,
  deleteUser,
  checkAdminPassword,
  getAdminPasswordHash,
  setAdminPassword,
  getStats,
  availableGames
};

/* ---------- orders ---------- */
function mapOrderItems(orderId, exposeCredentials) {
  return db.prepare(`
    SELECT oi.id, oi.product_id, oi.name, oi.qty, oi.unit_price,
           (SELECT GROUP_CONCAT(s.credential, char(10)) FROM stock_items s WHERE s.order_item_id = oi.id) AS credentials
    FROM order_items oi
    WHERE oi.order_id = ?
    ORDER BY oi.id ASC
  `).all(Number(orderId)).map((row) => {
    const item = {
      id: row.id,
      productId: row.product_id,
      name: row.name,
      qty: row.qty,
      unitPrice: row.unit_price,
      subtotal: row.qty * row.unit_price
    };
    if (exposeCredentials && row.credentials) {
      item.credentials = String(row.credentials).split(/\r?\n/).filter(Boolean);
    }
    return item;
  });
}

function mapOrder(row, options) {
  if (!row) return null;
  const opts = options || {};
  const expose = ['paid', 'delivered'].indexOf(row.status) !== -1;
  return {
    id: row.id,
    code: row.code,
    userId: row.user_id || null,
    username: opts.forAdmin ? (row.username || null) : undefined,
    buyerName: opts.forAdmin ? row.buyer_name : maskName(row.buyer_name),
    email: opts.forAdmin ? row.email : maskEmail(row.email),
    phone: opts.forAdmin ? row.phone : '',
    memo: row.memo,
    total: row.total,
    status: row.status,
    statusLabel: ORDER_STATUS[row.status] || row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    deliveredAt: row.delivered_at || null,
    items: mapOrderItems(row.id, expose || !!opts.forceCredentials)
  };
}

function listOrders(limit) {
  const rows = db.prepare(`
    SELECT o.*, u.username
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    ORDER BY o.id DESC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 200, 1), 500));
  return rows.map((row) => mapOrder(row, { forAdmin: true }));
}

function findOrderByCode(code, email) {
  const row = db.prepare('SELECT * FROM orders WHERE code = ?').get(String(code || '').trim().toUpperCase());
  if (!row) return null;
  if (email && String(row.email).toLowerCase() !== String(email).trim().toLowerCase()) return null;
  return row;
}

function createOrder(payload) {
  const userId = Number(payload.userId);
  if (!userId) throw new AppError(401, '주문하려면 로그인이 필요합니다.');
  const user = db.prepare("SELECT id, username, display_name FROM users WHERE id = ? AND status = 'active'").get(userId);
  if (!user) throw new AppError(401, '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.');
  const buyerName = String(payload.buyerName || '').trim() || user.display_name || user.username;
  const memo = String(payload.memo || '').trim();
  if (buyerName.length < 2) throw new AppError(400, '입금자명(주문자 이름)을 2자 이상 입력해 주세요.');
  if (payload.agree !== true) throw new AppError(400, '이용약관(지급 후 환불 불가)에 동의해 주세요.');
  if (!Array.isArray(payload.items) || !payload.items.length) throw new AppError(400, '장바구니가 비어 있습니다.');

  const merged = new Map();
  payload.items.forEach((item) => {
    const productId = Number(item && item.productId);
    const qty = Math.max(1, Math.min(20, Math.round(Number(item && item.qty) || 1)));
    if (!productId) return;
    merged.set(productId, (merged.get(productId) || 0) + qty);
  });
  if (!merged.size) throw new AppError(400, '장바구니가 비어 있습니다.');

  const lines = [];
  let total = 0;
  merged.forEach((qty, productId) => {
    const product = getProduct(productId);
    if (!product || !product.visible) throw new AppError(404, '판매 중이 아닌 상품이 포함되어 있습니다.');
    if (product.stock < qty) throw new AppError(409, `'${product.name}' 재고가 부족합니다. (남은 수량 ${product.stock}개)`);
    lines.push({ product, qty });
    total += product.price * qty;
  });

  const now = nowIso();
  db.exec('BEGIN');
  try {
    let code = orderCode();
    while (db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code)) code = orderCode();
    const result = db.prepare(`
      INSERT INTO orders (code, user_id, buyer_name, email, phone, memo, total, status, created_at)
      VALUES (?, ?, ?, '', '', ?, ?, 'pending', ?)
    `).run(code, userId, buyerName.slice(0, 40), memo.slice(0, 300), total, now);
    const orderId = Number(result.lastInsertRowid);
    const itemStmt = db.prepare('INSERT INTO order_items (order_id, product_id, name, qty, unit_price) VALUES (?, ?, ?, ?, ?)');
    lines.forEach((line) => itemStmt.run(orderId, line.product.id, line.product.name, line.qty, line.product.price));
    db.exec('COMMIT');
    return mapOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), { forAdmin: true });
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------- auto deposit confirm / delivery ---------- */
function confirmOrderPayment(id) {
  const settings = getSettings();
  const autoDeliver = settings.auto_deliver !== '0';
  return setOrderStatus(Number(id), autoDeliver ? 'delivered' : 'paid');
}

function autoConfirmDueOrders() {
  const settings = getSettings();
  if (settings.auto_confirm !== '1') return 0;
  const delay = Math.max(0, Number(settings.auto_confirm_delay) || 0);
  const cutoff = new Date(Date.now() - delay * 60000).toISOString();
  const rows = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at <= ? ORDER BY id ASC LIMIT 25").all(cutoff);
  let done = 0;
  rows.forEach((row) => {
    try {
      confirmOrderPayment(row.id);
      done += 1;
    } catch (err) {
      /* 재고 부족 등은 입금대기로 유지하고 관리자가 확인합니다. */
    }
  });
  return done;
}

function confirmDepositByCode(code) {
  const row = db.prepare('SELECT id FROM orders WHERE code = ?').get(String(code || '').trim().toUpperCase());
  if (!row) throw new AppError(404, '해당 주문번호를 찾을 수 없습니다.');
  return confirmOrderPayment(row.id);
}

function confirmDepositByAmount(amount) {
  const value = Math.round(Number(amount) || 0);
  if (value <= 0) throw new AppError(400, '입금 금액을 확인해 주세요.');
  const row = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND total = ? ORDER BY id ASC LIMIT 1").get(value);
  if (!row) return null;
  return confirmOrderPayment(row.id);
}

function getUserOrderByCode(userId, code) {
  const row = db.prepare('SELECT * FROM orders WHERE user_id = ? AND code = ?')
    .get(Number(userId), String(code || '').trim().toUpperCase());
  return row ? mapOrder(row) : null;
}

/* ────────────────────────────────────────────────────────────
   입금 알림 자동확인 (Tasker/MacroDroid 웹훅)
   - 금액 + 입금자명이 모두 일치하는 입금대기 주문만 자동 확인합니다.
   - 여러 건이 동시에 걸리면(금액 중복) 자동 지급하지 않고 관리자 확인으로 남깁니다.
   ──────────────────────────────────────────────────────────── */
function upsertSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 웹훅 키 출처: 'env' → Render 환경변수, 'db' → DB 저장값, 'generated' → 아직 없음 */
function depositKeySource() {
  if (depositParser.normalizeKey(process.env.DEPOSIT_WEBHOOK_KEY || '')) return 'env';
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('deposit_webhook_key');
  return row && row.value ? 'db' : 'generated';
}

/**
 * 입금 웹훅 인증 키 조회.
 * 우선순위: 환경변수(DEPOSIT_WEBHOOK_KEY) > DB 저장값 > 자동 생성.
 * 환경변수를 지정하면 재배포/DB 초기화와 무관하게 항상 같은 키를 사용합니다.
 */
function getDepositWebhookKey() {
  const envKey = depositParser.normalizeKey(process.env.DEPOSIT_WEBHOOK_KEY || '');
  if (envKey) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('deposit_webhook_key');
    if (!row || row.value !== envKey) upsertSetting('deposit_webhook_key', envKey);
    return envKey;
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('deposit_webhook_key');
  if (row && row.value) return row.value;
  const token = crypto.randomBytes(18).toString('hex');
  upsertSetting('deposit_webhook_key', token);
  return token;
}

/** 관리자 화면에서 키 재발급 (환경변수로 고정된 경우에는 불가) */
function rotateDepositWebhookKey() {
  if (depositParser.normalizeKey(process.env.DEPOSIT_WEBHOOK_KEY || '')) {
    throw new AppError(409, 'DEPOSIT_WEBHOOK_KEY 환경변수가 설정되어 있어 서버에서 키를 바꿀 수 없습니다. Render 환경변수를 수정해 주세요.');
  }
  const token = crypto.randomBytes(18).toString('hex');
  upsertSetting('deposit_webhook_key', token);
  return token;
}

/** 입금대기 주문 목록 (관리자 진단용) */
function listPendingDepositOrders(limit) {
  return db.prepare(`
    SELECT id, code, buyer_name, total, created_at
    FROM orders WHERE status = 'pending'
    ORDER BY id ASC LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 50, 1), 200)).map((row) => ({
    id: row.id,
    code: row.code,
    buyerName: row.buyer_name,
    total: row.total,
    createdAt: row.created_at
  }));
}

/**
 * 입금 알림과 입금대기 주문을 매칭하고, 정확히 1건이면 자동 확인·지급합니다.
 * @param {{amount:number, depositor?:string, text?:string}} payload
 * @param {{dryRun?:boolean}} [options] dryRun=true 이면 지급 없이 매칭 결과만 돌려줍니다.
 * @returns {{order:object|null, reason:string, amount:number, depositor:string, candidates?:number, candidateCodes?:string[]}}
 */
function matchPendingDeposit(payload, options) {
  const dryRun = !!(options && options.dryRun);
  const amount = Math.round(Number(payload && payload.amount) || 0);
  const depositor = String((payload && payload.depositor) || '').trim();
  const text = String((payload && payload.text) || '');
  const base = { order: null, amount: amount, depositor: depositor };
  if (amount <= 0) return Object.assign(base, { reason: 'no-amount' });

  const rows = db.prepare(`
    SELECT id, code, buyer_name, total, created_at
    FROM orders WHERE status = 'pending' AND total = ?
    ORDER BY id ASC
  `).all(amount);
  if (!rows.length) return Object.assign(base, { reason: 'no-pending-amount', candidates: 0 });

  const settings = getSettings();
  const requireName = settings.deposit_match_name !== '0';
  const normalizedText = depositParser.normalizeName(text);
  const matched = requireName
    ? rows.filter((row) => depositParser.nameMatches(row.buyer_name, depositor, normalizedText))
    : rows;

  if (!matched.length) {
    return Object.assign(base, { reason: 'depositor-mismatch', candidates: rows.length });
  }
  if (matched.length > 1) {
    return Object.assign(base, {
      reason: 'ambiguous',
      candidates: matched.length,
      candidateCodes: matched.map((row) => row.code)
    });
  }
  if (dryRun) {
    return Object.assign(base, {
      reason: 'would-match',
      candidates: 1,
      preview: { code: matched[0].code, total: matched[0].total, buyerName: matched[0].buyer_name }
    });
  }
  return Object.assign(base, { order: confirmOrderPayment(matched[0].id), reason: 'matched', candidates: 1 });
}

/** 설정한 시간(분)이 지난 입금대기 주문을 취소합니다. 0이면 사용 안 함. */
function expirePendingDepositOrders() {
  const minutes = Math.max(0, Number(getSettings().deposit_expire_minutes) || 0);
  if (!minutes) return 0;
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  const rows = db.prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at <= ?").all(cutoff);
  let canceled = 0;
  rows.forEach((row) => {
    try {
      setOrderStatus(row.id, 'canceled');
      canceled += 1;
    } catch (err) {
      /* 이미 처리된 주문은 건너뜁니다. */
    }
  });
  return canceled;
}


