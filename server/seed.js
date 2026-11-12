// 첫 관리자 계정 만들기: npm run seed -- <관리자 이메일>
// 이미 있는 계정이면 관리자로 지정하고, 없으면 새로 만들어 임시 비밀번호를 한 번만 보여 준다.
import crypto from 'node:crypto';
import { loadConfig } from './core/config.js';
import { openDb } from './core/db.js';
import { hashPassword } from './core/auth.js';
import { newId, now } from './core/util.js';

const email = (process.argv[2] || process.env.MIMIC_ADMIN_EMAIL || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('사용법: npm run seed -- <관리자 이메일>');
  process.exit(1);
}

const cfg = loadConfig();
const db = openDb(cfg.dataDir);
const found = db.prepare('SELECT id FROM users WHERE email=?').get(email);
if (found) {
  db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(found.id);
  console.log(`${email} 계정을 관리자로 지정했습니다.`);
} else {
  // 비밀번호 규칙(문자·숫자·기호 6~16자)을 만족하는 임시 비밀번호
  const pw = `${crypto.randomBytes(9).toString('base64url')}!7a`;
  db.prepare('INSERT INTO users (id, email, password_hash, name, is_admin, invite_code, created_at) VALUES (?,?,?,?,1,?,?)').run(
    newId('u_'),
    email,
    hashPassword(pw),
    '관리자',
    crypto.randomBytes(6).toString('base64url').slice(0, 8),
    now(),
  );
  console.log(`관리자 계정을 만들었습니다: ${email}`);
  console.log(`임시 비밀번호(한 번만 표시): ${pw}`);
  console.log('로그인한 뒤 계정 및 보안 > 비밀번호에서 바꾸세요.');
}
db.close();
