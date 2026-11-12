// 금고 암호화 도구(E-01·E-02·E-03·E-05). 브라우저와 Node(테스트)가 그대로 함께 쓰는 순수 함수 모음.
// 서버로는 암호문·감싼 키·증명값만 보낸다. 평문·패스코드·마스터키·공유키는 기기 밖으로 나가지 않는다.
//
// 키 구조
//   패스코드 --PBKDF2-SHA256(31만 회)--> 감싸기 키 --AES-GCM--> 마스터키(무작위 256비트)
//   생체인증(WebAuthn PRF 출력) --HKDF--> 감싸기 키 --AES-GCM--> 같은 마스터키
//   마스터키 --AES-GCM--> 파일별 데이터키, 폴더 이름
//   파일 데이터키 --AES-GCM--> 파일 본문(4MB 조각), 파일 이름, MIME·원본 크기
//   공유키(공유마다 새로) --AES-GCM--> 공유한 파일들의 데이터키
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600_000; // OWASP 권장(PBKDF2-HMAC-SHA256). 이미 만든 금고는 저장된 반복 횟수를 그대로 쓴다
export const CHUNK = 4 * 1024 * 1024; // 평문 조각 크기. 암호문 조각 = 12(iv) + CHUNK + 16(tag)
const OVERHEAD = 28;
// 평문 n 바이트를 encryptBlob 하면 나오는 암호문 크기(빈 파일도 조각 하나). 올리기 전 남은 용량 확인에 쓴다(E-04)
export const cipherSize = (n) => n + Math.max(1, Math.ceil(n / CHUNK)) * OVERHEAD;

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const importAes = (raw) => subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
export const newKey = () => importAes(randomBytes(32));
export const rawKey = async (key) => new Uint8Array(await subtle.exportKey('raw', key));

// iv(12) || 암호문+태그. aad 가 다르면 복호화가 실패한다(조각 순서·끝 표시 보호)
export async function seal(key, data, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, ...(aad && { additionalData: aad }) }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}
export async function open(key, sealed, aad) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), ...(aad && { additionalData: aad }) }, key, sealed.subarray(12));
  return new Uint8Array(pt);
}
export const sealText = async (key, text) => b64(await seal(key, te.encode(text)));
export const openText = async (key, s) => td.decode(await open(key, unb64(s)));
export const wrapKey = async (wrapper, key) => b64(await seal(wrapper, await rawKey(key)));
export const unwrapKey = async (wrapper, s) => importAes(await open(wrapper, unb64(s)));

// ---------- 패스코드 규칙(E-01) ----------
// 서버는 감싼 마스터키를 보관하므로, 약한 패스코드는 오프라인에서 하나씩 대입해 풀 수 있다. 서버는 패스코드를 보지 못하니 여기서 막는다.
// 10자 이상, 또는 8자 이상이면서 영문 소문자·대문자·숫자·기호 중 3가지 이상. 숫자만·흔한 단어·반복·연속 문자는 안 된다
const WEAK_PARTS = /password|passw0rd|qwerty|asdf|zxcv|iloveyou|letmein|welcome|admin|mimic|vault|abcd|0123|1234|2345|3456|4567|5678|6789|7890|9876|8765|7654|6543|5432|4321|(.)\1{2,}/gi;
const classesOf = (p) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
// 문제 없으면 null, 아니면 'short' | 'digits' | 'common' | 'simple'
export function passcodeProblem(p) {
  p = String(p ?? '');
  if (p.length < 8) return 'short';
  if (/^\d+$/.test(p)) return 'digits';
  if (p.replace(WEAK_PARTS, '').length < 6 || new Set(p.toLowerCase()).size < 5) return 'common';
  if (p.length < 10 && classesOf(p) < 3) return 'simple';
  return null;
}
// 강도 표시용 0~4 (0·1 은 쓸 수 없음)
export function passcodeScore(p) {
  p = String(p ?? '');
  if (!p) return 0;
  if (passcodeProblem(p)) return 1;
  return p.length >= 14 && classesOf(p) >= 3 ? 4 : p.length >= 12 ? 3 : 2;
}

// ---------- 잠금 해제 키(E-02) ----------
export async function passcodeKey(passcode, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle.importKey('raw', te.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// WebAuthn PRF 확장의 출력(기기 안에서만 계산되는 32바이트 비밀)으로 감싸기 키를 만든다
export async function prfKey(prfOutput) {
  const base = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode('mimic-vault-prf') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// 서버는 이 값의 해시만 보관한다. 마스터키를 아는 기기만 POST /api/vault/unlock 으로 잠금 해제 토큰(x-vault-token)을 받는다
export async function vaultProof(master) {
  const raw = await rawKey(master);
  const buf = new Uint8Array([...raw, ...te.encode('mimic-vault-proof')]);
  return b64(new Uint8Array(await subtle.digest('SHA-256', buf)));
}
// 패스코드로 마스터키를 감싼다(처음 설정·패스코드 변경)
export async function wrapWithPasscode(master, passcode, iterations = KDF_ITERATIONS) {
  const salt = b64(randomBytes(16));
  return { salt, iterations, wrappedMaster: await wrapKey(await passcodeKey(passcode, salt, iterations), master) };
}
export async function createVault(passcode, iterations = KDF_ITERATIONS) {
  const master = await newKey();
  return { master, body: { ...(await wrapWithPasscode(master, passcode, iterations)), proof: await vaultProof(master) } };
}
// 패스코드가 틀리면 AES-GCM 인증이 실패해 예외가 난다
export async function unlockWithPasscode(keys, passcode) {
  return unwrapKey(await passcodeKey(passcode, keys.salt, keys.iterations), keys.wrappedMaster);
}
// 마스터키 교체(패스코드 변경 때): 금고 전체 항목(GET /api/vault/list?all=1)의 폴더 이름·파일 데이터키를 새 마스터키로 다시 감싼다.
// 파일 본문·파일 이름·공유는 파일 데이터키를 그대로 쓰므로 바뀌지 않는다. body 는 PUT /api/vault/keys 에 그대로 보낸다
export async function rotateMaster(oldMaster, items, passcode, iterations = KDF_ITERATIONS) {
  const master = await newKey();
  const out = [];
  for (const it of items)
    out.push(it.kind === 'folder' ? { id: it.id, encName: await sealText(master, await openText(oldMaster, it.encName)) } : { id: it.id, encKey: await wrapKey(master, await unwrapKey(oldMaster, it.encKey)) });
  return { master, body: { ...(await wrapWithPasscode(master, passcode, iterations)), proof: await vaultProof(master), items: out } };
}

// ---------- 파일 본문(E-01) ----------
const aadFor = (i, last) => {
  const a = new Uint8Array(5);
  new DataView(a.buffer).setUint32(0, i);
  a[4] = last ? 1 : 0;
  return a;
};
// ponytail: 암호문 조각을 메모리에 모아 Blob 으로 만든다(대략 파일 크기 2배 메모리). 수 GB 파일이 잦으면 조각 단위 이어올리기 API 로 바꿀 것
export async function encryptBlob(key, blob, onProgress) {
  const parts = [];
  for (let i = 0, off = 0; ; i++, off += CHUNK) {
    const end = Math.min(off + CHUNK, blob.size);
    const last = end >= blob.size;
    parts.push(await seal(key, new Uint8Array(await blob.slice(off, end).arrayBuffer()), aadFor(i, last)));
    onProgress?.(end, blob.size);
    if (last) return new Blob(parts, { type: 'application/octet-stream' });
  }
}
export async function decryptBlob(key, blob, onProgress, type = 'application/octet-stream') {
  const parts = [];
  const step = CHUNK + OVERHEAD;
  for (let i = 0, off = 0; ; i++, off += step) {
    const end = Math.min(off + step, blob.size);
    const last = end >= blob.size;
    parts.push(await open(key, new Uint8Array(await blob.slice(off, end).arrayBuffer()), aadFor(i, last)));
    onProgress?.(end, blob.size);
    if (last) return new Blob(parts, { type });
  }
}

// 파일 이름·MIME·원본 크기는 파일 데이터키로 암호화한다(공유받은 사람도 데이터키만으로 읽을 수 있게)
export async function sealFileMeta(master, fileKey, { name, mime, size }) {
  return {
    encName: await sealText(fileKey, name),
    encKey: await wrapKey(master, fileKey),
    encInfo: await sealText(fileKey, JSON.stringify({ mime: mime || 'application/octet-stream', size })),
  };
}
export async function openFileMeta(fileKey, { encName, encInfo }) {
  const info = JSON.parse(await openText(fileKey, encInfo));
  return { name: await openText(fileKey, encName), mime: info.mime || 'application/octet-stream', size: info.size };
}

// ---------- 암호화 공유(E-05) ----------
// files: [{ id, key(파일 데이터키) }] → 새 공유키(문자열)와 공유키로 감싼 데이터키들
export async function makeShareKeys(files) {
  const shareKey = await newKey();
  const wrappedKeys = {};
  for (const f of files) wrappedKeys[f.id] = await wrapKey(shareKey, f.key);
  return { key: b64(await rawKey(shareKey)), wrappedKeys };
}
export const importShareKey = (s) => importAes(unb64(String(s).trim()));

// ---------- 자동 잠금(E-03) ----------
// 탭이 숨겨지거나 페이지를 떠나면 즉시, minutes 동안 조작이 없으면 lock() 을 부른다. 돌려준 함수로 해제.
//   stop.hold()  → 전송 중: 미사용 타이머가 잠그지 않는다. 돌려준 함수로 끝냄
//   stop.defer() → 파일 선택·생체인증 창: 그동안 탭이 숨겨져도 바로 잠그지 않고, 돌려준 함수를 부를 때 아직 숨겨져 있으면 잠근다
//   stop.setMinutes(m) → 미사용 시간만 바꾸고 다시 센다(진행 중인 hold·defer 는 그대로 유지)
export function autoLock(lock, minutes, doc = globalThis.document, win = globalThis) {
  let timer;
  let busy = 0;
  let deferred = 0;
  let stopped = false;
  const arm = () => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => (busy ? arm() : lock()), minutes * 60_000);
  };
  const once = (fn) => {
    let done = false;
    return () => done || ((done = true), fn());
  };
  const onVisibility = () => doc.hidden && !deferred && lock();
  const acts = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  acts.forEach((e) => doc.addEventListener(e, arm, { passive: true }));
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', lock);
  arm();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    acts.forEach((e) => doc.removeEventListener(e, arm));
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', lock);
  };
  stop.hold = () => {
    busy++;
    return once(() => (busy--, arm()));
  };
  // ponytail: 고르기 창에서 다른 앱으로 가 버리면 미사용 시간·pagehide 까지만 열려 있다. 더 엄격히 하려면 defer 에 최대 시간(예: 2분)을 둘 것
  stop.defer = () => {
    deferred++;
    return once(() => (--deferred || stopped || !doc.hidden || lock()));
  };
  stop.setMinutes = (m) => ((minutes = m), arm());
  return stop;
}
