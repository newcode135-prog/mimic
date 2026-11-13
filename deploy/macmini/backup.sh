#!/bin/bash
# 미믹 매일 백업(launchd com.mimic.backup 가 04:30 에 실행. 직접: bash ~/mimic/deploy/macmini/backup.sh)
# - DB: 서버가 돌고 있어도 일관된 사본(VACUUM INTO) → <백업>/db/mimic-날짜.db, 최근 14개만 남김
# - 파일 본문(blobs)·vapid.json(웹 푸시 키)·.env → 백업 폴더로 복사
# 백업 폴더는 .env 의 MIMIC_BACKUP_DIR(또는 환경변수 BACKUP_DIR). 실패하면 0 이 아닌 값으로 끝난다.
set -Eeuo pipefail

KEEP=14

main() {
  local repo env_file data dest out
  repo=$(cd "$(dirname "$0")/../.." && pwd)
  env_file=$repo/.env
  envget() { sed -n "s/^$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/'; }
  [ -f "$env_file" ] || { echo "$(date '+%F %T') 백업 실패: $env_file 이 없습니다" >&2; exit 1; }
  for p in /opt/homebrew /usr/local; do if [ -x "$p/opt/node@24/bin/node" ]; then PATH=$p/opt/node@24/bin:$PATH; fi; done

  data=$(envget MIMIC_DATA) && data=${data:-$HOME/.mimic}
  dest=${BACKUP_DIR:-$(envget MIMIC_BACKUP_DIR)} && dest=${dest:-$HOME/mimic-backup}
  # 데이터 디스크가 빠져 있으면 빈 폴더를 백업으로 덮어쓰지 않게 먼저 멈춘다
  [ -f "$data/mimic.db" ] || { echo "$(date '+%F %T') 백업 실패: $data/mimic.db 가 없습니다(데이터 디스크 연결 확인)" >&2; exit 1; }
  trap 'echo "$(date "+%F %T") 백업 실패(줄 $LINENO)" >&2' ERR
  mkdir -p "$dest/db" "$dest/blobs" "$dest/config"

  out=$dest/db/mimic-$(date +%F).db
  rm -f "$out.part"
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 30000");
    db.prepare("VACUUM INTO ?").run(process.argv[2]);
    db.close();
    const r = new DatabaseSync(process.argv[2], { readOnly: true }).prepare("PRAGMA quick_check").get();
    if (r.quick_check !== "ok") throw new Error("사본 검사 실패: " + r.quick_check);
  ' "$data/mimic.db" "$out.part"
  mv -f "$out.part" "$out"
  # 날짜 이름이라 정렬하면 오래된 순. 최근 KEEP 개만 남긴다
  ls -1 "$dest"/db/mimic-*.db | sort -r | tail -n +$((KEEP + 1)) | while IFS= read -r f; do rm -f "$f"; done

  # 파일 본문은 내용 해시 이름이라 바뀌지 않는다. 더하기만 한다(지우지 않음):
  # 서버가 지운 본문도 남아 있어야 14일 전 DB 사본으로 되돌렸을 때 그 파일들이 열린다
  # ponytail: 백업 본문은 계속 늘어난다. 공간이 모자라면 남은 DB 사본 어디에도 없는 본문만 지우는 정리를 추가
  if [ -d "$data/blobs" ]; then rsync -a "$data/blobs/" "$dest/blobs/"; fi
  if [ -f "$data/vapid.json" ]; then cp -p "$data/vapid.json" "$dest/config/vapid.json"; fi
  install -m 600 "$env_file" "$dest/config/env"

  date '+%F %T' >"$dest/last-ok"
  echo "$(date '+%F %T') 백업 완료: $out ($(du -h "$out" | cut -f1)), 본문 $(du -sh "$dest/blobs" | cut -f1) → $dest"
}

main "$@"
exit
