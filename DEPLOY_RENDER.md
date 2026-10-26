# Render 배포 가이드 (Apex shop)

이 프로젝트는 **npm 패키지가 하나도 없는 순수 Node.js 앱**이라 Render에 그대로 올릴 수 있습니다.
핵심은 두 가지입니다.

1. **Node 24** 사용 (`node:sqlite` 내장 모듈 필요, 22.13 이상)
2. **Persistent Disk** 를 붙여 SQLite 파일(`shop.db`)을 영구 보관

> ⚠️ Render **Free 플랜은 디스크를 지원하지 않습니다.** 재배포·재시작·슬립 복귀 시
> 회원/주문/재고 데이터가 초기화됩니다. 실제 판매용이라면 **Starter($7/월) + Disk 1GB** 를 쓰세요.

---

## 1. GitHub 에 올리기

`game-shop` 폴더를 저장소 루트로 올리는 것이 가장 간단합니다.

```powershell
cd C:\Users\USER\.cline\data\workspaces\chat\game-shop

git init
git add .
git commit -m "Apex shop: Render deploy ready"
git branch -M main
git remote add origin https://github.com/<내계정>/apex-shop.git
git push -u origin main
```

`.gitignore` 에 `data/*.db` 가 들어 있어 **회원 비밀번호 해시·주문 데이터는 커밋되지 않습니다.**
(`render.yaml`, `.node-version`, `package.json` 은 반드시 함께 커밋)

> 상위 폴더(여러 프로젝트가 있는 workspace)를 저장소로 올린 경우에는 `render.yaml` 의
> 서비스 블록에 `rootDir: game-shop` 한 줄을 추가하세요.

---

## 2. Blueprint 로 배포 (권장)

1. Render 대시보드 → **New +** → **Blueprint**
2. 방금 올린 저장소 선택 → **Apply**
3. `ADMIN_PASSWORD` 입력창이 뜨면 **8자 이상의 새 관리자 비밀번호**를 입력
   (기본값 `admin1234` 를 그대로 쓰지 마세요)
4. 배포가 끝나면 `https://apex-shop-xxxx.onrender.com` 주소가 생성됩니다.

`render.yaml` 이 자동으로 설정하는 값:

| 항목 | 값 |
| --- | --- |
| Runtime | Node (`NODE_VERSION=24.22.1`) |
| Build / Start | `npm install` / `npm start` |
| Health check | `/api/store` |
| DB 경로 | `SHOP_DB=/var/data/shop.db` |
| 디스크 | `apex-shop-data` → `/var/data` (1GB) |

---

## 2-1. 무료 플랜 슬립 방지 (5분 핑)

Render 무료 웹 서비스는 **15분 동안 요청이 없으면 슬립**합니다.
이 앱은 `RENDER_EXTERNAL_URL` 이 있으면 **5분마다 자기 자신의 `/api/ping` 을 호출**해 슬립을 막습니다.
(별도 설정 없이 자동, Render가 넣어 주는 환경변수 사용)

- `render.yaml` 의 `KEEP_ALIVE=1` 이 스위치입니다. `0` 으로 바꾸면 꺼집니다.
- 배포 로그에 아래 줄이 보이면 정상 동작입니다.

  ```
  [핑] 슬립 방지 활성 · 300초 간격 · https://apex-shop-xxxx.onrender.com/api/ping
  [핑] 정상 200 · 42ms · https://apex-shop-xxxx.onrender.com/api/ping
  ```
  (성공 로그는 1시간에 한 번만 남기고, 실패는 매번 남깁니다)

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `KEEP_ALIVE` | `1` | `0` 이면 핑 끔 |
| `KEEP_ALIVE_INTERVAL_SECONDS` | `300` | 핑 간격(초). 최소 5 (권장 300) |
| `KEEP_ALIVE_URL` | `RENDER_EXTERNAL_URL/api/ping` | 직접 지정할 때 |

**요금/한도 주의**

- **무료 플랜**으로 돌리려면 `render.yaml` 의 `plan: starter` 를 `plan: free` 로 바꾸고
  `disk:` 블록을 지워야 합니다(무료는 디스크 미지원 → 재배포/재시작 시 DB 초기화).
  이때 5분 핑이 슬립을 막아 주지만, 데이터 영속성이 없으므로 **데모용**으로만 권장합니다.
- Free 플랜은 워크스페이스당 **월 750 인스턴스 시간**입니다. 상시 켜 두는 서비스 1개는
  약 720~744시간이라 한도 안에 들어오지만, **무료 서비스를 2개 이상 상시로 켜면 초과**합니다.
- Starter 플랜은 슬립이 없으므로 핑이 필요 없습니다 → `KEEP_ALIVE=0` 으로 끄세요(비용·로그 절약).
- 핑은 서버가 **살아 있을 때만** 동작합니다. Render 쪽 장애/재시작으로 내려간 경우 스스로 깨우지 못하므로,
  필요하면 **UptimeRobot / cron-job.org** 같은 무료 외부 모니터에
  `https://<서비스주소>/api/ping` 을 5분 간격으로 등록하세요(가장 확실한 방법).
- GitHub Actions 의 `schedule: */5` 는 최소 5분이지만 실제로는 수 분 지연되거나
  60일 저장소 활동이 없으면 자동 비활성화되므로, 보조 수단으로만 쓰세요.

---

## 3. 수동으로 만들기 (Blueprint 없이)

**New +** → **Web Service** → 저장소 선택 후:

- Runtime: **Node**
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/store`
- Environment:
  - `NODE_VERSION` = `24.22.1`
  - `SHOP_DB` = `/var/data/shop.db`
  - `ADMIN_PASSWORD` = 원하는 관리자 비밀번호
- **Disk**: Name `apex-shop-data`, Mount Path `/var/data`, Size `1GB`
  (Disk 는 Starter 이상 플랜에서만 추가 가능)

---

## 4. 첫 배포 후 체크리스트

1. `https://<서비스주소>/` 접속 → Apex shop 이 보이는지 확인
2. `https://<서비스주소>/admin` → 위에서 정한 비밀번호로 로그인
3. **설정 → 비밀번호 변경** (환경변수 대신 DB 해시로 저장됩니다)
4. **설정**에서 실제 정보로 교체
   - 은행 / 계좌번호 / 예금주
   - 디스코드 문의 링크 (`contact_url`)
   - 자동입금확인 ON/OFF, 지연(분), 즉시 자동지급 여부
5. **상품 → 재고**에서 샘플 계정을 실제 판매할 계정으로 교체
   (샘플 값은 예시이므로 그대로 판매하면 안 됩니다)
6. **설정 → 자동입금확인 · 웹훅**에서 토큰 확인
7. 테스트 회원가입 → 주문 → (자동확인 지연 0분이면 즉시) 보관함 지급 확인

---

## 5. 입금 웹훅 연결

관리자 → 설정의 웹훅 주소는 자동으로 `https://<서비스주소>/api/hooks/deposit` 입니다.

```bash
curl -X POST "https://<서비스주소>/api/hooks/deposit" \
  -H "Content-Type: application/json" \
  -H "x-deposit-token: <관리자 설정의 토큰>" \
  -d "{\"code\":\"GS260101-ABCD\"}"
```

- `code`: 주문번호로 정확히 확인
- `amount`: 같은 금액의 가장 오래된 입금대기 주문을 확인
- 토큰은 `/api/store` 응답에 포함되지 않고, 관리자 API에서만 확인됩니다.

### 5-1. 폰 알림 자동입금 (Tasker / MacroDroid)

관리자 → **설정 → 폰 알림 자동입금확인**에 주소(`https://<서비스주소>/api/hooks/deposit-notify?key=...`)와
키가 표시됩니다. 은행 앱 알림을 감지해 아래처럼 POST 하면 금액·입금자명이 일치하는 입금대기 주문이 즉시 지급됩니다.

```json
{ "title": "%evtprm2", "body": "%evtprm3", "package": "%evtprm1" }
```

- Tasker 는 `%ntitle/%ntext` 대신 **`%evtprm1/2/3`** 을 쓰세요. 치환되지 않은 변수가 오면 서버가
  `tasker_var_not_substituted` 를 돌려주고 관리자 로그에 남깁니다.
- 키를 고정하려면 Render → **Environment** 에 `DEPOSIT_WEBHOOK_KEY` 를 추가하세요.
  DB 보다 우선하므로 무료 플랜에서 DB 가 초기화되어도 웹훅이 끊기지 않습니다.
  (환경변수로 고정하면 관리자 화면의 키 회전 버튼은 비활성화됩니다.)
- 매칭이 2건 이상이면 자동 지급하지 않고 `ambiguous` 로 기록합니다. 주문 탭에서 직접 확인하세요.
- `입금대기 자동취소(분)` 을 켜면 알림 누락 시 실제 입금 주문이 취소될 수 있으니 주의하세요.

### 5-2. 구매 인증 후기

회원이 **지급완료** 주문의 상품에만 후기를 남길 수 있습니다. 별도 설정은 필요 없고,
관리자 → **후기** 탭에서 회원이 남긴 후기를 숨김/삭제할 수 있습니다.

---

## 6. 백업

관리자 → **설정 → 데이터베이스 백업 → DB 백업 다운로드** 를 누르면
현재 SQLite 파일을 그대로 내려받습니다. (WAL 체크포인트 후 전송)

배포 전·재고 대량 등록 전에 받아 두면 안전합니다.
서버는 Render의 `SIGTERM` 을 받으면 WAL 을 정리하고 정상 종료합니다.

---

## 7. 자주 겪는 문제

| 증상 | 원인 / 해결 |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node 버전이 낮음 → `NODE_VERSION=24.22.1` 또는 `.node-version` 확인 |
| 502 / 무한 로딩 | Start Command 가 `npm start` 인지, 로그에 포트 바인딩 오류가 없는지 확인 |
| 재배포 후 데이터 사라짐 | 디스크 미연결 또는 `SHOP_DB` 경로가 마운트 경로(`/var/data`) 밖 |
| 로그인 후 바로 풀림 | 커스텀 도메인/프록시에서 HTTPS 가 아닌 주소로 접속했는지 확인 (HTTPS면 Secure 쿠키 자동) |
| 첫 접속이 30초 이상 걸림 | Free 플랜 슬립 상태에서 깨어나는 중 (Starter 는 항상 켜짐) |
| 관리자 비밀번호 분실 | Render Shell 에서 `ADMIN_PASSWORD` 를 새 값으로 바꾸고 재배포해도, DB에 해시가 있으면 환경변수는 무시됩니다. DB 백업본이 없다면 `users`/설정 초기화가 필요합니다 |

---

## 8. 도메인 연결

Render 서비스 → **Settings → Custom Domains** → 도메인 추가 →
안내되는 CNAME(또는 A) 레코드를 DNS에 등록하면 HTTPS 인증서가 자동 발급됩니다.
쇼핑몰 링크·디스코드 안내도 새 도메인으로 바꿔 주세요.
