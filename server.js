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
const depositParser = require('./deposit-parser');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 128 * 1024;
const UPLOAD_MAX_BODY = 6 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const COOKIE_NAME = 'shop_admin';
const COOKIE_USER = 'shop_user';
const LOGIN_ONLY_SETTINGS = [
  'auto_confirm', 'auto_confirm_delay', 'auto_deliver',
  'deposit_expire_minutes', 'deposit_match_name', 'deposit_webhook_key',
  'webhook_token'
];

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

function sendFile(res, filePath, status, cacheControl) {
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
      'Cache-Control': cacheControl || (ext === '.html' ? 'no-cache' : 'public, max-age=300')
    }));
    res.end(data);
  });
}

/* ---------- 상품 이미지 ---------- */
/* 업로드 파일은 DB 파일과 같은 폴더에 보관합니다.
   (Render Persistent Disk 를 /var/data 에 마운트하면 재배포해도 유지됩니다.) */
const UPLOAD_DIR = path.join(path.dirname(store.dbFile), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function sniffImageKind(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

function saveUploadedImage(body) {
  const raw = String((body && body.data) || '');
  const match = raw.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i);
  const base64 = (match ? match[1] : raw).replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new store.AppError(400, '이미지 데이터가 올바르지 않습니다.');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new store.AppError(400, '이미지 데이터가 비어 있습니다.');
  if (buffer.length > UPLOAD_MAX_BYTES) {
    throw new store.AppError(413, '이미지는 4MB 이하만 업로드할 수 있습니다.');
  }
  const kind = sniffImageKind(buffer);
  if (!kind) {
    throw new store.AppError(415, 'PNG · JPG · WebP · GIF 이미지만 업로드할 수 있습니다.');
  }
  const filename = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + kind;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return {
    ok: true,
    url: '/uploads/' + filename,
    bytes: buffer.length,
    type: MIME['.' + kind] || 'application/octet-stream'
  };
}

function removeUploadedImage(url) {
  const match = String(url || '').match(/^\/uploads\/([A-Za-z0-9._-]+)$/);
  if (!match) return;
  try {
    fs.unlinkSync(path.join(UPLOAD_DIR, match[1]));
  } catch (err) {
    /* 이미 지워졌거나 외부 URL 이면 무시합니다. */
  }
}


/* ---------- request helpers ---------- */
function readJson(req, limit) {
  const max = Number(limit) > 0 ? Number(limit) : MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
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
    reviewable: store.listReviewableProducts(user.id),
    myReviews: store.listUserReviews(user.id),
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

/* ────────────────────────────────────────────────────────────
   입금 알림 웹훅 (Tasker / MacroDroid → 폰 은행 알림 자동 전송)
   자판기 앱(Discord-Battle-Cat-Vending-Machine)과 같은 방식입니다.
   - 인증: ?key=... 또는 헤더 X-Webhook-Key
   - 수신: {"title": "...", "body": "...", "package": "..."} (JSON/form/순수텍스트 모두 허용)
   - 처리: 금액 + 입금자명 파싱 → 입금대기 주문 매칭 → 즉시 지급
   ──────────────────────────────────────────────────────────── */
const DEPOSIT_LOG_LIMIT = 120;
const DEPOSIT_DEDUP_MS = 60 * 1000;
const depositLogs = [];
const depositRecent = new Map();

function recordDepositLog(level, message) {
  const entry = { at: new Date().toISOString(), level: level, message: String(message || '').slice(0, 500) };
  depositLogs.unshift(entry);
  if (depositLogs.length > DEPOSIT_LOG_LIMIT) depositLogs.length = DEPOSIT_LOG_LIMIT;
  const line = '[입금] ' + entry.message;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  return entry;
}

function depositKeyInfo() {
  const key = store.getDepositWebhookKey();
  const source = store.depositKeySource();
  return {
    key: key,
    fingerprint: depositParser.keyFingerprint(key),
    source: source,
    fromEnv: source === 'env'
  };
}

function checkDepositKey(rawKey) {
  const expected = depositParser.normalizeKey(store.getDepositWebhookKey());
  const provided = depositParser.normalizeKey(rawKey);
  const detail = '받은키[길이=' + provided.length + ', 지문=' + depositParser.keyFingerprint(provided) +
    ', 앞4=' + (provided.slice(0, 4) || '-') + '] / 서버키[길이=' + expected.length +
    ', 지문=' + depositParser.keyFingerprint(expected) + ', 앞4=' + (expected.slice(0, 4) || '-') +
    ', 출처=' + store.depositKeySource() + ']';
  if (!expected || !provided || provided.length !== expected.length) return { ok: false, detail: detail };
  return { ok: crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8')), detail: detail };
}

function readRawBody(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Content-Type 헤더가 없어도 JSON → form → 순수 텍스트 순서로 최대한 수용합니다. */
function parseWebhookPayload(raw, query) {
  const text = String(raw || '').trim();
  let json = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
    } catch (err) {
      json = null;
    }
  }
  const form = (!json && text) ? new URLSearchParams(text) : new URLSearchParams();
  const pick = (names) => {
    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (json && json[name] !== undefined && json[name] !== null && String(json[name]).trim()) {
        return String(json[name]);
      }
      if (form.get(name)) return form.get(name);
      if (query && query.get(name)) return query.get(name);
    }
    return '';
  };
  const title = pick(['title', 'titleText', 'ntitle']);
  const body = pick(['body', 'text', 'message', 'content', 'ntext', 'msg']);
  const pkg = pick(['package', 'package_name', 'app', 'pkg', 'napp']);
  const plain = (!json && !title && !body && text) ? text : '';
  return { title: title, body: body || plain, pkg: pkg };
}

/* 알림 1건 처리: 파싱 → 중복 방지 → 입금대기 주문 매칭 → 자동 지급 */
function processDepositNotification(payload) {
  const parsed = depositParser.parseNotification(payload.title, payload.body, payload.pkg);
  recordDepositLog('info', '수신: ' + (payload.title || '-').slice(0, 40) + ' | ' + (payload.body || '-').slice(0, 80));
  const base = { ok: true, deposit: false, parsed: parsed };
  if (!parsed.text) return Object.assign(base, { reason: 'empty' });
  if (!parsed.isDepositLike) return Object.assign(base, { reason: 'not-deposit' });
  if (parsed.outgoing) return Object.assign(base, { reason: 'outgoing' });
  if (!parsed.ok) return Object.assign(base, { reason: 'parse-failed' });

  const dedupKey = parsed.text + '|' + parsed.amount + '|' + parsed.depositor;
  const now = Date.now();
  const last = depositRecent.get(dedupKey);
  if (last && now - last < DEPOSIT_DEDUP_MS) {
    return Object.assign(base, {
      deposit: true, duplicate: true, reason: 'duplicate',
      amount: parsed.amount, depositor: parsed.depositor
    });
  }
  depositRecent.set(dedupKey, now);
  if (depositRecent.size > 300) {
    depositRecent.forEach((at, key) => {
      if (now - at > DEPOSIT_DEDUP_MS * 2) depositRecent.delete(key);
    });
  }

  const result = store.matchPendingDeposit({
    amount: parsed.amount,
    depositor: parsed.depositor,
    text: parsed.text
  });

  if (result.order) {
    const order = result.order;
    recordDepositLog('match', '자동 지급 완료 · ' + parsed.amount.toLocaleString('ko-KR') + '원 / ' +
      parsed.depositor + ' / 주문 ' + order.code);
    return Object.assign(base, {
      deposit: true,
      matched: true,
      reason: 'matched',
      amount: parsed.amount,
      depositor: parsed.depositor,
      order: {
        code: order.code,
        total: order.total,
        status: order.status,
        statusLabel: order.statusLabel,
        buyerName: order.buyerName
      }
    });
  }

  const reasonText = {
    'no-amount': '금액 추출 실패',
    'no-pending-amount': '금액이 일치하는 입금대기 주문 없음',
    'depositor-mismatch': '금액은 맞지만 입금자명이 다른 주문만 있음',
    ambiguous: '같은 금액의 입금대기 주문이 여러 건 → 수동 확인 필요'
  }[result.reason] || result.reason;
  recordDepositLog('warn', '미할당 입금 · ' + parsed.amount.toLocaleString('ko-KR') + '원 / ' +
    parsed.depositor + ' · ' + reasonText);
  return Object.assign(base, {
    deposit: true,
    matched: false,
    amount: parsed.amount,
    depositor: parsed.depositor,
    reason: result.reason,
    reasonText: reasonText,
    candidates: result.candidates || 0,
    candidateCodes: result.candidateCodes || []
  });
}

/* ---------- public API ---------- */
async function handlePublicApi(req, res, pathname, query) {
  if (req.method === 'GET' && pathname === '/api/store') {
    sendJson(res, 200, publicStorePayload());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/ping') {
    sendJson(res, 200, { ok: true, time: new Date().toISOString(), uptime: Math.round(process.uptime()) });
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

  /* 폰(Tasker/MacroDroid) 알림 웹훅 — 자판기 앱과 동일한 자동입금확인 방식 */
  if (pathname === '/api/hooks/deposit-notify' && (req.method === 'GET' || req.method === 'POST')) {
    const rawKey = req.headers['x-webhook-key'] || req.headers['x-deposit-key'] || query.get('key') || '';
    const auth = checkDepositKey(rawKey);
    if (!auth.ok) {
      recordDepositLog('error', '인증 실패 · ' + auth.detail + ' · IP ' + clientIp(req));
      throw new store.AppError(403, '입금 웹훅 키가 올바르지 않습니다. ' + auth.detail);
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        message: '입금 웹훅 연결 정상! 이 URL과 키를 Tasker/MacroDroid에 설정하세요.',
        detail: auth.detail,
        pending: store.listPendingDepositOrders(200).length,
        time: new Date().toISOString()
      });
      return true;
    }
    const raw = await readRawBody(req);
    const payload = parseWebhookPayload(raw, query);
    if (!payload.title && !payload.body) throw new store.AppError(400, '알림 제목 또는 내용이 비어 있습니다.');
    const unresolved = depositParser.detectTemplateVars(payload.title + ' ' + payload.body + ' ' + payload.pkg);
    if (unresolved.length) {
      const message = 'Tasker 변수가 치환되지 않았습니다: ' + unresolved.join(', ') +
        ' → %evtprm1(제목) / %evtprm2(내용) / %evtprm3(앱) 을 사용하세요.';
      recordDepositLog('error', message);
      sendJson(res, 200, { ok: false, error: 'tasker_var_not_substituted', vars: unresolved, message: message });
      return true;
    }
    sendJson(res, 200, processDepositNotification(payload));
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

  /* 구매 인증 후기: 지급 완료된 주문의 상품에만 작성 가능 */
  if (req.method === 'POST' && pathname === '/api/reviews') {
    requireJsonContentType(req);
    const user = requireUser(req);
    const body = await readJson(req);
    const review = store.createUserReview(user.id, body);
    sendJson(res, 201, {
      ok: true,
      review,
      reviewable: store.listReviewableProducts(user.id),
      reviews: store.listReviews()
    });
    return true;
  }

  const userReviewMatch = pathname.match(/^\/api\/reviews\/(\d+)$/);
  if (userReviewMatch && req.method === 'DELETE') {
    const user = requireUser(req);
    sendJson(res, 200, store.deleteUserReview(user.id, Number(userReviewMatch[1])));
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
    const settings = Object.assign({}, store.getSettings());
    delete settings.deposit_webhook_key;
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
      deposit: Object.assign({}, depositKeyInfo(), {
        path: '/api/hooks/deposit-notify',
        matchName: settings.deposit_match_name !== '0',
        expireMinutes: Math.max(0, Number(settings.deposit_expire_minutes) || 0),
        pending: store.listPendingDepositOrders(10),
        logs: depositLogs.slice(0, 40)
      }),
      games: Array.from(new Set(products.map((product) => product.game)))
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/uploads') {
    requireJsonContentType(req);
    const body = await readJson(req, UPLOAD_MAX_BODY);
    sendJson(res, 201, saveUploadedImage(body));
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
    const before = store.getProduct(Number(productMatch[1]));
    const product = store.updateProduct(Number(productMatch[1]), body);
    /* 이미지가 바뀌었으면 예전 업로드 파일을 정리합니다. */
    if (before && before.image && before.image !== product.image) removeUploadedImage(before.image);
    sendJson(res, 200, { product });
    return true;
  }
  if (productMatch && req.method === 'DELETE') {
    const before = store.getProduct(Number(productMatch[1]));
    const result = store.deleteProduct(Number(productMatch[1]));
    if (before) removeUploadedImage(before.image);
    sendJson(res, 200, result);
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

  /* 폰 알림 웹훅 진단: 파싱 + 매칭 시뮬레이션 (실제 지급 없음) */
  if (req.method === 'POST' && pathname === '/api/admin/deposit/test') {
    requireJsonContentType(req);
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    const message = String(body.body || body.text || '').trim();
    if (!title && !message) throw new store.AppError(400, '알림 제목 또는 내용을 입력해 주세요.');
    const unresolved = depositParser.detectTemplateVars(title + ' ' + message);
    if (unresolved.length) {
      sendJson(res, 200, {
        ok: false,
        message: 'Tasker 변수(' + unresolved.join(', ') + ')가 그대로 있습니다. 실제 알림 문구를 입력해 주세요.'
      });
      return true;
    }
    const parsed = depositParser.parseNotification(title, message);
    const match = parsed.ok
      ? store.matchPendingDeposit({ amount: parsed.amount, depositor: parsed.depositor, text: parsed.text }, { dryRun: true })
      : null;
    let hint;
    if (!parsed.ok) {
      hint = '❌ 알림에서 금액/입금자명을 추출하지 못했습니다. 알림 문구에 금액(원)과 입금자명이 함께 있어야 합니다.';
    } else if (match && match.reason === 'would-match') {
      hint = '✅ 실제 입금이라면 주문 ' + match.preview.code + '(' + match.preview.buyerName + ')에 자동 지급됩니다.';
    } else if (match && match.reason === 'no-pending-amount') {
      hint = '⚠️ 금액이 일치하는 입금대기 주문이 없습니다. 회원이 먼저 주문(입금대기)을 만들어야 합니다.';
    } else if (match && match.reason === 'depositor-mismatch') {
      hint = '⚠️ 금액은 맞지만 입금자명이 다른 주문만 있습니다. 주문서의 입금자명과 알림의 입금자명이 같아야 합니다.';
    } else if (match && match.reason === 'ambiguous') {
      hint = '⚠️ 같은 금액의 입금대기 주문이 여러 건이라 자동 지급하지 않습니다. 관리자가 직접 확인해 주세요.';
    } else {
      hint = '⚠️ 자동 지급 조건을 만족하지 않습니다.';
    }
    sendJson(res, 200, {
      ok: true,
      parsed: parsed,
      match: match,
      hint: hint,
      pending: store.listPendingDepositOrders(10)
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/admin/deposit/logs') {
    sendJson(res, 200, { ok: true, logs: depositLogs.slice(0, DEPOSIT_LOG_LIMIT) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/deposit/logs/clear') {
    depositLogs.length = 0;
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/admin/deposit/key/rotate') {
    const key = store.rotateDepositWebhookKey();
    recordDepositLog('info', '웹훅 키를 재발급했습니다 (지문 ' + depositParser.keyFingerprint(key) + ')');
    sendJson(res, 200, { ok: true, deposit: depositKeyInfo() });
    return true;
  }

  throw new store.AppError(404, '없는 관리자 API입니다.');
}

/* ---------- static files ---------- */
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new store.AppError(405, '지원하지 않는 메서드입니다.');
  }
  /* 업로드한 상품 이미지 */
  if (pathname.indexOf('/uploads/') === 0) {
    const name = pathname.slice('/uploads/'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new store.AppError(404, '이미지를 찾을 수 없습니다.');
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      throw new store.AppError(404, '이미지를 찾을 수 없습니다.');
    }
    sendFile(res, file, 200, 'public, max-age=31536000, immutable');
    return;
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
    const hookInfo = depositKeyInfo();
    console.log('입금 알림 웹훅: /api/hooks/deposit-notify (키 지문 ' + hookInfo.fingerprint +
      ' · 출처 ' + hookInfo.source + ')');
    console.log('  → 폰 Tasker/MacroDroid에 /admin [설정] 탭의 웹훅 URL을 그대로 붙여넣으세요.');
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
    const expired = store.expirePendingDepositOrders();
    if (expired > 0) console.log('[자동입금확인] 오래된 입금대기 ' + expired + '건 자동 취소');
  } catch (err) {
    console.error('[자동입금확인 오류]', err);
  }
}, 15000).unref();

/* ────────────────────────────────────────────────────────────
   무료 플랜 슬립 방지: 5분마다 공개 URL 을 스스로 핑합니다.
   Render 무료 웹 서비스는 15분간 요청이 없으면 잠들기 때문에,
   RENDER_EXTERNAL_URL 이 있으면 자동으로 켜집니다.
   KEEP_ALIVE=0 으로 끄고, KEEP_ALIVE_URL / KEEP_ALIVE_INTERVAL_SECONDS 로 조정합니다.
   ──────────────────────────────────────────────────────────── */
const KEEP_ALIVE_ENABLED = process.env.KEEP_ALIVE !== '0';
/* 최소 5초(테스트용) · 기본 300초(5분) */
const KEEP_ALIVE_INTERVAL_MS = Math.max(5, Number(process.env.KEEP_ALIVE_INTERVAL_SECONDS) || 300) * 1000;
const KEEP_ALIVE_TARGET = (process.env.KEEP_ALIVE_URL ||
  (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '') + '/api/ping' : '')).trim();

if (KEEP_ALIVE_ENABLED && KEEP_ALIVE_TARGET) {
  let lastOkLog = 0;
  const ping = async () => {
    const startedAt = Date.now();
    try {
      const res = await fetch(KEEP_ALIVE_TARGET, {
        headers: { 'user-agent': 'apex-shop-keepalive/1.0' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) {
        console.warn('[핑] 응답 ' + res.status + ' · ' + KEEP_ALIVE_TARGET);
        return;
      }
      const now = Date.now();
      if (now - lastOkLog > 3600000) {
        console.log('[핑] 정상 ' + res.status + ' · ' + (now - startedAt) + 'ms · ' + KEEP_ALIVE_TARGET);
        lastOkLog = now;
      }
    } catch (err) {
      console.warn('[핑] 실패 · ' + (err && err.name === 'TimeoutError' ? '시간 초과' : (err && err.message)));
    }
  };
  setTimeout(ping, 2000).unref();
  setInterval(ping, KEEP_ALIVE_INTERVAL_MS).unref();
  console.log('[핑] 슬립 방지 활성 · ' + Math.round(KEEP_ALIVE_INTERVAL_MS / 1000) + '초 간격 · ' + KEEP_ALIVE_TARGET);
}


