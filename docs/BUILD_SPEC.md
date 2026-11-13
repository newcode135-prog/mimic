# 미믹 개발 규약 (모듈 개발자·AI 공용)

이 문서는 **어떻게 만드는지**를 정한다. **무엇을 만드는지**는 `docs/MIMIC_PLAN.md`(6~8장)와 `docs/features.json`이 기준이다.

## 0. 절대 규칙

1. **PikPak의 로고·이미지·CSS·화면 문구·약관 문장을 복사하지 않는다.** 기능·정책 수치·화면 구조(메뉴 구성, 흐름)만 같게 하고, 보이는 문장과 시각 요소는 미믹 고유로 새로 쓴다.
2. 외부 링크로 받은 파일은 **요청한 사용자의 미믹 클라우드에만** 저장한다.
3. **자기 담당 파일만** 만들고 고친다(5장 표). 코어·다른 모듈 파일 변경이 필요하면 고치지 말고 결과 보고에 "코어 변경 요청"으로 적는다.
4. `package.json`을 고치거나 `npm install`을 하지 않는다. 설치된 의존성: express 5, busboy, webtorrent, webdav-server, adm-zip, qrcode, grammy, @modelcontextprotocol/sdk, zod. 시스템에 ffmpeg·ffprobe 있음, yt-dlp 없음(있으면 쓰고 없으면 안내 오류).
5. 포트 4300 에 서버를 띄우지 않는다(다른 사람이 쓰는 중일 수 있음). 테스트는 `test/helpers.js`의 `startServer()`가 임의 포트로 띄운다.
6. 개발 모드에서는 실제 이메일·SMS·결제를 하지 않는다. `sendMessage()`가 outbox 에 쌓고 `/dev/outbox` 화면에서 보인다. 결제는 "테스트 결제" 흐름으로 완결한다.
7. 비밀번호·토큰·인증코드는 해시로만 저장한다. 사용자 입력은 서버에서 검증한다. 다른 사용자의 파일에 접근할 수 없게 모든 쿼리에 `user_id` 조건을 건다.
8. 화면 문구는 한국어 기본, `t('한국어', 'English')`로 영어를 함께 적는다.

## 1. 실행

```bash
node --test test/<모듈>.test.js   # 내 모듈 테스트
npm test                          # 전체
npm start                         # http://localhost:4300 (데이터: MIMIC_DATA, 기본 ~/.mimic)
```

## 2. 서버 모듈 규약

`server/modules/<모듈>/index.js` 하나가 진입점이다(같은 폴더에 파일을 더 나눠도 됨).

```js
export const migrations = `CREATE TABLE IF NOT EXISTS <모듈>_xxx (...);`; // 테이블 이름은 모듈 이름으로 시작, users 참조는 ON DELETE CASCADE
export function register(app, ctx) { app.get('/api/<모듈>/...', requireUser, (req, res) => ...); }
export const jobs = [{ name: '<모듈>:이름', everyMs: 60_000, run: (ctx) => {} }]; // 선택
export async function close(ctx) {} // 선택: 테스트 종료 때 자원 정리(토렌트 클라이언트 등)
```

- `ctx = { db, cfg, events, modules, server }`. `db`는 `node:sqlite` DatabaseSync(동기 API: `db.prepare(sql).get/all/run`). 트랜잭션은 `tx(db, fn)`(server/core/db.js).
- Express 5: async 핸들러의 오류는 자동으로 공통 오류 처리기로 간다. 오류는 `fail(status, code, 메시지)`로 던진다 → `{ error: code, message }`.
- API 경로: `/api/<모듈>/...`. 예외: auth 는 `/api/auth`, admin-content 는 `/api/admin/*`·`/api/content/*`·`/api/notifications/*`, 다른 모듈의 관리자 API 는 `/api/admin/<모듈>/*`(requireAdmin).
- 한 모듈의 불러오기·등록이 실패해도 다른 모듈은 동작한다(`/api/health`의 failed 목록).

### 2-1. 코어 API (`server/core/*`)

| 파일 | 함수 |
| --- | --- |
| util.js | `now()`, `newId(prefix)`, `sha256(s)`, `randomCode(n)`, `fail(status, code, msg)`, `json(str, fallback)`, `rateLimit(key, max, windowMs)`, `periodKeys(ts)`, `DAY` |
| auth.js | `requireUser`, `requireAdmin`, `requirePremium`, `requireScope(scope)`, `hasScope(req, scope)`, `quotaSource(req)`('official'·'app'), `createSession(db, userId, req, device)`, `setSessionCookie(res, token, cfg)`, `destroySession(db, token)`, `readToken(req)`, `createToken(db, userId, { name, scopes, appId, days })`→`{id, token}`, `hashPassword`, `verifyPassword`, `passwordValid`, `publicUser(u)`, `getSettings(u)`, `saveSettings(db, userId, patch)` |
| storage.js | `ingestStream(db, cfg, readable, mime, { maxBytes })`→`{hash,size,deduped}`, `ingestFile(db, cfg, path, mime)`, `hasBlob`, `blobPath(cfg, hash)`, `tmpPath(cfg, prefix)`, `sendBlob(req, res, cfg, hash, { name, mime, inline, throttleBps, onBytes })`, `gcBlobs` |
| files.js | `toApi(node)`, `getNode`, `requireNode(db, userId, id, { kind, space, allowTrashed })`, `listChildren`, `uniqueName`, `createFolder(db, userId, parentId, name, { space, origin, meta })`, `createFileNode(db, userId, parentId, { name, size, mime, blobHash, origin, meta, space })`, `ensureFolderPath(db, userId, names)`, `usage`, `checkCapacity(db, user, bytes, space)`, `pathOf`, `descendantIds`, `copyTree(db, srcUser, srcId, dstUser, dstParent, { origin })`, `treeSize`, `validName` |
| plans.js | `LIMITS`, `MONTHLY_QUOTA`, `PRODUCTS`, `PAYMENT_METHODS`, `REFERRAL`, `EXPIRY`, `DORMANT`, `TRASH_DAYS`, `SIGNUP_BONUS_CLOUD`, `VAULT_STORAGE`, `SHARE_EXPIRY_DAYS`, `BT_MAX_FILES`, `SLOW_BPS`, `SPEED_BPS`, `isPremium(u)`, `limitsFor(u)`, `capacityOf(u)`, `speedFor(u)` |
| quota.js | `addUsage(db, userId, kind, bytes, source)`, `checkTransfer(db, user, kind, bytes, source)`→`{ok, reason, slow}`, `cloudTaskAllowance(db, user)`, `consumeCloudTask(db, user)`, `grant(db, userId, { kind, amount, period, validFrom, validTo, reason })`, `monthlyLimit`, `summary(db, user)` |
| notify.js | `notify(db, userId, { kind, title, body, link })`, `sendMessage(db, cfg, { channel, to, subject, body })`, `audit(db, { userId, action, detail, ip })` |

공통 테이블은 `server/core/schema.sql`(users, identities, sessions, personal_tokens, blobs, files, notifications, outbox, blocklist, audit_log, quota_usage, quota_grants). `users.settings`는 JSON 문자열.

### 2-2. 사용자 설정 키 (`users.settings`, `saveSettings`로 저장)

`lang`('ko'|'en'), `sortScope`('folder'|'global'), `viewScope`('folder'|'global'), `sortPrefs`·`viewPrefs`(폴더별 저장 객체), `shareCodeDisplay`('direct'|'warn'), `uploadConcurrency`(기본 3), `uploadAutoRetry`(true), `appFilesFolder`(true: 텔레그램 등은 전용 폴더), `torrentAutoDetect`(true), `btSmartFilter`(true), `shareDefaultView`('grid'|'list'), `webdavEnabled`(false). 설정 화면은 integrations 모듈 담당, 값은 각 모듈이 읽는다.

### 2-3. 모듈 간 이벤트 (`ctx.events`)

| 이벤트 | 보내는 곳 | 내용 | 받는 곳 |
| --- | --- | --- | --- |
| `user:created` | auth | `{ userId, via, inviteCode }` | drive(온보딩 My Pack·튜토리얼·보너스 2회), billing(초대 관계) |
| `user:login` | auth | `{ userId, via }` | (선택) |
| `user:deleted` | auth | `{ userId }` | 각 모듈 정리(대부분 ON DELETE CASCADE 로 충분) |
| `payment:completed` | billing | `{ userId, orderId, productId, days }` | (선택) 알림 |

## 3. 웹 화면 규약

- 빌드 도구 없음. ES 모듈을 그대로 브라우저가 불러온다. 경로는 절대경로(`/ui.js`, `/pages/x.js`).
- **페이지**: `web/pages/<페이지>.js`가 `export async function render(root, ctx)`를 내보낸다. `root`에만 그린다(다시 그릴 때도 같은 root). 정리 함수를 돌려주면 화면을 떠날 때 호출된다. `ctx = { params, query, me, user, path, navigate, refreshMe }`. 용량 표시 갱신은 `import { refreshShell } from '/layout.js'`.
- **주소 표**는 `web/app.js`의 `ROUTES`(이미 모든 화면 등록). 페이지 파일이 없으면 "준비 중"이 뜬다. 주소 추가가 필요하면 코어 변경 요청.
- **레이아웃**(`web/layout.js`): drive(사이드바·상단바·전송 패널), site(공개), auth(로그인), admin, bare. 레이아웃은 아래 컴포넌트를 부른다.
- **공통 도구**(`web/ui.js`): `api(path, { method, body })`, `h(tag, attrs, ...children)`, `esc`, `t(ko, en)`, `toast`, `toastError`, `modal({ title, body, actions, wide })`, `confirmDialog`, `promptDialog`, `openMenu(anchor, items)`, `formatBytes/Date/Duration/Won`, `bus.on/emit`, `getMe(force)`, `clearMe`, `loadCss(href)`, `useComponent(name)`, `callComponent(name, fn, ...args)`, `icon(name)`, `fileIcon(node)`.
- 디자인 토큰·공통 클래스는 `web/styles.css`(btn, input, card, badge, tabs, table, progress, empty, menu, modal, file-grid, file-card, page-head 등). 모듈 전용 스타일은 `web/css/<모듈>.css`를 `loadCss('/css/<모듈>.css')`로 불러온다.
- 화면 사이 이벤트(`bus`): `transfer:update` `{ id, type: 'upload'|'download', name, size, loaded, status: 'running'|'done'|'error', error }` — drive 가 보내고 전송 패널(offline)이 표시. `drive:changed` `{ parentId }` — 파일이 생기거나 바뀌면 보내고 drive 목록이 새로 고침.

### 3-1. 컴포넌트 (다른 모듈이 부르는 화면 조각)

| 파일 | 내보내는 함수 | 담당 |
| --- | --- | --- |
| `web/components/offline.js` | `openCreateTask({ parentId })` 클라우드 다운로드 작업 생성 창 | offline |
| `web/components/transfers.js` | `mount(el)` 오른쪽 아래 전송 패널(탭 3개) | offline |
| `web/components/folder-picker.js` | `pickFolder({ title })` → 폴더 id(루트는 null), 취소 시 undefined | drive |
| `web/components/share.js` | `openShareDialog(fileIds)` | share |
| `web/components/coupon.js` | `openCoupon()` | billing |
| `web/components/feedback.js` | `openFeedback()` | auth |

### 3-2. 모듈 간 API 약속

| API | 담당 | 쓰는 곳 |
| --- | --- | --- |
| `GET /api/drive/files/:id` → `{ file, path }` | drive | media, share |
| `GET /api/drive/list?parentId=` → `{ items, path }` | drive | folder-picker, media(이전/다음) |
| `GET /api/drive/files/:id/download` (첨부, 다운스트림 쿼터) | drive | 여러 곳 |
| `GET /api/media/:id/stream`, `/hls/...`, `/info`, `/external-url` | media | 플레이어·외부 플레이어 |
| `POST /api/offline/tasks` `{ urls[], parentId }`·`/torrent`(multipart) | offline | 확장·텔레그램·CLI·MCP |
| `POST /api/auth/logout` | auth | 레이아웃 |
| `GET /api/notifications/unread-count`, `GET /api/notifications`, `POST /api/notifications/read` | admin-content | 레이아웃·알림 화면 |
| `GET /api/billing/products`, `POST /api/billing/orders`, `POST /api/billing/orders/:id/confirm` | billing | 결제 화면 |
| `GET /api/admin/billing/orders`(`?archived=1` 보관 주문), `POST /api/admin/billing/orders/:id/refund`, `GET/POST /api/admin/billing/coupons` | billing | 관리자 화면(admin-content) |
| `GET /api/admin/billing/invites`, `POST /api/admin/billing/invites/:inviteeId`(보류 보상 지급·회수), `GET /api/admin/billing/pro-applications`, `POST /api/admin/billing/pro-applications/:id`, `GET /api/admin/billing/stats` | billing | 관리자 화면(admin-content) |
| `POST /api/admin/auth/users/:id/contact-invalid`, `POST /api/admin/auth/users/:id/delete-hold` | auth | 관리자 회원 화면 |
| `GET /api/notifications/push/key`, `POST/DELETE /api/notifications/push-subscriptions` | admin-content(저장) · core notify(발송) | 알림 화면·서비스 워커 |
| 모든 `api()` 요청 헤더 `x-mimic-lang: ko|en` → 서버 콘텐츠·알림 언어 | web/ui.js · content | 도움말·FAQ·블로그·정책·알림 |
| `GET /api/billing/quota` → `quota.summary` | billing | 쿼터 화면 |

## 4. 테스트

- `test/<모듈>.test.js` 하나. `startServer()`로 서버를 띄우고 `createUser(db, { premium, admin })`, `sessionFor(db, userId)`, `client(url, token)`으로 API 를 부른다.
- 다른 모듈에 기대지 않는다. 필요한 데이터는 코어 함수(`createFileNode`, `ingestStream` 등)로 직접 만든다.
- 네트워크가 필요한 실제 토렌트·외부 URL 대신 테스트 안에서 띄운 로컬 HTTP 서버를 쓴다.
- 기능 ID 마다 최소 하나의 확인을 남긴다(테스트 이름에 ID 표기, 예: `'[B-02] 휴지통 15일 뒤 영구삭제'`).

## 5. 파일 담당

| 모듈 | 담당 파일 |
| --- | --- |
| core | `server/index.js`, `server/core/*`(plans.js·quota.js 제외), `web/index.html`, `web/app.js`, `web/ui.js`, `web/layout.js`, `web/styles.css`, `web/logo.svg`, `web/pages/dev-outbox.js`, `test/helpers.js`, `test/core.test.js`, `docs/*` |
| auth | `server/modules/auth/`, `web/pages/login.js`, `approve.js`, `account.js`, `web/components/feedback.js`, `web/css/auth.css`, `test/auth.test.js` |
| drive | `server/modules/drive/`, `web/pages/drive.js`, `web/components/folder-picker.js`, `web/css/drive.css`, `test/drive.test.js` |
| offline | `server/modules/offline/`, `web/components/offline.js`, `web/components/transfers.js`, `web/css/offline.css`, `test/offline.test.js` |
| media | `server/modules/media/`, `web/pages/player.js`, `preview.js`, `history.js`, `web/css/media.css`, `test/media.test.js` |
| share | `server/modules/share/`, `web/pages/shared.js`, `share-view.js`, `web/components/share.js`, `web/css/share.css`, `test/share.test.js` |
| vault | `server/modules/vault/`, `web/pages/vault.js`, `vault-share.js`(주소 `/vs/:token`), `web/css/vault.css`, `test/vault.test.js` |
| billing | `server/modules/billing/`, `server/core/plans.js`, `server/core/quota.js`, `web/pages/payment.js`, `orders.js`, `quota.js`, `invite.js`, `web/components/coupon.js`, `web/css/billing.css`, `test/billing.test.js` |
| integrations | `server/modules/integrations/`, `web/pages/settings.js`, `cli/`, `extension/`, `tools/telegram-bot/`, `web/css/integrations.css`, `test/integrations.test.js` |
| admin-content | `server/modules/admin/`, `server/modules/content/`, `web/pages/admin.js`, `landing.js`, `bt.js`, `apps.js`, `blog.js`, `help.js`, `faq.js`, `contact.js`, `policy.js`, `transparency.js`, `copyright.js`, `checkin-guide.js`, `notifications.js`, `tv.js`, `web/css/content.css`, `web/css/admin.css`, `test/admin-content.test.js` |

## 6. 결과 보고 형식(에이전트)

담당 기능 ID 마다 `구현됨 / 일부 / 안 됨`과 이유, 만든 파일, 테스트 결과(통과·실패 수), 코어 변경 요청을 남긴다.
