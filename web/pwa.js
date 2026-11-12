// 모바일 설치(PWA, K-09): 서비스 워커 등록 + "앱 설치" 안내.
// index.html 이 불러온다. 다른 화면(앱 다운로드 페이지·사이드바 등)은 아래 export 를 쓴다:
//   import { installState, promptInstall } from '/pwa.js';
//   installState() → 'installed' | 'ready'(설치 창 띄울 수 있음) | 'ios'(공유 → 홈 화면에 추가 안내) | 'unavailable'
//   await promptInstall() → 'accepted' | 'dismissed' | 'ios' | 'unavailable'
//   bus.on('pwa:install', (state) => …)  // 상태가 바뀌면 알림
import { bus, t } from '/ui.js';

let deferred = null; // beforeinstallprompt 이벤트(Android·데스크톱 Chrome·Edge)

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function installState() {
  if (isStandalone()) return 'installed';
  if (deferred) return 'ready';
  return isIOS() ? 'ios' : 'unavailable';
}

export async function promptInstall() {
  if (!deferred) return installState() === 'ios' ? 'ios' : 'unavailable';
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  bus.emit('pwa:install', installState());
  return outcome;
}

export const iosHint = () => t('Safari 아래쪽 공유 버튼 → "홈 화면에 추가"를 누르면 미믹을 앱처럼 쓸 수 있어요.', 'In Safari, tap Share → "Add to Home Screen" to use Mimic like an app.');

// 브라우저 기본 설치 안내(주소창 아이콘·하단 배너)는 그대로 두고, 이벤트만 보관해 화면 버튼에서도 쓸 수 있게 한다
addEventListener('beforeinstallprompt', (e) => {
  deferred = e;
  bus.emit('pwa:install', 'ready');
});
addEventListener('appinstalled', () => {
  deferred = null;
  bus.emit('pwa:install', 'installed');
});

// sw.js 는 네트워크 우선이라 새 버전이 바로 반영된다(새로 고침 안내 없음)
if ('serviceWorker' in navigator && isSecureContext) {
  // 개발 주소(localhost 등)에서는 기본으로 끈다(서버를 끄면 캐시로 열려 헷갈림).
  // 로컬에서 PWA 를 시험하려면 콘솔에서 localStorage.setItem('mimic:sw', '1') 후 새로 고침.
  let optIn = false;
  try {
    optIn = localStorage.getItem('mimic:sw') === '1';
  } catch {}
  const devHost = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);
  const register = () =>
    devHost && !optIn
      ? navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()))
      : navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('서비스 워커 등록 실패', e));
  if (document.readyState === 'complete') register();
  else addEventListener('load', register);
}
