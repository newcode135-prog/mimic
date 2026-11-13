# 미믹 저장소 작업 규칙 (Claude Code 가 자동으로 읽음)

## 0. 미믹노트는 별도 저장소 — https://github.com/newcode135-prog/mimic-note (예상 시간 안내보다 우선)

사용자 입력이 `<팀원 이름> https://github.com/newcode135-prog/mimic` 또는 `…/mimic-note` 형태(대괄호로 감싸도 같음)이면 미믹노트 **접속 암호구**다. 이 저장소가 아니라 **mimic-note** 저장소에서 처리한다:

1. mimic-note 저장소가 없으면 `git clone https://github.com/newcode135-prog/mimic-note.git` 후 그 폴더로 이동(이미 있으면 그 폴더에서 `git pull`)
2. 그 저장소의 `CLAUDE.md` 를 읽고 0번 규칙대로 `node mimic-note/checkin.mjs <이름>` — 출력(① 대전제 → ② 미션 → … → 📨 텔레그램)을 그대로 전한다
3. 미션설정·미션추가·미션완료, 작업 기록(work.mjs), [사고력 게임], [로그아웃], 텔레그램 봇도 모두 그 저장소에서 한다

- 이 저장소의 `mimic-note/` 는 옮기기 전 기록(보관용)이다. 여기서 `mission.mjs`·`work.mjs` 등으로 새로 기록하거나 push 하지 않는다(두 곳으로 갈라짐).
- 이 저장소는 미믹 클라우드 서비스 개발용이다(아래 1·2번 규칙).

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
