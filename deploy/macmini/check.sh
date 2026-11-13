#!/bin/bash
# 미믹 상태 점검: 서비스·서버 응답·디스크 남은 용량·마지막 백업·인증서 만료. 문제가 있으면 1 로 끝난다.
# 실행: bash ~/mimic/deploy/macmini/check.sh
set -uo pipefail

main() {
  local repo env_file data dest url host port bad=0 l st free age end
  repo=$(cd "$(dirname "$0")/../.." && pwd)
  env_file=$repo/.env
  envget() { sed -n "s/^$1=//p" "$env_file" 2>/dev/null | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/'; }
  ok() { echo "  [정상] $*"; }
  problem() { echo "  [문제] $*"; bad=$((bad + 1)); }
  data=$(envget MIMIC_DATA) && data=${data:-$HOME/.mimic}
  dest=$(envget MIMIC_BACKUP_DIR) && dest=${dest:-$HOME/mimic-backup}
  url=$(envget MIMIC_BASE_URL) && host=${url#*://} && host=${host%%/*}
  port=$(envget PORT) && port=${port:-4300}

  echo "1) 서비스"
  for l in com.mimic.server com.mimic.caddy com.mimic.backup com.mimic.telegram; do
    if [ ! -f "/Library/LaunchDaemons/$l.plist" ]; then
      [ $l = com.mimic.telegram ] || problem "$l 가 설치되지 않았습니다(setup.sh 실행)"
      continue
    fi
    st=$(launchctl print "system/$l" 2>/dev/null | grep -m1 -E '^[[:space:]]*state = ' | sed 's/.*= //')
    if [ $l = com.mimic.backup ]; then
      ok "$l 등록됨(매일 04:30)"
    elif [ "$st" = running ]; then
      ok "$l 실행 중"
    else
      problem "$l 상태: ${st:-알 수 없음} (로그: $data/logs/)"
    fi
  done

  echo "2) 서버 응답"
  if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/config" >/dev/null 2>&1; then ok "http://127.0.0.1:$port/api/config"; else problem "서버가 응답하지 않습니다(로그: $data/logs/server.err.log)"; fi
  if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"failed":\[[^]]'; then problem "불러오지 못한 모듈이 있습니다: curl http://127.0.0.1:$port/api/health"; fi

  echo "3) 디스크 남은 용량(15% 미만이면 문제)"
  for d in "$data" "$dest"; do
    free=$(df -Pk "$d" 2>/dev/null | awk 'NR==2{print int($4*100/$2)}')
    if [ -z "$free" ]; then problem "$d 를 찾을 수 없습니다(디스크 연결 확인)"; elif [ "$free" -lt 15 ]; then problem "$d 남은 용량 $free%"; else ok "$d 남은 용량 $free%"; fi
  done

  echo "4) 마지막 백업(26시간 넘으면 문제)"
  if [ -f "$dest/last-ok" ]; then
    age=$((($(date +%s) - $(stat -f %m "$dest/last-ok")) / 3600))
    if [ "$age" -gt 26 ]; then problem "마지막 성공 $(cat "$dest/last-ok") ($age시간 전, 로그: $data/logs/backup.log)"; else ok "마지막 성공 $(cat "$dest/last-ok")"; fi
  else
    problem "아직 성공한 백업이 없습니다(직접 실행: bash $repo/deploy/macmini/backup.sh)"
  fi

  echo "5) HTTPS 인증서($host, 14일 안에 만료되면 문제)"
  # 공유기가 내부에서 자기 공인 IP 로 돌아오는 연결을 막을 수 있어 이 맥의 Caddy 에 바로 묻는다
  end=$(echo | openssl s_client -servername "$host" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -z "$end" ]; then
    problem "인증서를 읽지 못했습니다(DNS·포트 포워딩 확인, 로그: $data/logs/caddy.log)"
  elif echo | openssl s_client -servername "$host" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then
    ok "만료일 $end (Caddy 가 자동 갱신)"
  else
    problem "곧 만료: $end"
  fi

  echo
  if [ $bad -eq 0 ]; then echo "모두 정상"; else echo "문제 $bad개"; fi
  [ $bad -eq 0 ]
}

main "$@"
