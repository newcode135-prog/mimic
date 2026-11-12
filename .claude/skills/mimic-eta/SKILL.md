---
name: mimic-eta
description: 미믹(Mimic) 저장소에서 기능 추가·수정·버그 수정·GitHub 이슈 작업·"얼마나 걸려?" 질문을 받으면 작업을 시작하기 전에 항상 먼저 실행해 예상 소요 시간 표를 보여 준다. Use before starting any change, fix, feature, or issue work in this repository, and whenever someone asks how long something will take.
---

# 미믹 예상 시간 안내

목적: 누가 이 저장소를 이어받아 무엇을 고치든, 시작하기 전에 예상 시간이 바로 보이게 한다.

## 절차

1. 요청에서 대상을 찾는다.
   - 기능 ID(A-01 ~ K-09)가 있으면 그대로 쓴다.
   - GitHub 이슈 번호면 `gh issue view <번호> --repo newcode135-prog/mimic --json title,body` 로 제목의 `[ID]` 를 읽는다.
   - 둘 다 없으면 요청 원문을 그대로 쓴다.
2. 계산기를 실행한다.
   ```bash
   node scripts/eta.mjs <ID들>            # 예: node scripts/eta.mjs B-02 D-05
   node scripts/eta.mjs --text "<요청 원문>"
   ```
3. 출력 첫 줄("예상 소요 시간: …")과 표를 **사용자에게 가장 먼저** 보여 준다. 계산기가 "추정한 기능"이라고 하면 그 목록도 같이 보여 준다. 확인을 기다리지 말고 바로 작업을 시작한다.
4. 시작 시각을 기억해 두었다가, 작업과 `npm test` 가 끝나면 실제 걸린 분을 `docs/estimates.json` 의 `history` 배열에 추가한다.
   ```json
   { "date": "2026-11-14", "ids": ["B-02"], "module": "drive", "features": 1, "minutes": 18, "note": "휴지통 보관 기간 변경" }
   ```
   같은 모듈 기록이 3건 이상 쌓이면 계산기가 그 평균을 쓴다.

## 숫자의 뜻

- `docs/estimates.json` 의 모듈별 분은 2026-11-13 1차 개발에서 AI 에이전트가 모듈 하나를 구현·검수·수정하는 데 실제로 걸린 시간이다.
- 기능 하나 수정 = 기본 10분(맥락 파악·테스트) + 그 모듈 기능 1개 몫의 1~2배.
- 사람이 직접 개발하는 시간은 측정하지 않았다. 사람이 할 때는 그렇게 안내한다.
- 외부 업체 심사(PG·소셜 로그인·문자 발송)와 맥미니 설치 시간은 포함하지 않는다.
- 새 말이 기능과 잘 이어지지 않으면 `docs/estimates.json` 의 `aliases` 에 추가한다.
