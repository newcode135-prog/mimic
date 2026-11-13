#!/bin/bash
# 미믹 업데이트: 새 코드 받기 → 의존성 설치 → 서버 재시작 → 응답 확인. 확인에 실패하면 이전 커밋으로 되돌린다.
# 실행: bash ~/mimic/deploy/macmini/update.sh
# (운영에는 개발용 패키지가 없어 테스트는 돌리지 않는다. 테스트는 개발 PC 에서 npm test)
# 배포 설정(plist·Caddyfile)이 바뀐 업데이트라면 끝난 뒤 setup.sh 를 한 번 더 실행하세요.
set -euo pipefail

main() {
  local repo prev new port
  repo=$(cd "$(dirname "$0")/../.." && pwd)
  cd "$repo"
  for p in /opt/homebrew /usr/local; do if [ -x "$p/opt/node@24/bin/node" ]; then PATH=$p/opt/node@24/bin:$p/bin:$PATH; fi; done
  port=$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -n 1) && port=${port:-4300}

  health() {
    local i out
    for i in $(seq 1 40); do
      if curl -fsS --max-time 3 "http://127.0.0.1:$port/api/config" >/dev/null 2>&1 &&
        out=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/health" 2>/dev/null) && [[ $out == *'"failed":[]'* ]]; then
        return 0
      fi
      sleep 1
    done
    return 1
  }
  restart() {
    sudo launchctl kickstart -k system/com.mimic.server
    if [ -f /Library/LaunchDaemons/com.mimic.telegram.plist ]; then sudo launchctl kickstart -k system/com.mimic.telegram; fi
    sleep 2 # 끝나 가는 이전 프로세스가 대신 응답하지 않게
  }
  # 코드와 의존성을 이전 커밋으로 되돌리고 다시 시작한다. 항상 1 로 끝난다
  rollback() {
    echo "$1 이전 커밋 ${prev:0:7} 로 되돌립니다" >&2
    git reset --hard "$prev"
    npm ci --omit=dev || { echo "되돌린 버전의 의존성 설치도 실패했습니다. 네트워크를 확인한 뒤 update.sh 를 다시 실행하세요" >&2; exit 1; }
    restart
    if health; then echo "되돌림 완료. 서버는 이전 버전으로 동작 중입니다" >&2; else echo "되돌린 뒤에도 응답이 없습니다. 로그를 확인하세요(check.sh)" >&2; fi
    exit 1
  }

  # 되돌릴 때 git reset --hard 를 쓰므로, 손으로 고친 파일이 있으면 시작하지 않는다
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { git status --short; echo "고친 파일이 있어 멈춥니다. 정리한 뒤 다시 실행하세요" >&2; exit 1; }
  prev=$(git rev-parse HEAD)
  git pull --ff-only
  new=$(git rev-parse HEAD)
  if [ "$prev" = "$new" ]; then echo "이미 최신입니다($(git log -1 --format='%h %s'))"; exit 0; fi
  git log --oneline "$prev..$new"
  # npm ci 는 node_modules 를 먼저 지운다. 실패한 채 두면 다음 재시작에서 서버가 뜨지 못한다
  npm ci --omit=dev || rollback "의존성 설치(npm ci)에 실패해"

  echo "서버를 다시 시작합니다(시스템 서비스라 sudo 가 필요합니다)"
  restart
  if health; then echo "업데이트 완료: $(git log -1 --format='%h %s')"; exit 0; fi
  rollback "새 버전이 응답하지 않아"
}

# 함수로 감싸 끝까지 읽은 뒤 실행한다(git pull 로 이 파일이 바뀌어도 안전)
main "$@"
exit
