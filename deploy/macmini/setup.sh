#!/bin/bash
# 미믹 맥미니 설치: 명령 하나로 운영 서버(HTTPS·부팅 때 자동 시작·죽으면 자동 재시작·매일 백업)를 만든다.
# 다시 실행해도 안전하다. 설치된 것은 건너뛰고, .env 는 처음 한 번만 만들며 절대 덮어쓰지 않는다.
#
# 처음(저장소 없이 터미널에 붙여넣기):
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/newcode135-prog/mimic/main/deploy/macmini/setup.sh)" setup \
#     --domain mimic.example.com --admin-email me@example.com \
#     --data-dir /Volumes/MimicData/mimic --backup-dir /Volumes/MimicBackup/mimic
# 다시: bash ~/mimic/deploy/macmini/setup.sh
#
# 옵션(같은 이름의 환경변수 DOMAIN·DATA_DIR·BACKUP_DIR·ADMIN_EMAIL·REPO_DIR 로도 줄 수 있음)
#   --domain       서비스 도메인(.env 를 처음 만들 때 필요)
#   --data-dir     DB·파일 본문 폴더. 외장 디스크 권장(기본 ~/mimic-data)
#   --backup-dir   매일 백업 폴더. 데이터와 다른 디스크(기본 ~/mimic-backup)
#   --admin-email  첫 관리자 계정(임시 비밀번호를 한 번만 보여 줌)
#   --repo-dir     저장소 위치(기본 ~/mimic)
set -euo pipefail

REPO_URL=https://github.com/newcode135-prog/mimic.git
DAEMONS=/Library/LaunchDaemons

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[중단] %s\n' "$*" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; } # sed 치환 값으로 넣을 때
envget() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/'; }
ask() { [ -t 0 ] || die "$2 값이 필요합니다(옵션으로 주세요)"; read -r -p "$2: " "$1"; }
find_brew() { for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do if [ -x "$b" ]; then echo "$b"; return; fi; done; }

# /api/config 가 200 이고 불러오지 못한 모듈이 없으면 정상
health() {
  local i out
  for i in $(seq 1 40); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1 &&
      out=$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null) && [[ $out == *'"failed":[]'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 템플릿(__이름__)을 채워 /Library/LaunchDaemons 에 넣고 다시 띄운다
install_daemon() {
  local label=$1 dst=$DAEMONS/$1.plist tmp i
  tmp=$(mktemp)
  sed -e "s|__USER__|$(esc "$USER_NAME")|g" -e "s|__HOME__|$(esc "$HOME")|g" -e "s|__REPO__|$(esc "$REPO_DIR")|g" \
    -e "s|__DATA__|$(esc "$DATA")|g" -e "s|__NODE__|$(esc "$NODE_DIR/node")|g" -e "s|__PATH__|$(esc "$SVC_PATH")|g" \
    -e "s|__CADDY__|$(esc "$PREFIX/bin/caddy")|g" -e "s|__CADDYFILE__|$(esc "$CADDYFILE")|g" -e "s|__PORT__|$(esc "$PORT")|g" \
    "$REPO_DIR/deploy/macmini/$label.plist" >"$tmp"
  plutil -lint "$tmp" >/dev/null
  sudo install -m 644 -o root -g wheel "$tmp" "$dst"
  rm -f "$tmp"
  sudo launchctl bootout "system/$label" 2>/dev/null || true
  # bootout 직후에는 정리가 덜 끝나 bootstrap 이 잠깐 실패할 수 있다
  for i in 1 2 3 4 5; do
    if sudo launchctl bootstrap system "$dst" 2>/dev/null; then echo "  $label 등록"; return 0; fi
    sleep 1
  done
  sudo launchctl bootstrap system "$dst"
}

write_env() {
  local admin_line="# MIMIC_ADMIN_EMAIL="
  [ -z "$ADMIN_EMAIL" ] || admin_line="MIMIC_ADMIN_EMAIL=$ADMIN_EMAIL"
  cat <<EOF
# 미믹 운영 설정(setup.sh 가 $(date +%F) 에 만듦). 저장소에 올리지 마세요(.gitignore 에 있음).
# 고친 뒤 서버 재시작: sudo launchctl kickstart -k system/com.mimic.server
NODE_ENV=production
MIMIC_BASE_URL=https://$DOMAIN
MIMIC_DATA=$DATA_DIR
MIMIC_BACKUP_DIR=$BACKUP_DIR
MIMIC_SECRET=$SECRET
YTDLP_PATH=$PREFIX/bin/yt-dlp
$admin_line
# 서버 포트(바꾸면 setup.sh 를 다시 실행해 Caddy·텔레그램 봇 설정도 맞추세요)
# PORT=4300

# ── 아래는 선택. 쓰려면 앞의 # 를 지우고 값을 넣으세요 ──
# 고객센터 메일(사이트에 공개됨)
# MIMIC_SUPPORT_EMAIL=
# 메일 발송 업체(인증코드·안내). 없으면 이메일 가입·로그인을 끝까지 할 수 없음
# MIMIC_EMAIL_API=
# MIMIC_EMAIL_API_KEY=
# MIMIC_EMAIL_FROM=
# 문자 발송 업체. 없으면 휴대폰 가입·로그인을 끝까지 할 수 없음
# MIMIC_SMS_API=
# MIMIC_SMS_API_KEY=
# MIMIC_SMS_FROM=
# 토스 결제(TOSS_API_BASE 는 보통 비워 둠)
# TOSS_CLIENT_KEY=
# TOSS_SECRET_KEY=
# TOSS_API_BASE=
# 해외(달러) 결제용 토스 달러 전용 상점 키, 환율을 받아 오지 못할 때 쓸 USD/KRW
# TOSS_CLIENT_KEY_USD=
# TOSS_SECRET_KEY_USD=
# MIMIC_FX_USD_KRW=
# 소셜 로그인
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# FACEBOOK_CLIENT_ID=
# FACEBOOK_CLIENT_SECRET=
# APPLE_CLIENT_ID=
# APPLE_TEAM_ID=
# APPLE_KEY_ID=
# APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# 텔레그램 봇(세 줄 모두 켠 뒤 setup.sh 를 다시 실행하면 봇 서비스가 설치됨. 비밀값은 미리 만들어 둠)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_BOT_USERNAME=
# MIMIC_BOT_SECRET=$BOT_SECRET
# 웹 푸시 키. 비워 두면 \$MIMIC_DATA/vapid.json 을 자동으로 만들어 씀(백업 대상)
# MIMIC_VAPID_PUBLIC_KEY=
# MIMIC_VAPID_PRIVATE_KEY=
# MIMIC_VAPID_SUBJECT=mailto:support@example.com
# 안드로이드 앱(TWA) 연결: 패키지 이름, 서명 SHA-256 지문(쉼표로 여러 개)
# MIMIC_ANDROID_PACKAGE=
# MIMIC_ANDROID_SHA256=
# 국가 헤더: 앞단 프록시(예: Cloudflare)가 직접 넣어 줄 때만. Caddy 만 쓰면 비워 두세요(사용자가 위조할 수 있음)
# MIMIC_COUNTRY_HEADER=cf-ipcountry
# 한도(결정 Q-5: 프리미엄은 PikPak 과 같이 10TB 표시. 기본 10240GB)
# MIMIC_PREMIUM_STORAGE_GB=10240
# MIMIC_VAULT_STORAGE_GB=100
# MIMIC_OFFLINE_MAX_RUNNING=10
# 디스크 경보(Q-5): 이 % 이상이면 관리자 경보 + 신규 가입 일시 중지, 아래 % 미만이면 자동 재개
# MIMIC_DISK_ALERT_PCT=80
# MIMIC_DISK_RESUME_PCT=75
# 시딩(Q-6): 업로드 속도 상한(KB/s, 0 = 제한 없음)과 동시에 시딩할 토렌트 수
# MIMIC_SEED_UPLOAD_KBPS=0
# MIMIC_SEED_MAX=200
# 서버가 받는 주소(기본 127.0.0.1 — 같은 맥의 Caddy 만 접속). 다른 구성일 때만 0.0.0.0
# MIMIC_HOST=127.0.0.1
# 비공개 베타: 설정하면 접속 키가 있어야 들어옴. 공유 링크는 https://<도메인>/?key=<키> (출시할 때는 지움)
# MIMIC_SITE_PASSWORD=
# 체험 서버 전용(개발 모드에서만 동작, 운영에서는 무시): 새 가입 인증코드를 화면에 보여 줌
# MIMIC_DEMO=
EOF
}

write_caddyfile() {
  local email
  email=$(envget MIMIC_ADMIN_EMAIL)
  email=${email:-$ADMIN_EMAIL}
  echo "# mimic setup.sh 가 만든 파일. 다시 실행하면 덮어씀"
  [ -z "$email" ] || printf '{\n\temail %s\n}\n' "$email"
  cat <<EOF
$HOST {
	# 업로드 크기 제한 없음(Caddy 기본값). 큰 파일 업로드 허용
	reverse_proxy 127.0.0.1:$PORT {
		# 영상 스트리밍: 응답을 모으지 않고 바로 흘려보낸다
		flush_interval -1
		# X-Forwarded-For: Caddy 기본값이 실제 접속 IP 로 채우고 사용자가 보낸 값은 버린다(trusted_proxies 없음).
		# 서버는 127.0.0.1 프록시만 믿으므로(trust proxy: loopback) 이 값으로 사용자 IP 를 안다
	}
}
EOF
}

main() {
  DOMAIN=${DOMAIN:-} DATA_DIR=${DATA_DIR:-} BACKUP_DIR=${BACKUP_DIR:-} ADMIN_EMAIL=${ADMIN_EMAIL:-} REPO_DIR=${REPO_DIR:-$HOME/mimic}
  while [ $# -gt 0 ]; do
    case $1 in
      --domain) DOMAIN=${2:?--domain 값이 없습니다}; shift 2 ;;
      --data-dir) DATA_DIR=${2:?--data-dir 값이 없습니다}; shift 2 ;;
      --backup-dir) BACKUP_DIR=${2:?--backup-dir 값이 없습니다}; shift 2 ;;
      --admin-email) ADMIN_EMAIL=${2:?--admin-email 값이 없습니다}; shift 2 ;;
      --repo-dir) REPO_DIR=${2:?--repo-dir 값이 없습니다}; shift 2 ;;
      *) die "모르는 옵션: $1" ;;
    esac
  done

  [ "$(uname -s)" = Darwin ] || die "macOS 에서만 실행합니다"
  [ "$(id -u)" -ne 0 ] || die "sudo 없이 실행하세요(필요한 단계에서만 스스로 sudo 를 묻습니다)"
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || say "주의: macOS $(sw_vers -productVersion). 14 이상에서 확인했습니다"
  USER_NAME=$(id -un)

  # 1. Homebrew
  BREW=$(find_brew)
  if [ -z "$BREW" ]; then
    say "Homebrew(맥용 프로그램 설치 도구)가 없어 공식 설치 스크립트로 설치합니다. 맥 로그인 비밀번호를 물을 수 있습니다"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    BREW=$(find_brew)
    [ -n "$BREW" ] || die "Homebrew 설치를 확인하지 못했습니다"
  fi
  eval "$("$BREW" shellenv)"
  PREFIX=$(brew --prefix)
  grep -qs 'brew shellenv' "$HOME/.zprofile" || echo "eval \"\$($BREW shellenv)\"" >>"$HOME/.zprofile"

  # 2. 프로그램
  say "필요한 프로그램 설치(node@24 ffmpeg yt-dlp caddy git)"
  for f in node@24 ffmpeg yt-dlp caddy git; do
    if brew list --formula "$f" >/dev/null 2>&1; then echo "  $f: 이미 있음"; else brew install "$f"; fi
  done
  NODE_DIR=$PREFIX/opt/node@24/bin
  export PATH="$NODE_DIR:$PATH"
  grep -qs 'opt/node@24/bin' "$HOME/.zprofile" || echo "export PATH=\"$NODE_DIR:\$PATH\"" >>"$HOME/.zprofile"
  node -v | grep -q '^v24\.' || die "Node 24 를 찾지 못했습니다: $(command -v node)"
  SVC_PATH="$NODE_DIR:$PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  # 3. 코드(처음에만 받는다. 새 코드는 되돌림 기능이 있는 update.sh 로)
  if [ -d "$REPO_DIR/.git" ]; then
    say "미믹 코드가 이미 있어 그대로 둡니다: $REPO_DIR (새 코드 받기: bash $REPO_DIR/deploy/macmini/update.sh)"
  else
    say "미믹 코드 받기: $REPO_DIR"
    git clone "$REPO_URL" "$REPO_DIR"
  fi
  cd "$REPO_DIR"
  npm ci --omit=dev # 같은 커밋이면 같은 결과. 앞서 설치가 끊겼어도 여기서 다시 맞춘다

  # 4. .env(처음 한 번만)
  ENV_FILE=$REPO_DIR/.env
  if [ -f "$ENV_FILE" ]; then
    say ".env 가 이미 있어 그대로 둡니다(값을 바꾸려면 $ENV_FILE 을 직접 고치세요)"
  else
    [ -n "$DOMAIN" ] || ask DOMAIN "서비스 도메인(예: mimic.example.com)"
    if [ -z "$ADMIN_EMAIL" ] && [ -t 0 ]; then read -r -p "첫 관리자 이메일(건너뛰려면 Enter): " ADMIN_EMAIL; fi
    DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')
    local re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$' ere='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    [[ $DOMAIN =~ $re ]] || die "도메인 형식이 아닙니다: $DOMAIN"
    [ -z "$ADMIN_EMAIL" ] || [[ $ADMIN_EMAIL =~ $ere ]] || die "이메일 형식이 아닙니다: $ADMIN_EMAIL"
    DATA_DIR=${DATA_DIR:-$HOME/mimic-data}
    BACKUP_DIR=${BACKUP_DIR:-$HOME/mimic-backup}
    case $DATA_DIR in /*) ;; *) die "--data-dir 는 / 로 시작하는 전체 경로여야 합니다" ;; esac
    case $BACKUP_DIR in /*) ;; *) die "--backup-dir 는 / 로 시작하는 전체 경로여야 합니다" ;; esac
    SECRET=$(openssl rand -hex 32)
    BOT_SECRET=$(openssl rand -hex 32)
    [ ${#SECRET} -ge 48 ] || die "비밀값을 만들지 못했습니다(openssl)"
    say ".env 만들기(권한 600, 비밀값 자동 생성)"
    (umask 077 && write_env >"$ENV_FILE")
  fi
  chmod 600 "$ENV_FILE"

  # 이후는 .env 값이 기준(옵션과 다르면 알려 준다)
  local url
  url=$(envget MIMIC_BASE_URL)
  HOST=${url#*://} && HOST=${HOST%%/*}
  DATA=$(envget MIMIC_DATA) && DATA=${DATA:-$HOME/.mimic}
  BACKUP=$(envget MIMIC_BACKUP_DIR) && BACKUP=${BACKUP:-$HOME/mimic-backup}
  PORT=$(envget PORT) && PORT=${PORT:-4300}
  [ -n "$HOST" ] || die ".env 에 MIMIC_BASE_URL 이 없습니다"
  [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$HOST" ] || say "주의: --domain($DOMAIN)이 .env 의 MIMIC_BASE_URL($url)과 다릅니다. .env 값을 씁니다"
  [ -z "$DATA_DIR" ] || [ "$DATA_DIR" = "$DATA" ] || say "주의: --data-dir($DATA_DIR)이 .env 의 MIMIC_DATA($DATA)와 다릅니다. .env 값을 씁니다"
  mkdir -p "$DATA/logs" "$BACKUP" || die "폴더를 만들 수 없습니다: $DATA, $BACKUP (외장 디스크가 연결됐는지 확인)"
  if [ "$(df -P "$DATA" | awk 'NR==2{print $1}')" = "$(df -P "$BACKUP" | awk 'NR==2{print $1}')" ]; then
    say "주의: 백업 폴더($BACKUP)가 데이터와 같은 디스크입니다. 디스크가 고장 나면 백업도 잃습니다(.env 의 MIMIC_BACKUP_DIR 을 다른 디스크로)"
  fi

  # 5. 관리자 권한이 꼭 필요한 단계
  say "관리자 권한(sudo)이 필요합니다: 로그인하지 않아도 부팅 때 켜지는 시스템 서비스 등록(/Library/LaunchDaemons), 잠자기 끄기·정전 뒤 자동 켜기(pmset). 맥 로그인 비밀번호를 입력하세요"
  sudo -v
  sudo pmset -a sleep 0 disksleep 0 autorestart 1
  case "$DATA $BACKUP" in
    */Volumes/*)
      say "외장 디스크가 로그인 전에도 연결되게 합니다(시스템 설정이라 sudo)"
      sudo defaults write /Library/Preferences/SystemConfiguration/autodiskmount AutomountDisksWithoutUserLogin -bool true
      ;;
  esac

  # 6. 첫 관리자(npm run seed 는 .env 를 읽지 않으므로 같은 스크립트를 --env-file 로 실행)
  if [ -n "$ADMIN_EMAIL" ]; then
    say "관리자 계정: $ADMIN_EMAIL (새로 만들면 임시 비밀번호가 지금 한 번만 표시됩니다. 적어 두세요)"
    node --env-file="$ENV_FILE" server/seed.js "$ADMIN_EMAIL"
  fi

  # 7. Caddy(HTTPS)
  CADDYFILE=$PREFIX/etc/Caddyfile
  if [ -f "$CADDYFILE" ] && ! grep -q 'mimic setup.sh' "$CADDYFILE"; then
    cp "$CADDYFILE" "$CADDYFILE.bak"
    say "원래 있던 Caddyfile 을 $CADDYFILE.bak 으로 남겼습니다"
  fi
  write_caddyfile >"$CADDYFILE"
  caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || die "Caddyfile 검사 실패: caddy validate --config $CADDYFILE --adapter caddyfile"
  brew services stop caddy >/dev/null 2>&1 || true # brew 서비스로 따로 떠 있으면 포트가 겹친다

  # 8. 서비스 등록
  say "서비스 등록(서버·HTTPS·매일 04:30 백업)"
  install_daemon com.mimic.server
  install_daemon com.mimic.caddy
  install_daemon com.mimic.backup
  if [ -n "$(envget TELEGRAM_BOT_TOKEN)" ] && [ -n "$(envget MIMIC_BOT_SECRET)" ]; then
    install_daemon com.mimic.telegram
  elif [ -f "$DAEMONS/com.mimic.telegram.plist" ]; then
    sudo launchctl bootout system/com.mimic.telegram 2>/dev/null || true
    sudo rm -f "$DAEMONS/com.mimic.telegram.plist"
    echo "  com.mimic.telegram 해제(.env 에 토큰이 없음)"
  fi

  # 9. 확인
  say "서버 응답 확인: http://127.0.0.1:$PORT/api/config"
  if ! health; then
    tail -n 30 "$DATA/logs/server.err.log" 2>/dev/null || true
    die "서버가 응답하지 않습니다. 로그: $DATA/logs/server.err.log"
  fi
  echo "  정상"

  local lan
  lan=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '맥미니 내부 IP')
  cat <<EOF

설치 완료. 남은 일(직접):
 1. 도메인 DNS: $HOST 의 A 레코드를 공유기의 공인 IP 로(공유기 관리 화면에서 확인). 고정 IP 가 아니면 DDNS 를 쓰세요
 2. 공유기 포트 포워딩: TCP 80·443 → $lan (4300 은 열지 마세요)
 3. 몇 분 뒤 https://$HOST 접속. 인증서는 Caddy 가 자동 발급(안 되면 $DATA/logs/caddy.log)
 4. 전원 설정 확인: pmset -g | grep -E 'sleep|autorestart'   (sleep 0, autorestart 1 이면 정상)
 5. 결제·소셜 로그인·메일·문자 키: $ENV_FILE 의 주석 줄을 채운 뒤 sudo launchctl kickstart -k system/com.mimic.server
 6. 점검: bash $REPO_DIR/deploy/macmini/check.sh    업데이트: bash $REPO_DIR/deploy/macmini/update.sh
EOF
  if fdesetup status 2>/dev/null | grep -q 'On'; then
    echo " 주의: FileVault 가 켜져 있어 정전·재부팅 뒤 누군가 잠금을 풀기 전까지 서비스가 뜨지 않습니다"
  fi
}

# 함수로 감싸 끝까지 읽은 뒤 실행한다(git pull 로 이 파일이 바뀌어도 안전)
main "$@"
exit
