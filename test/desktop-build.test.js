// K-09 데스크톱 설치 파일 자동 빌드: 워크플로와 electron-builder 설정만 가볍게 확인(실제 빌드는 Actions 에서)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/desktop-build.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
// 워크플로에서 job 하나의 본문(다음 job 전까지)
const job = (name) => yml.split(/^ {2}(?=\w[\w-]*:\s*$)/m).find((s) => s.startsWith(`${name}:`)) || '';

test('[K-09] 워크플로: 수동 실행·desktop-v* 태그, Windows·macOS job, 아티팩트 30일', () => {
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /tags:\s*\['desktop-v\*'\]/);
  assert.match(job('windows'), /runs-on: windows-latest/);
  assert.match(job('windows'), /npm run dist:win\s*$/m);
  assert.match(job('windows'), /npm run dist:win-legacy/);
  assert.match(job('macos'), /runs-on: macos-latest/);
  assert.match(job('macos'), /npm run dist:mac/);
  for (const j of ['windows', 'macos']) {
    assert.match(job(j), /node-version: 24/);
    assert.match(job(j), /actions\/upload-artifact@v4/);
    assert.match(job(j), /retention-days: 30/);
  }
  // 모든 action 은 메이저 버전 고정
  for (const [, ref] of yml.matchAll(/uses: ([^\s]+)/g)) assert.match(ref, /@v\d+$/, ref);
});

test('[K-09] 릴리스: 태그일 때만, 초안으로, 쓰기 권한은 이 job 에만', () => {
  const rel = job('release');
  assert.match(rel, /if: startsWith\(github\.ref, 'refs\/tags\/desktop-v'\)/);
  assert.match(rel, /needs: \[windows, macos\]/);
  assert.match(rel, /gh release create[\s\S]*--draft/);
  assert.match(rel, /contents: write/);
  // 태그 버전과 package.json 버전이 다르면 빌드 전에 멈춘다
  assert.match(job('windows'), /if: startsWith\(github\.ref, 'refs\/tags\/'\)[\s\S]*require\('\.\/package\.json'\)\.version[\s\S]*GITHUB_REF_NAME[\s\S]*npm install/);
  assert.equal(yml.match(/contents: write/g).length, 1);
  assert.match(yml, /^permissions:\s*\n\s+contents: read/m);
});

test('[K-09] 서명은 secrets 로만 켠다(파일에 값 없음)', () => {
  for (const s of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'MAC_CSC_LINK', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.match(yml, new RegExp(`\\$\\{\\{ secrets\\.${s} \\}\\}`), s);
  }
  assert.match(job('macos'), /--config\.mac\.identity=-/, '인증서 없으면 ad-hoc 서명');
});

test('[K-09] electron-builder 설정: 필수 필드, publish 안 함, 아이콘 512px 이상', () => {
  for (const k of ['name', 'version', 'description', 'author', 'main']) assert.ok(pkg[k], k);
  for (const s of ['dist', 'dist:win', 'dist:win-legacy', 'dist:mac']) assert.match(pkg.scripts[s], /--publish never/, s);
  assert.ok(pkg.devDependencies.electron && pkg.devDependencies['electron-builder']);
  assert.ok(pkg.build.win.target.some((t) => t.target === 'nsis'));
  // 이름에 ${arch} 가 있으면 x64·ia32 합본 외에 arch 별 설치 파일까지 만든다
  assert.doesNotMatch(pkg.build.nsis.artifactName, /\$\{arch\}/);
  assert.ok(pkg.build.mac.target.some((t) => t.target === 'dmg'));
  const b = fs.readFileSync(path.join(root, 'desktop', pkg.build.icon));
  assert.ok(b.readUInt32BE(16) >= 512 && b.readUInt32BE(20) >= 512, 'macOS 아이콘은 512x512 이상');
});

test('[K-09] 빌드 결과물·node_modules 는 git 에 안 올라간다', () => {
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^desktop\/dist\/$/m);
  assert.match(ignore, /^(desktop\/)?node_modules\/$/m);
});
