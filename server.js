/* ============================================================
   GAME SHOP — 판매용 상점 서버 (Node.js 내장 모듈만 사용)
   실행: node server.js
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./db');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 128 * 1024;
const COOKIE_NAME = 'shop_admin';
const COOKIE_USER = 'shop_user';
const LOGIN_ONLY_SETTINGS = ['auto_confirm', 'auto_confirm_delay', 'auto_deliver', 'webhook_token'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

/* ---------- response helpers ---------- */
function baseHeaders(extra) {
  return Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  }, extra || {});
}

function sendJson(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  res.writeHead(status, baseHeaders(Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, headers || {})));
  res.end(body);
}

function sendFile(res, filePath, status) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(status || 200, baseHeaders({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    }));
    res.end(data);
  });
}

/* ---------- request helpers ---------- */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new store.AppError(413, '요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new store.AppError(400, 'JSON 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function requireAdmin(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = store.getSession(token);
  if (!session) throw new store.AppError(401, '관리자 로그인이 필요합니다.');
  return session;
}

function currentUser(req) {
  return store.getUserBySession(parseCookies(req)[COOKIE_USER]);
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new store.AppError(401, '로그인이 필요합니다.');
  return user;
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function secureAttr(req) {
  return isHttps(req) ? '; Secure' : '';
}

function userCookie(token, req) {
  return COOKIE_USER + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 24 * 3600) + secureAttr(req);
}

function clearUserCookie(req) {
  return COOKIE_USER + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureAttr(req);
}

function requireJsonContentType(req) {
  const type = String(req.headers['content-type'] || '');
  if (type.indexOf('application/json') === -1) {
    throw new store.AppError(415, 'Content-Type: application/json 으로 요청해 주세요.');
  }
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 6;

function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { first: now, count: 1 });
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX) {
    throw new store.AppError(429, '로그인 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.');
  }
}

function resetLoginRate(ip) {
  loginAttempts.delete(ip);
}

/* ---------- public payloads ---------- */
function publicSettings() {
  const settings = store.getSettings();
  LOGIN_ONLY_SETTINGS.forEach((key) => { delete settings[key]; });
  return settings;
}

function automationInfo() {
  const settings = store.getSettings();
  return {
    enabled: settings.auto_confirm === '1',
    delayMinutes: Math.max(0, Number(settings.auto_confirm_delay) || 0),
    autoDeliver: settings.auto_deliver !== '0'
  };
}

function accountPayload(user) {
  return {
    user,
    orders: store.listUserOrders(user.id),
    automation: automationInfo()
  };
}

function publicStorePayload() {
  return {
    settings: publicSettings(),
    automation: automationInfo(),
    products: store.listProducts(),
    reviews: store.listReviews(),
    games: store.availableGames()
  };
}

/* ---------- public API ---------- */
async function handlePublicApi(req, res, pathname, query) {
  if (req.method === 'GET' && pathname === '/api/store') {
    sendJson(res, 200, publicStorePayload());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = currentUser(req);
    if (!user) throw new store.AppError(401, '로그인이 필요합니다.');
    sendJson(res, 200, accountPayload(user));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    requireJsonContentType(req);
    const ip = clientIp(req);
    checkLoginRate('join:' + ip);
    const body = await readJson(req);
    const user = store.createUser(body);
    const session = store.createUserSession(user.id);
    sendJson(res, 201, accountPayload(user), { 'Set-Cookie': userCookie(session.token, req) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    requireJsonContentType(req);
    const ip = clientIp(req);
    checkLoginRate('login:' + ip);
    const body = await readJson(req);
    const user = store.authenticateUser(body.username, body.password);
    if (!user) throw new store.AppError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
    resetLoginRate('login:' + ip);
    const session = store.createUserSession(user.id);
    sendJson(res, 200, accountPayload(user), { 'Set-Cookie': userCookie(session.token, req) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    store.deleteUserSession(parseCookies(req)[COOKIE_USER]);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearUserCookie(req) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/hooks/deposit') {
    requireJsonContentType(req);
    const settings = store.getSettings();
    const expected = Buffer.from(String(settings.webhook_token || ''));
    const provided = Buffer.from(String(req.headers['x-deposit-token'] || query.get('token') || ''));
    if (!expected.length || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      throw new store.AppError(401, '입금 웹훅 토큰이 올바르지 않습니다.');
    }
    const body = await readJson(req);
    const order = body.code
      ? store.confirmDepositByCode(body.code)
      : store.confirmDepositByAmount(body.amount);
    if (!order) throw new store.AppError(404, '금액과 일치하는 입금대기 주문이 없습니다.');
    sendJson(res, 200, { ok: true, order });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    requireJsonContentType(req);
    const user = requireUser(req);
    const body = await readJson(req);
    const order = store.createOrder({
      userId: user.id,
      buyerName: body.buyerName,
      memo: body.memo,
      agree: body.agree,
      items: body.items
    });
    const automation = automationInfo();
    let latest = order;
    if (automation.enabled && automation.delayMinutes === 0) {
      try {
        latest = store.confirmOrderPayment(order.id);
      } catch (err) {
        latest = order;
      }
    }
    const settings = store.getSettings();
    sendJson(res, 201, {
      ok: true,
      order: {
        code: latest.code,
        total: latest.total,
        status: latest.status,
        statusLabel: latest.statusLabel,
        createdAt: latest.createdAt,
        items: latest.items.map((item) => ({
          name: item.name,
          qty: item.qty,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
          credentials: item.credentials || []
        }))
      },
      bank: {
        name: settings.bank_name,
        account: settings.bank_account,
        holder: settings.bank_holder,
        depositor: String(body.buyerName || '').trim() || user.displayName
      },
      automation
    });
    return true;
  }

  const lookup = pathname.match(/^\/api\/orders\/([A-Za-z0-9-]+)$/);
  if (req.method === 'GET' && lookup) {
    const user = requireUser(req);
    const order = store.getUserOrderByCode(user.id, lookup[1]);
    if (!order) throw new store.AppError(404, '내 주문에서 해당 주문번호를 찾을 수 없습니다.');
    sendJson(res, 200, { order, automation: automationInfo() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/restock') {
    requireJsonContentType(req);
    const user = requireUser(req);
    const body = await readJson(req);
    sendJson(res, 201, store.addRestockRequest(body.productId, user.id));
    return true;
  }

  return false;
}

/* ---------- admin API ---------- */
async function handleAdminApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    requireJsonContentType(req);
    const ip = clientIp(req);
    checkLoginRate(ip);
    const body = await readJson(req);
    if (!store.checkAdminPassword(body.password)) {
      throw new store.AppError(401, '비밀번호가 올바르지 않습니다.');
    }
    resetLoginRate(ip);
    const session = store.createSession();
    sendJson(res, 200, { ok: true, expiresAt: session.expiresAt }, {
      'Set-Cookie': COOKIE_NAME + '=' + session.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (12 * 3600) + secureAttr(req)
    });
    return true;
  }

  if (pathname.indexOf('/api/admin') !== 0) return false;

  if (req.method === 'POST' && pathname === '/api/admin/logout') {
    store.deleteSession(parseCookies(req)[COOKIE_NAME]);
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureAttr(req)
    });
    return true;
  }

  requireAdmin(req);

  if (req.method === 'GET' && pathname === '/api/admin/session') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/backup') {
    try {
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (err) {
      console.error('[백업] WAL 정리 실패:', err.message);
    }
    const data = fs.readFileSync(store.dbFile);
    res.writeHead(200, baseHeaders({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="shop-backup-' + new Date().toISOString().slice(0, 10) + '.db"',
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    }));
    res.end(data);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/data') {
    const products = store.listProducts({ includeHidden: true });
    const settings = store.getSettings();
    sendJson(res, 200, {
      products,
      orders: store.listOrders(200),
      reviews: store.listReviews({ includeHidden: true }),
      restock: store.listRestockRequests(),
      users: store.listUsers(),
      stats: store.getStats(),
      settings,
      automation: automationInfo(),
      webhook: {
        path: '/api/hooks/deposit',
        token: settings.webhook_token || ''
      },
      games: Array.from(new Set(products.map((product) => product.game)))
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/products') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 201, { product: store.createProduct(body) });
    return true;
  }

  const productMatch = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if (productMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 200, { product: store.updateProduct(Number(productMatch[1]), body) });
    return true;
  }
  if (productMatch && req.method === 'DELETE') {
    sendJson(res, 200, store.deleteProduct(Number(productMatch[1])));
    return true;
  }

  const stockMatch = pathname.match(/^\/api\/admin\/products\/(\d+)\/stock$/);
  if (stockMatch && req.method === 'GET') {
    sendJson(res, 200, { stock: store.listStock(Number(stockMatch[1])) });
    return true;
  }
  if (stockMatch && req.method === 'POST') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 201, store.addStock(Number(stockMatch[1]), body.credentials, body.note));
    return true;
  }
  const stockDeleteMatch = pathname.match(/^\/api\/admin\/stock\/(\d+)$/);
  if (stockDeleteMatch && req.method === 'DELETE') {
    sendJson(res, 200, store.deleteStock(Number(stockDeleteMatch[1])));
    return true;
  }

  const orderStatusMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (orderStatusMatch && req.method === 'POST') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 200, { order: store.setOrderStatus(Number(orderStatusMatch[1]), String(body.status || '')) });
    return true;
  }

  const orderConfirmMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/confirm$/);
  if (orderConfirmMatch && req.method === 'POST') {
    sendJson(res, 200, { order: store.confirmOrderPayment(Number(orderConfirmMatch[1])) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/auto-confirm') {
    const confirmed = store.autoConfirmDueOrders();
    sendJson(res, 200, { ok: true, confirmed });
    return true;
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
    requireJsonContentType(req);
    const body = await readJson(req);
    if (body.status) store.setUserStatus(Number(userMatch[1]), body.status);
    if (body.password) store.setUserPassword(Number(userMatch[1]), body.password);
    sendJson(res, 200, { ok: true, users: store.listUsers() });
    return true;
  }
  if (userMatch && req.method === 'DELETE') {
    store.deleteUser(Number(userMatch[1]));
    sendJson(res, 200, { ok: true, users: store.listUsers() });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/reviews') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 201, { review: store.createReview(body) });
    return true;
  }
  const reviewMatch = pathname.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (reviewMatch && req.method === 'PATCH') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 200, store.toggleReview(Number(reviewMatch[1]), body.visible !== false));
    return true;
  }
  if (reviewMatch && req.method === 'DELETE') {
    sendJson(res, 200, store.deleteReview(Number(reviewMatch[1])));
    return true;
  }

  const notifyMatch = pathname.match(/^\/api\/admin\/restock\/(\d+)\/notify$/);
  if (notifyMatch && req.method === 'POST') {
    sendJson(res, 200, store.markRestockNotified(Number(notifyMatch[1])));
    return true;
  }

  if ((req.method === 'PATCH' || req.method === 'PUT') && pathname === '/api/admin/settings') {
    requireJsonContentType(req);
    const body = await readJson(req);
    sendJson(res, 200, { settings: store.setSettings(body) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/password') {
    requireJsonContentType(req);
    const body = await readJson(req);
    if (!store.checkAdminPassword(body.current)) {
      throw new store.AppError(401, '현재 비밀번호가 올바르지 않습니다.');
    }
    store.setAdminPassword(body.next);
    sendJson(res, 200, { ok: true }, {
      'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureAttr(req)
    });
    return true;
  }

  throw new store.AppError(404, '없는 관리자 API입니다.');
}

/* ---------- static files ---------- */
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new store.AppError(405, '지원하지 않는 메서드입니다.');
  }
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  if (rel === '/favicon.ico') {
    res.writeHead(204, baseHeaders());
    res.end();
    return;
  }
  const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
  if (resolved !== PUBLIC_DIR && resolved.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    throw new store.AppError(403, '접근할 수 없습니다.');
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    throw new store.AppError(404, '페이지를 찾을 수 없습니다.');
  }
  sendFile(res, resolved);
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = decodeURIComponent(url.pathname);
    query = url.searchParams;
  } catch (err) {
    sendJson(res, 400, { error: '잘못된 요청입니다.' });
    return;
  }

  try {
    if (await handlePublicApi(req, res, pathname, query)) return;
    if (await handleAdminApi(req, res, pathname)) return;
    if (pathname.indexOf('/api/') === 0) throw new store.AppError(404, '없는 API입니다.');
    serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof store.AppError ? err.status : 500;
    if (status >= 500) console.error('[오류]', err);
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || '서버 오류가 발생했습니다.' });
    } else {
      res.end();
    }
  }
});

function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    });
  });
  return out;
}

function start(port, attempts) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempts > 0) {
      console.warn('포트 ' + port + ' 사용 중 → ' + (port + 1) + ' 으로 재시도합니다.');
      start(port + 1, attempts - 1);
      return;
    }
    console.error('서버 시작 실패:', err);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.log('');
    console.log('🎮 ' + store.getSettings().store_name + ' 서버 실행 중');
    console.log('──────────────────────────────────────────');
    console.log('상점:    http://localhost:' + port);
    console.log('관리자:  http://localhost:' + port + '/admin');
    if (process.env.RENDER_EXTERNAL_URL) {
      console.log('공개 URL: ' + process.env.RENDER_EXTERNAL_URL);
    }
    console.log('DB 파일: ' + store.dbFile);
    lanAddresses().forEach((address) => {
      console.log('외부/같은 네트워크: http://' + address + ':' + port);
    });
    console.log('──────────────────────────────────────────');
    if (!store.getAdminPasswordHash()) {
      console.log('관리자 비밀번호: ADMIN_PASSWORD 환경변수 값 (미설정 시 기본값 admin1234)');
      console.log('👉 /admin 로그인 후 반드시 비밀번호를 변경하세요.');
    }
    console.log('※ 결제는 무통장 입금 + 자동입금확인(확인 즉시 자동지급) 방식입니다.');
    console.log('');
  });
}

start(PORT, process.env.PORT ? 0 : 9);

/* Render 등 PaaS 는 SIGTERM 으로 재시작합니다. WAL 을 정리하고 정상 종료합니다. */
function shutdown(signal) {
  console.log(signal + ' 수신 → 서버를 정리합니다.');
  try {
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch (err) {
    console.error('WAL 정리 실패:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* 자동입금확인: 설정된 지연 시간이 지난 입금대기 주문을 자동 확인·지급합니다. */
setInterval(() => {
  try {
    const confirmed = store.autoConfirmDueOrders();
    if (confirmed > 0) console.log('[자동입금확인] ' + confirmed + '건 확인 · 자동지급 완료');
  } catch (err) {
    console.error('[자동입금확인 오류]', err);
  }
}, 15000).unref();


