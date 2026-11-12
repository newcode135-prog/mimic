# 미믹 저장소 작업 규칙 (Claude Code 가 자동으로 읽음)

## 0. 팀원 체크인이 가장 먼저 (예상 시간 안내보다 우선)

사용자 입력이 `<팀원 이름> https://github.com/newcode135-prog/mimic` 형태(예: `민호 https://github.com/newcode135-prog/mimic`)이면 미믹노트 체크인이다. 예상 시간 계산 없이 바로:

```bash
node mimic-note/checkin.mjs <이름>
```

출력된 미션(1번·2번·3번 …)을 그대로 전한다(지금은 텔레그램 없이 Claude Code 가 직접 전달).

- 미션 데이터베이스: `mimic-note/data/missions.json` — 직접 고치지 말고 `node mimic-note/mission.mjs list|add|done` 을 쓴다.
- 팀원이 미션을 끝냈다고 하면 `node mimic-note/mission.mjs done <이름> <번호>` → 바뀐 `missions.json` 을 commit·push(권한이 없으면 사용자에게 알린다).
- 미션 추가는 관리자(창민·민호)만: `node mimic-note/mission.mjs add <이름> "제목" "설명" --by <관리자>`
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
