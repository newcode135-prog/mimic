# 미믹 저장소 작업 규칙 (Claude Code 가 자동으로 읽음)

## 0. 접속 암호구 → 대전제 → 미션 (예상 시간 안내보다 우선)

사용자 입력이 `<팀원 이름> https://github.com/newcode135-prog/mimic` 형태(예: `창민 https://…/mimic`, `lucas https://…/mimic`, 대괄호로 감싸도 같음)이면 미믹노트 **접속 암호구**다. 예상 시간 계산 없이 바로:

```bash
node mimic-note/checkin.mjs <이름>
```

출력된 **① 대전제**(`mimic-note/premise.md`)를 먼저, **② 그 팀원의 미션**(1번·2번·3번 …)을 그다음에 그대로 전하고, 그 세션 동안 대전제를 따른다. 미션이 0개면 "관리자가 등록하면 다시 체크인"이라고 안내한다. 맨 끝의 `📨 텔레그램` 줄(GitHub Actions 의 실제 발송 결과)도 그대로 전한다 — "요청함"을 "보냄"이라고 바꿔 말하지 않는다.

### 0-1. 미션 명령 (대표·관리자가 자연어로 입력 → 그대로 실행, JSON 직접 수정·Actions 버튼 금지)

| 사용자 입력 | 실행 |
| --- | --- |
| `민호 미션설정` + 줄마다 `1. 업무 A` … | `node mimic-note/mission.mjs set 민호 <<'EOF'` → 입력한 목록 줄을 그대로 → `EOF` |
| `민호 미션추가` + `4. 업무 D` … | `node mimic-note/mission.mjs add 민호 <<'EOF'` → 목록 → `EOF` (`최우선`이라고 하면 `--top`) |
| `민호 미션완료 2` (여러 개: `2 3`) | `node mimic-note/mission.mjs done 민호 2` |
| `민호 https://github.com/newcode135-prog/mimic` | 위 체크인(`node mimic-note/checkin.mjs 민호`) |
| `미믹 전체미션` | `git pull` 후 `node mimic-note/mission.mjs all` |
| `텔레그램 연결` | 사용자에게 **본인 터미널에서** `node mimic-note/telegram.mjs connect` 를 실행하라고 안내(토큰을 대화에 붙여 넣게 하지 않는다) |

- 이 명령들은 GitHub main 에 **바로 저장**(커밋)하고, GitHub Actions 가 미션이 바뀐 팀원에게만 텔레그램을 보낸 뒤 결과를 출력한다. 따로 commit·push 하지 않는다. 출력(커밋 링크·남은 미션·텔레그램 결과)을 그대로 전한다.
- 누가 바꾸는지는 이 컴퓨터의 `gh` 로그인 계정 ↔ `members.json` 의 `github` 로 확인한다(`--by` 는 쓰지 않음). 거절되면 그 문구를 그대로 전하고, 권한을 우회하지 않는다.
- 대전제는 대표관리자(창민)만 고친다. 버전·날짜를 올린다.
- 미션 데이터베이스: `mimic-note/data/missions.json` — 직접 고치지 말고 위 명령을 쓴다(`list` 로 보기).
- 팀원이 미션을 끝냈다고 하면 `node mimic-note/mission.mjs done <이름> <번호>` (본인 미션 또는 관리자만).
- 플레이어가 [데이터 라벨링]·[데이터 압축]·[데이터 업로드]를 했다고 하면 `node mimic-note/work.mjs <이름> <라벨링|압축|업로드> <대상> <시작|완료>` → 그 사람 폴더(`data/players/<아이디>/`)만 commit·push. 남의 폴더와 `data/auto/` 는 손대지 않는다.
- `data/auto/todos.json` 은 패시브 스킬 [자동 다운로드](`mimic-note/passive/`)만 쓴다.
- [사고력 게임]: 체크인 ④에 마지막 게임이 나온다. 플레이어가 답하면 `node mimic-note/game.mjs <이름> answer "<답>"` → commit·push. 출제자 답은 봉인돼 있으며, 공개용 소금은 출제한 컴퓨터에만 있다(저장소에 올리지 않는다).
- **액티브 스킬 [로그아웃]**: 사용자가 `[로그아웃]` 이라고 하면 ① `node mimic-note/logout.mjs <이름>` → 패시브 스킬 [1차 압축]이 미리 채운 최종본이 나온다 → ② 그 파일의 라벨·결정·다음만 고친다(형식 upload-v1: 라벨 1~6줄 · 결정 3~10줄 · 다음 1~3줄 · 400~3000자, 비밀 금지) → ③ `node mimic-note/logout.mjs <이름> --upload "<파일>"` 한 번으로 검사·저장·작업 기록·commit·push. 목표 15초: 대화를 처음부터 다시 읽지 말고 초안만 본다.
- 패시브 스킬 [1차 압축](`mimic-note/passive/compress.mjs`, 10초마다)은 이 컴퓨터의 `~/.mimic-note/drafts/` 에만 쌓는다. 설치: `bash mimic-note/passive/install-compress.sh`
- 미션 만들기·정하기·후순위는 관리자(창민·민호·유리)만: 한 개는 `node mimic-note/mission.mjs add <이름> "제목" "설명"`
- 팀원 명부·진행 기록은 `mimic-note/README.md`(미믹노트, 중앙 컴퓨터). 토큰·chat id 는 파일에 쓰지 않는다(공개 저장소).

## 1. 작업 전에 예상 시간부터 보여 준다 (항상)

이 저장소에서 기능 추가·수정·버그 수정·GitHub 이슈 작업을 요청받으면, **코드를 읽거나 고치기 전에** 먼저 예상 소요 시간을 계산해 사용자에게 가장 먼저 보여 준다. 확인을 기다리지 말고 바로 이어서 작업한다. 절차는 `.claude/skills/mimic-eta/SKILL.md`.

```bash
node scripts/eta.mjs --text "<요청 원문>"     # 요청 문장에서 기능을 찾아 계산
node scripts/eta.mjs B-02 D-05               # 기능 ID 를 알면
node scripts/eta.mjs --project               # 프로젝트 남은 작업
```

작업이 끝나면 실제로 걸린 시간을 `docs/estimates.json` 의 `history` 에 한 줄 추가한다(다음 예측이 더 정확해진다).

## 2. 그 밖의 규칙

- 기획·기능 명세: `docs/MIMIC_PLAN.md`, 기능 목록·라벨: `docs/features.json`
- 개발 규약(파일 담당, 코어 API, 화면 규약): `docs/BUILD_SPEC.md`
- PikPak 의 로고·이미지·CSS·문구·약관을 복사하지 않는다. 기능·수치·흐름만 같게, 보이는 것은 미믹 고유로.
- 바꾼 뒤에는 `npm test` 가 모두 통과해야 한다.
