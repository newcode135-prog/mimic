-- 미믹 공통 스키마. 모듈 전용 테이블은 각 모듈의 migrations 에서 만든다.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  lang TEXT NOT NULL DEFAULT 'ko',
  region TEXT NOT NULL DEFAULT 'KR',
  tier TEXT NOT NULL DEFAULT 'global',          -- 프리미엄 등급: global | regional
  premium_until INTEGER,                        -- epoch ms, NULL 이면 무료
  premium_expired_at INTEGER,                   -- 만료 처리 단계 계산용
  extra_storage_bytes INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',        -- active | unverified | locked | suspended | pending_delete | deleted
  status_until INTEGER,
  delete_requested_at INTEGER,
  invite_code TEXT UNIQUE,
  invited_by TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,                       -- google | facebook | apple | telegram
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                          -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- 개인 액세스 토큰과 연결 앱(CLI·MCP·WebDAV·텔레그램·확장) 토큰
CREATE TABLE IF NOT EXISTS personal_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '["files:read"]',
  app_id TEXT,                                  -- NULL = 개인 토큰, 그 외 연결 앱 ID
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

-- 내용 주소 기반 저장소: 같은 파일은 한 벌만 보관(중복 제거)
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,                        -- sha256 hex
  size INTEGER NOT NULL,
  mime TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT,                               -- NULL = 루트
  space TEXT NOT NULL DEFAULT 'drive',          -- drive | vault
  kind TEXT NOT NULL,                           -- folder | file
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  blob_hash TEXT REFERENCES blobs(hash),
  starred INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  trash_root INTEGER NOT NULL DEFAULT 0,        -- 휴지통에 직접 넣은 항목이면 1
  origin TEXT,                                  -- upload | cloud | share | telegram | onboarding | unzip
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_parent ON files(user_id, space, parent_id);
CREATE INDEX IF NOT EXISTS files_blob ON files(blob_hash);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  title_en TEXT,                                -- 영어 화면용(K-03). 없으면 title
  body_en TEXT
);

-- 앱 푸시 구독(K-05): 브라우저 Push API 구독 endpoint·keys 또는 앱 기기 토큰. 구독이 있는 사용자에게만 notify() 가 push 를 보낸다
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT,                                    -- JSON { p256dh, auth }
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id);

-- 개발 모드에서는 이메일·SMS·푸시가 실제로 나가지 않고 여기 쌓인다(/dev/outbox 에서 확인)
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                        -- email | sms | push | telegram
  to_addr TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocklist (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                           -- url | infohash | blob | domain
  value TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);

-- 전송 쿼터 사용량. period: 'm:2026-11' | 'd:2026-11-13', source: official | app
CREATE TABLE IF NOT EXISTS quota_usage (
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- cloud | down | up | cloud_count
  source TEXT NOT NULL DEFAULT 'official',
  amount INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period, kind, source)
);

-- 추가 쿼터(구매·추천 보상·가입 보너스). period_to 가 지나면 소멸
CREATE TABLE IF NOT EXISTS quota_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- cloud | down | up | cloud_count
  amount INTEGER NOT NULL,
  period TEXT,                                  -- 특정 월('m:2026-11')에만 유효하면 지정, NULL 이면 기간 내 상시
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
