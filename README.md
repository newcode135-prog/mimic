# 미믹 (Mimic)

> ## 🤖 미믹노트(팀원 체크인·미션·텔레그램 봇)는 별도 저장소로 옮겼습니다 — https://github.com/newcode135-prog/mimic-note
>
> 사용자가 Claude Code 에 `창민 https://github.com/newcode135-prog/mimic` 처럼 **팀원 이름 + 저장소 링크**를 보내면(이 저장소 주소든 `…/mimic-note` 든) 미믹노트 **접속 암호구**입니다. Claude Code 는:
>
> 1. **mimic-note** 저장소가 없으면 `git clone https://github.com/newcode135-prog/mimic-note.git` 후 그 폴더로 이동, 있으면 `git pull`
> 2. 그 저장소의 `CLAUDE.md` 0번 규칙대로 `node mimic-note/checkin.mjs <이름>` 실행 — 미션설정·추가·완료, 작업 기록, 게임, [로그아웃]도 전부 그 저장소에서
>
> 이 저장소의 `mimic-note/` 폴더는 옮기기 전 기록(보관용)입니다. 여기에는 미션을 더 올리지 않습니다. 이 저장소는 미믹 클라우드 서비스 개발용입니다.

외부 링크(마그넷·토렌트·HTTP URL·SNS 게시물)를 붙여넣으면 서버가 대신 내려받아 **사용자의 미믹 클라우드에만** 저장하고, 웹·앱에서 바로 재생·정리·공유하는 클라우드 드라이브 서비스입니다. PikPak의 기능 76개를 같은 규칙으로 구현하되, 로고·화면 디자인·문구·약관은 미믹 고유로 만듭니다. 첫 서버는 맥미니 1대입니다.

## 지금 상태 (2026-11-13)

| 구분 | 상태 |
| --- | --- |
| 기획 | 완료 — [`docs/MIMIC_PLAN.md`](docs/MIMIC_PLAN.md) |
| 기능 명세·라벨 데이터 | 완료 — [`docs/features.json`](docs/features.json) (기능 76 · 결정 9 · 작업 3) |
| 코드 | 코어 + 기능 모듈 9개 + 플랫폼(PWA·데스크톱·확장·CLI·텔레그램 봇) 모두 이 저장소에 있음 |
| 기능 76개 | **72개 완료 · 4개 부분**(휴대폰 앱 출시·코드 서명이 필요한 것 — 사유는 `features.json` 의 `note`) |
| 테스트 | `npm test` 275개 모두 통과 · 브라우저로 가입→업로드→재생→클라우드 다운로드→공유→테스트 결제→관리자 직접 확인 |
| 지금 받아서 실행하면 | 모든 화면이 동작. 결제는 개발 모드에서 테스트 결제(실제 돈 안 나감), 인증코드는 `/dev/outbox` 에서 확인 |
| 언어 | 한국어·영어(화면·도움말·FAQ·블로그·약관·알림·메일) |
| 결제 | 국내 원화 + 해외 달러(매일 환율), 토스페이먼츠 하나로 카드·간편결제·해외 카드·PayPal·Alipay |
| 서버 설치 | 맥미니 한 줄 설치: [`deploy/macmini/README.md`](deploy/macmini/README.md) |
| 데스크톱 설치 파일 | GitHub Actions → "Desktop build" 실행 → 결과물에서 내려받기(서명 전) |
| 운영 전 필요 | PG(토스) 키 · 소셜 로그인 키 · 문자/메일 업체 · 맥미니·도메인·HTTPS · 법무 검토 |

## 처음 오신 분 (사람·AI 공통)

1. [`docs/MIMIC_PLAN.md`](docs/MIMIC_PLAN.md)를 처음부터 읽습니다. 이 문서 하나에 배경·결정 사항·기능 명세·서버 구축 계획·작업 규칙이 모두 있습니다.
2. GitHub **Issues**에서 할 일을 고릅니다. 마일스톤 `0 준비` → `1 MVP` 순서로 진행합니다.
3. 결정이 필요한 항목(`decision` 라벨)은 임의로 정하지 말고 프로젝트 책임자에게 확인합니다.

## 라벨 체계

| 라벨 | 뜻 |
| --- | --- |
| `P0` · `P1` · `P2` | 우선순위: 출시 필수(28개) → 2차(36개) → 3차(12개) |
| `area:A` ~ `area:K` | 기능 영역: A 클라우드 다운로드 · B 드라이브 · C 재생 · D 공유 · E 금고 · F 전송 쿼터 · G 연동 · H 회원 · I 결제 · J 안전·법무 · K 운영 |
| `module:*` | 담당 코드 모듈(auth, drive, offline, media, share, vault, billing, integrations, admin-content, platforms, core, server-ops) |
| `feature` · `decision` · `task` | 기능 구현 · 사용자 결정 필요 · 기반·운영 작업 |
| `needs-verification` | PikPak 세부 동작을 아직 확인하지 못한 기능(5개: 미리보기·공유 업데이트·금고 용량·추천 보상 Pro·관리자 화면) |

이슈 제목의 `[A-01]` 같은 ID는 `docs/MIMIC_PLAN.md` 6장과 `docs/features.json`의 ID와 같습니다. 기능을 끝내면 `features.json`의 해당 `status`를 `done`으로 바꾸고 이슈를 닫습니다.

라벨·마일스톤·이슈는 `features.json`에서 자동으로 만듭니다. 새 기능을 추가하면 JSON에 넣고 다시 실행하세요(이미 있는 이슈는 건너뜁니다).

```bash
node scripts/github-setup.mjs newcode135-prog/mimic
```

## 기술 스택

Node.js 24 · Express 5 · SQLite(Node 내장 `node:sqlite`) · WebTorrent · ffmpeg · 빌드 도구 없는 순수 JavaScript 웹 화면. 이유와 전체 구조는 플랜 문서 10장에 있습니다.

## 개발 환경

```bash
# Node.js 24 이상, ffmpeg 필요
npm install
npm test                              # 전체 테스트
npm run seed -- <관리자 이메일>         # 첫 관리자 계정(없으면 만들고 임시 비밀번호를 한 번 보여 줌)
npm start                             # http://localhost:4300
```

실행 데이터(DB·파일 본문)는 환경변수 `MIMIC_DATA` 경로에 저장됩니다(기본 `~/.mimic`). 비밀값은 `.env`에만 두고 저장소에 올리지 않습니다.

## 폴더 구조

```
server/core/        공통 코어(설정·DB·인증·저장소·플랜·쿼터·알림)
server/modules/     기능 모듈(모듈마다 폴더 하나, 자기 파일만 수정)
web/                웹 화면
desktop/ extension/ cli/ tools/telegram-bot/   플랫폼·연동 (예정)
test/               테스트
docs/               플랜 문서, 기능 라벨 데이터
scripts/            GitHub 설정 스크립트
```

## 작업 규칙 (요약)

- PikPak의 로고·이미지·CSS·화면 문구·약관을 복사하지 않습니다. 기능·정책 수치·화면 구조만 같게 합니다.
- 외부 링크로 받은 파일은 요청한 사용자의 미믹 클라우드에만 저장합니다.
- 용량·쿼터·가격 같은 정책 수치는 `server/core/plans.js` 한곳에 모읍니다.
- 비밀번호·토큰은 해시로만 저장합니다. 개발 모드에서는 실제 이메일·SMS·결제를 보내지 않습니다.
- 모듈마다 `test/<모듈>.test.js` 테스트를 남깁니다.

전체 규칙은 플랜 문서 15장을 따릅니다.
