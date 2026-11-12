// 미믹노트 체크인: 팀원 찾기, 투두 읽기, 텔레그램 메시지 문구
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMembers, findMember, loadTodos, buildMessage, chatIdFor } from '../mimic-note/checkin.mjs';

const members = loadMembers();

test('관리자 구성: 창민 대표관리자, 민호 관리자', () => {
  assert.equal(findMember('창민', members).role, 'owner');
  assert.equal(findMember('민호', members).role, 'admin');
  assert.equal(members.filter((m) => m.role === 'owner').length, 1);
});

test('이름·아이디·님 붙인 이름 모두 같은 팀원', () => {
  for (const v of ['민호', 'minho', 'Minho', ' 민호님 ']) assert.equal(findMember(v, members).id, 'minho');
  assert.equal(findMember('없는사람', members), null);
  assert.equal(findMember('', members), null);
});

test('민호 테스트 투두 3개가 정해진 문구로 나온다', () => {
  const minho = findMember('민호', members);
  assert.equal(
    buildMessage(minho, loadTodos('minho')),
    '민호님의 투두리스트 1번은 test 1\n민호님의 투두리스트 2번은 test 2\n민호님의 투두리스트 3번은 test 3',
  );
});

test('투두가 없는 팀원은 안내 문구', () => {
  const yuri = findMember('유리', members);
  assert.equal(buildMessage(yuri, loadTodos('yuri')), '유리님, 지금 등록된 투두리스트가 없습니다.');
});

test('chat id 는 개별 변수 또는 JSON 비밀값에서 읽는다', () => {
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_ID_MINHO: '1' }), '1');
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_IDS: '{"minho":"2"}' }), '2');
  assert.equal(chatIdFor('minho', { TELEGRAM_CHAT_IDS: 'not json' }), null);
  assert.equal(chatIdFor('minho', {}), null);
});
