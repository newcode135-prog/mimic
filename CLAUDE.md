# 미믹 저장소 작업 규칙 (Claude Code 가 자동으로 읽음)

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
