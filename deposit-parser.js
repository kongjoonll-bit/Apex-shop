/* ============================================================
   입금 알림 파서 — Tasker/MacroDroid 웹훅 전용 (외부 패키지 없음)

   동작 원리 (Discord-Battle-Cat-Vending-Machine 과 동일한 방식):
   1. 폰의 Tasker 가 은행/토스 앱 알림을 POST /api/hooks/deposit-notify 로 전송
      Body(JSON): { "title": "...", "body": "...", "package": "..." }
   2. 이 모듈이 알림 문구에서 금액/입금자명을 추출
   3. 서버가 금액 + 입금자명이 모두 일치하는 입금대기 주문을 찾아 자동 확인·지급

   지원하는 알림 형식 예시:
   - "5,000원 입금 홍길동 → 내 토스뱅크 통장"
   - "[토스뱅크] 입금 5,000원 홍길동 잔액 10,000원"
   - "홍길동님이 5,000원을 보냈습니다"
   - "입금 5,000원 홍길동" / "홍길동 5,000원 입금"
   ============================================================ */
'use strict';

/* 입금으로 인정할 키워드 (하나 이상 있어야 입금 알림으로 취급) */
const DEPOSIT_KEYWORDS = ['입금', '받았', '받기', '보냈', '송금', '이체', '입금되'];

/* 금액 추출 패턴 (우선순위 순 — 입금 금액이 잔액보다 먼저 잡히도록) */
const AMOUNT_PATTERNS = [
  /입금(?:자명|자)?\s*[:：]?\s*([\d,]+)\s*원/,           // "입금 5,000원"
  /([\d,]+)\s*원\s*(?:이|을)?\s*입금/,                    // "5,000원 입금"
  /([\d,]+)\s*원(?:을|를)?\s*(?:보냈|송금|이체|받았)/,      // "5,000원을 보냈습니다"
  /입금\s*[:：]?\s*([\d,]+)/,                            // "입금 5000" (원 누락)
  /([\d,]+)\s*원/                                        // 최종 폴백: 첫 번째 N원
];

/* 입금자명 추출 패턴 (우선순위 순) */
const NAME_PATTERNS = [
  /입금(?:자명|자)?\s*[:：]?\s*([가-힣]{2,5}|[A-Za-z]{2,20})(?![\d,]*\s*원)/,
  /([가-힣]{2,5})\s*(?:님)?\s*→/,
  /([가-힣]{2,5})님[이가]?\s*[\d,]+원?/,
  /입금(?:되었|완료)[\s가-힣]{0,4}?([가-힣]{2,5})/,
  /([가-힣]{2,5})\s*(?:님)?(?:이|가|께서)?\s*[\d,]+원\s*(?:을|를)?\s*(?:입금|보냈|송금|이체)/
];

/* 입금자명 후보에서 제외할 단어 (정확히 일치) */
const NAME_BLOCK_EXACT = [
  '입금', '출금', '이체', '송금', '충전', '통장', '계좌', '뱅크', '은행',
  '잔액', '확인', '완료', '알림', '내', '아이', '미성년', '거래', '취소',
  '요청', '받기', '받음', '보냄', '토스', '급여', '이자', '환급', '카드',
  '체크', '자동', '결제', '신한', '국민', '우리', '하나', '농협', '기업'
];

/* 입금자명 후보에서 제외할 단어 (부분 포함) */
const NAME_BLOCK_CONTAIN = [
  '뱅크', '은행', '통장', '잔액', '입금', '출금', '이체', '송금', '충전',
  '계좌', '토스', '알림', '완료', '거래', '포인트', '쿠폰', '카드', '체크'
];

/* 잔액 문구는 금액 후보에서 제거 ("잔액 10,000원" 을 입금액으로 오인하지 않도록) */
const BALANCE_PATTERN = /잔액\s*[:：]?\s*[\d,]+\s*원?/g;

/* Tasker 변수가 치환되지 않고 그대로 도착한 경우 감지 */
const TEMPLATE_VAR_PATTERN = /%(?:evtprm\d+|ntitle|ntext|napp|npackage|[a-z_]{3,})\b/gi;

function normalizeNotification(title, body, extra) {
  const text = [title || '', body || '', extra || ''].join(' ').trim();
  return text.replace(/\s+/g, ' ');
}

function stripBalance(text) {
  return String(text || '').replace(BALANCE_PATTERN, ' ');
}

function isOutgoing(text) {
  const value = String(text || '');
  /* "1,000원 출금" 처럼 출금만 있고 입금이 없으면 무시 */
  if (value.indexOf('출금') !== -1 && value.indexOf('입금') === -1) return true;
  /* "홍길동님에게 5,000원을 보냈습니다" = 내가 보낸 돈 */
  if (/님?\s*에게.{0,30}(?:보냈|이체|송금)/.test(value)) return true;
  return false;
}

function isNameBlocked(candidate) {
  if (!candidate) return true;
  const name = String(candidate).trim();
  if (name.length < 2) return true;
  if (NAME_BLOCK_EXACT.indexOf(name) !== -1) return true;
  for (let i = 0; i < NAME_BLOCK_CONTAIN.length; i += 1) {
    if (name.indexOf(NAME_BLOCK_CONTAIN[i]) !== -1) return true;
  }
  return false;
}

function extractAmount(text) {
  const value = stripBalance(text);
  for (let i = 0; i < AMOUNT_PATTERNS.length; i += 1) {
    const match = value.match(AMOUNT_PATTERNS[i]);
    if (match) {
      const amount = Number(String(match[1]).replace(/,/g, ''));
      if (Number.isFinite(amount) && amount > 0) return Math.round(amount);
    }
  }
  return null;
}

function extractDepositor(text) {
  for (let i = 0; i < NAME_PATTERNS.length; i += 1) {
    const match = text.match(NAME_PATTERNS[i]);
    if (match) {
      const candidate = String(match[1]).trim();
      if (!isNameBlocked(candidate)) return candidate;
    }
  }
  /* 최종 폴백: 한글 단어를 순서대로 보며 제외어가 아닌 첫 후보 */
  const words = text.match(/[가-힣]{2,6}/g) || [];
  for (let i = 0; i < words.length; i += 1) {
    if (!isNameBlocked(words[i])) return words[i];
  }
  return null;
}

/**
 * 알림 문구 → 입금 정보
 * @param {string} title 알림 제목
 * @param {string} body 알림 본문
 * @param {string} extra package 자리에 섞여 들어온 문구 등
 * @returns {{text:string, isDepositLike:boolean, outgoing:boolean, depositor:string|null, amount:number|null, ok:boolean}}
 */
function parseNotification(title, body, extra) {
  const text = normalizeNotification(title, body, extra);
  const isDepositLike = DEPOSIT_KEYWORDS.some((keyword) => text.indexOf(keyword) !== -1);
  const outgoing = isOutgoing(text);
  const result = {
    text: text,
    isDepositLike: isDepositLike,
    outgoing: outgoing,
    depositor: null,
    amount: null,
    ok: false
  };
  if (!text || !isDepositLike || outgoing) return result;
  result.amount = extractAmount(text);
  result.depositor = extractDepositor(text);
  result.ok = !!(result.amount && result.depositor);
  return result;
}

/** 입금자명 비교용 정규화: 공백/숫자/단위/불필요 단어 제거 */
function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\d,]+원?/g, '')
    .replace(/(입금|충전|계좌|이체|송금|예금주|성함)/g, '')
    .trim();
}

/** 요청 입금자명과 알림(추출명/전체 문구)이 같은 사람인지 판단 */
function nameMatches(requestName, depositor, normalizedText) {
  const request = normalizeName(requestName);
  if (!request) return false;
  const extracted = normalizeName(depositor);
  if (extracted && extracted === request) return true;
  const text = String(normalizedText || '');
  if (text && text.indexOf(request) !== -1) return true;
  if (extracted && extracted.length >= 2 && request.indexOf(extracted) !== -1) return true;
  return false;
}

/** Tasker 변수 미치환 목록 (예: %evtprm1) */
function detectTemplateVars(text) {
  const found = String(text || '').match(TEMPLATE_VAR_PATTERN) || [];
  return Array.from(new Set(found));
}

/** 웹훅 키 붙여넣기 사고 보정 (앞뒤 공백/개행/따옴표 제거) */
function normalizeKey(raw) {
  let key = String(raw === undefined || raw === null ? '' : raw).trim();
  if (key.length >= 2 && key[0] === key[key.length - 1] && (key[0] === '"' || key[0] === "'")) {
    key = key.slice(1, -1).trim();
  }
  return key;
}

/** 키 원문을 노출하지 않고 비교하기 위한 지문(sha256 앞 8자) */
function keyFingerprint(key) {
  const value = normalizeKey(key);
  if (!value) return '-';
  return require('crypto').createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

module.exports = {
  DEPOSIT_KEYWORDS,
  parseNotification,
  extractAmount,
  extractDepositor,
  normalizeNotification,
  normalizeName,
  nameMatches,
  detectTemplateVars,
  normalizeKey,
  keyFingerprint
};
