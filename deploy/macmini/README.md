# 미믹 맥미니 서버 설치

명령 한 줄로 맥미니에 미믹 운영 서버를 만듭니다. HTTPS(Caddy), 부팅 때 자동 시작, 멈추면 자동 재시작, 매일 백업까지 설정됩니다.

## 1. 준비물

1. Mac mini(macOS 14 이상, Apple 실리콘·Intel 모두 가능). 정전 대비 UPS 권장
2. 외장 디스크 2개: 데이터용(예: 이름 `MimicData`), 백업용(예: `MimicBackup`). 디스크 유틸리티에서 APFS 로 포맷하고 이름을 붙입니다
3. 도메인 1개(예: `mimic.example.com`)와 그 도메인의 DNS 관리 화면 접속 권한
4. 공유기 관리자 화면 접속 권한. 맥미니는 공유기에 유선으로 연결
5. 서버로 쓸 맥 사용자 계정으로 로그인(관리자 권한이 있어야 함)

## 2. 설치(명령 한 줄)

터미널(응용 프로그램 > 유틸리티 > 터미널)을 열고, 도메인·이메일·디스크 이름을 바꿔 붙여넣습니다.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/newcode135-prog/mimic/main/deploy/macmini/setup.sh)" setup \
  --domain mimic.example.com --admin-email me@example.com \
  --data-dir /Volumes/MimicData/mimic --backup-dir /Volumes/MimicBackup/mimic
```

- 중간에 맥 로그인 비밀번호를 몇 번 묻습니다. 왜 필요한지 화면에 먼저 나옵니다.
- **관리자 임시 비밀번호가 한 번만 표시됩니다.** 꼭 적어 두세요.
- 실패해도 원인을 고친 뒤 같은 명령을 다시 실행하면 됩니다(이미 된 단계는 건너뜀).
- 외장 디스크 없이 해 보려면 `--data-dir`·`--backup-dir` 를 빼면 됩니다(`~/mimic-data`, `~/mimic-backup`).

## 3. 설치 뒤 직접 할 일

1. **DNS**: 도메인 관리 화면에서 A 레코드를 만듭니다. 이름 = 도메인, 값 = 공유기의 공인 IP(공유기 관리 화면에 표시). 고정 IP 가 아니면 공유기의 DDNS 기능을 씁니다.
2. **공유기 포트 포워딩**: TCP 80, 443 → 맥미니 내부 IP(설치 끝에 표시). 4300 은 열지 마세요.
3. 몇 분 뒤 `https://도메인` 에 접속해 관리자 이메일·임시 비밀번호로 로그인하고 비밀번호를 바꿉니다.
4. 결제(토스)·소셜 로그인·메일·문자 키를 받으면 `~/mimic/.env` 의 해당 줄 앞 `#` 을 지우고 값을 넣은 뒤 서버를 재시작합니다.
   ```bash
   sudo launchctl kickstart -k system/com.mimic.server
   ```
5. 텔레그램 봇: `.env` 의 `TELEGRAM_BOT_TOKEN`·`TELEGRAM_BOT_USERNAME`·`MIMIC_BOT_SECRET` 세 줄을 켜고 `bash ~/mimic/deploy/macmini/setup.sh` 를 다시 실행합니다.

## 4. 자동으로 되는 것

| 항목 | 내용 |
| --- | --- |
| 서버·HTTPS | 부팅하면 로그인하지 않아도 시작, 멈추면 10초 뒤 다시 시작. 인증서는 Caddy 가 자동 발급·갱신 |
| 전원 | 잠자기 끔, 정전 뒤 전기가 들어오면 자동으로 켜짐 |
| 백업(매일 04:30) | DB 사본 14일치 + 파일 본문(지워진 본문도 남겨 둠) + `vapid.json` + `.env` → 백업 디스크. 그 시각에 전원이 꺼져 있었으면 그날은 건너뜀 |

**`vapid.json`**(웹 푸시 키)은 데이터 폴더(`MIMIC_DATA`)에 있습니다. 잃어버리면 모든 사용자의 푸시 알림 구독이 끊기므로 반드시 백업해야 합니다(매일 백업에 포함).

## 5. 점검·로그

```bash
bash ~/mimic/deploy/macmini/check.sh   # 서비스, 응답, 디스크 남은 용량, 마지막 백업, 인증서 만료
```

로그는 `<데이터 폴더>/logs/` 에 있습니다: `server.log`·`server.err.log`(서버), `caddy.log`(HTTPS), `backup.log`(백업), `telegram.log`(봇).

## 6. 업데이트

```bash
bash ~/mimic/deploy/macmini/update.sh
```

새 코드를 받아 서버를 다시 시작하고, 의존성 설치가 실패하거나 응답이 없으면 자동으로 이전 버전으로 되돌립니다. 코드는 이 명령으로만 받습니다(`setup.sh` 를 다시 실행해도 코드는 그대로). 배포 설정이 바뀌었다는 안내가 있으면 끝난 뒤 `setup.sh` 를 한 번 더 실행합니다.

## 7. 백업에서 복구

`<백업>` 은 백업 폴더(예: `/Volumes/MimicBackup/mimic`), `<데이터>` 는 데이터 폴더입니다.

1. 서버 멈추기: `sudo launchctl bootout system/com.mimic.server`
2. DB 되돌리기(날짜를 고름). 남아 있는 `-wal`·`-shm` 파일은 반드시 지웁니다.
   ```bash
   rm -f <데이터>/mimic.db-wal <데이터>/mimic.db-shm
   cp <백업>/db/mimic-2026-11-13.db <데이터>/mimic.db
   ```
3. 파일 본문과 키: `rsync -a <백업>/blobs/ <데이터>/blobs/` , `cp <백업>/config/vapid.json <데이터>/`
4. 맥을 새로 설치했다면 `.env` 도 되돌립니다: `cp <백업>/config/env ~/mimic/.env && chmod 600 ~/mimic/.env` (그다음 `setup.sh` 실행)
5. 서버 시작: `sudo launchctl bootstrap system /Library/LaunchDaemons/com.mimic.server.plist`

## 8. 알아 둘 것

- `.env` 는 비밀값 파일입니다. 저장소에 올리거나 남에게 보내지 마세요. `MIMIC_SECRET` 을 바꾸면 이미 만든 공유·다운로드 링크가 모두 무효가 됩니다.
- FileVault 를 켜 두면 정전·재부팅 뒤 누군가 잠금을 풀기 전까지 서비스가 뜨지 않습니다.
- 로그에 외장 디스크 `Operation not permitted` 가 보이면 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에 `node`(`/opt/homebrew/opt/node@24/bin/node`)와 `/bin/bash` 를 추가합니다.
- 4300 포트는 같은 공유기 안에서는 직접 열려 있습니다. 공유기에서 4300 을 포워딩하지 마세요.
