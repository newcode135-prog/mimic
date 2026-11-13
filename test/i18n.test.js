import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, createUser, sessionFor, client } from './helpers.js';
import { notify } from '../server/core/notify.js';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const EN = { 'x-mimic-lang': 'en' };
const english = (v, what) => assert.ok(!HANGUL.test(JSON.stringify(v)), `${what}: ${JSON.stringify(v).match(/.{0,40}[가-힯].{0,20}/)?.[0]}`);

test('i18n: x-mimic-lang 헤더로 콘텐츠·알림 언어를 고른다(K-03)', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const anon = client(s.url);

  await t.test('도움말: 모든 분류·글·관련 글·검색이 영어, 키는 한국어와 같다', async () => {
    const ko = (await anon.get('/api/content/help')).body;
    const en = (await anon.get('/api/content/help', EN)).body;
    assert.deepEqual(Object.keys(en.categories[0]), Object.keys(ko.categories[0]));
    for (const c of en.categories) english([c.title, c.desc, c.articles.map((a) => a.title)], c.id);
    const slugs = ko.categories.flatMap((c) => c.articles.map((a) => a.slug));
    assert.deepEqual(en.categories.flatMap((c) => c.articles.map((a) => a.slug)), slugs);
    for (const slug of slugs) {
      const r = (await anon.get('/api/content/help/' + slug, EN)).body;
      english([r.article.title, r.article.body, r.category.title, r.category.desc, r.related.map((a) => a.title)], slug);
    }
    const found = (await anon.get('/api/content/help?q=trash', EN)).body.results;
    assert.ok(found.some((a) => a.slug === 'trash'));
    english(found, 'search');
    assert.equal((await anon.get('/api/content/help?q=' + encodeURIComponent('휴지통'), EN)).body.results.length, 0);
  });

  await t.test('FAQ: 모든 질문이 영어, id·help 는 그대로', async () => {
    const ko = (await anon.get('/api/content/faq')).body.items;
    const en = (await anon.get('/api/content/faq', EN)).body.items;
    assert.deepEqual(en.map((f) => [f.id, f.help]), ko.map((f) => [f.id, f.help]));
    for (const f of en) english([f.cat, f.q, f.a], f.id);
  });

  await t.test('블로그: 목록과 모든 글이 영어', async () => {
    const ko = (await anon.get('/api/content/blog')).body.posts;
    const en = (await anon.get('/api/content/blog', EN)).body.posts;
    assert.deepEqual(en.map((p) => p.slug), ko.map((p) => p.slug));
    assert.deepEqual(Object.keys(en[0]), Object.keys(ko[0]));
    for (const p of en) {
      english([p.title, p.summary, p.tags], p.slug);
      const { post } = (await anon.get('/api/content/blog/' + p.slug, EN)).body;
      english([post.title, post.summary, post.tags, post.body], p.slug);
    }
  });

  await t.test('정책: 목록과 모든 문서·조항이 영어, 조항 id 는 그대로', async () => {
    const ko = (await anon.get('/api/content/policies')).body.policies;
    const en = (await anon.get('/api/content/policies', EN)).body.policies;
    assert.deepEqual(en.map((p) => p.slug), ko.map((p) => p.slug));
    english(en.map((p) => p.title), 'policies');
    for (const { slug } of ko) {
      const k = (await anon.get('/api/content/policies/' + slug)).body.policy;
      const e = (await anon.get('/api/content/policies/' + slug, EN)).body.policy;
      assert.deepEqual(Object.keys(e), Object.keys(k));
      assert.deepEqual(e.sections.map((x) => x.id), k.sections.map((x) => x.id));
      english([e.title, e.sections], slug);
    }
  });

  await t.test('헤더가 없으면 한국어, ?lang=en 도 되고 헤더가 우선한다', async () => {
    assert.match((await anon.get('/api/content/help/trash')).body.article.title, HANGUL);
    assert.match((await anon.get('/api/content/faq')).body.items[0].q, HANGUL);
    assert.match((await anon.get('/api/content/blog')).body.posts[0].title, HANGUL);
    assert.match((await anon.get('/api/content/policies/terms')).body.policy.sections[0].body, HANGUL);
    assert.doesNotMatch((await anon.get('/api/content/faq?lang=en')).body.items[0].q, HANGUL);
    assert.match((await anon.get('/api/content/faq?lang=en', { 'x-mimic-lang': 'ko' })).body.items[0].q, HANGUL);
    assert.match((await anon.get('/api/content/faq', { 'x-mimic-lang': 'fr' })).body.items[0].q, HANGUL);
  });

  await t.test('알림: 화면 언어(헤더)가 계정 언어보다 먼저', async () => {
    const u = createUser(s.db);
    const U = client(s.url, sessionFor(s.db, u.id));
    notify(s.db, u.id, { kind: 'notice', title: '점검 안내', titleEn: 'Maintenance', body: '오늘 밤', bodyEn: 'Tonight' });
    const first = async (h) => (await U.get('/api/notifications', h)).body.items[0];
    assert.equal((await first()).title, '점검 안내');
    assert.deepEqual([(await first(EN)).title, (await first(EN)).body], ['Maintenance', 'Tonight']);
    s.db.prepare("UPDATE users SET lang='en' WHERE id=?").run(u.id);
    assert.equal((await first()).title, 'Maintenance');
    assert.equal((await first({ 'x-mimic-lang': 'ko' })).title, '점검 안내');
  });

  await t.test('화면 api() 는 매 요청에 화면 언어 헤더를 보낸다', () => {
    assert.match(fs.readFileSync(new URL('../web/ui.js', import.meta.url), 'utf8'), /'x-mimic-lang': getLang\(\)/);
  });
});
