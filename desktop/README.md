# 미믹 데스크톱 앱 (Windows · macOS)

미믹 서버 화면을 앱 창으로 여는 Electron 앱입니다(K-09). 화면은 서버의 웹 드라이브를 그대로 쓰고, 앱은 아래만 더합니다.

- **트레이**: 창을 닫아도 트레이에 남습니다(클라우드 다운로드는 서버에서 계속). 메뉴: 열기, 클라우드 다운로드, magnet 링크 연결, 서버 주소 바꾸기, 종료.
- **`mimic://play?url=<재생 링크>`**: 플레이어의 "외부 플레이어로 열기 → 미믹 데스크톱 앱"이 만드는 링크입니다. 앱 안 재생 창으로 엽니다. 연결된 미믹 서버의 링크만 엽니다. Chromium 이 재생할 수 있는 형식(mp4·webm·mp3 등)만 되고, mkv 등은 VLC·PotPlayer 를 쓰세요.
- **`magnet:` 링크**: 트레이에서 "magnet 링크를 미믹으로 열기"를 켜면, 브라우저에서 magnet 링크를 누를 때 앱의 "클라우드 다운로드 작업 생성" 창이 그 링크가 채워진 채로 열립니다. 로그인 전이면 로그인한 뒤에 열립니다.
  - Windows 10·11 은 앱이 직접 기본 앱을 바꿀 수 없습니다. 처음 한 번은 **설정 → 앱 → 기본 앱 → 링크 유형별 기본값 → MAGNET → Mimic** 을 고르세요.
- 다른 사이트 주소는 기본 브라우저로, `potplayer://`·`vlc://` 는 해당 플레이어로 넘깁니다. 그 밖의 스킴은 무시합니다. 이 규칙은 모든 창(재생 창, 새 창으로 열린 약관·도움말 등)과 서버가 보내는 다른 사이트 이동(302)에 똑같이 적용됩니다.
- **소셜 로그인(Google·Facebook·Apple)은 앱에서 쓸 수 없습니다.** Google 은 앱 안 브라우저 로그인을 거부하고, 기본 브라우저에서 로그인하면 세션이 앱으로 오지 않습니다. 누르면 안내 창이 뜨니 앱에서는 이메일·휴대폰 번호 또는 QR 코드로 로그인하세요. 개발 서버의 가짜 소셜 로그인(`/oauth/:p/dev`)은 같은 서버라 그대로 됩니다.
- 웹 화면에서는 `window.mimicDesktop?.isDesktop` 으로 앱 안인지 알 수 있습니다(preload 는 이것만 노출, Node·IPC 없음).

## 서버 주소

기본값은 `http://localhost:4300` 입니다. 바꾸는 방법(앞의 것이 우선):

1. 실행 인자 `--server=https://mimic.example.com`
2. 환경변수 `MIMIC_SERVER_URL`
3. 트레이 → "서버 주소 바꾸기…" → 열린 `config.json` 의 `serverUrl` 수정 → [다시 연결]
   (파일 위치: Windows `%APPDATA%\Mimic\config.json`, macOS `~/Library/Application Support/Mimic/config.json`)

## 설치 파일 받기 (GitHub Actions)

Mac 이 없어도 GitHub Actions 가 Windows·macOS 설치 파일을 만듭니다(`.github/workflows/desktop-build.yml`).

- **아무 때나**: GitHub → Actions → "데스크톱 빌드" → Run workflow → 끝나면 그 실행 화면 아래 Artifacts 에서 `mimic-windows`·`mimic-macos` 를 내려받습니다(30일 보관).
- **배포할 때**: `desktop/package.json` 의 `version` 을 올리고 `desktop-v<버전>` 태그를 push 합니다(예: `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`). 태그와 `version` 이 다르면 빌드가 바로 멈춥니다. 설치 파일이 붙은 **초안(draft) 릴리스**가 생기니 Releases 에서 확인한 뒤 게시합니다.

| 파일 | 대상 |
| --- | --- |
| `Mimic-<버전>-win.exe` | Windows 10·11 (64·32비트를 한 설치 파일에, 설치할 때 맞는 쪽을 고름) |
| `Mimic-<버전>-win-legacy.exe` | Windows 7·8·8.1 (Electron 22, 64·32비트) |
| `Mimic-<버전>-mac-arm64.dmg`, `…-mac-x64.dmg` | macOS Apple 칩 · Intel |

### 지금은 서명 없는 빌드

인증서가 아직 없어 서명하지 않습니다. 처음 열 때 경고가 뜹니다.

- **Windows**: SmartScreen "Windows의 PC 보호" → **추가 정보 → 실행**
- **macOS**: dmg 에서 응용 프로그램 폴더로 옮긴 뒤 **우클릭 → 열기 → 열기**. macOS 15 이상은 한 번 열어 본 뒤 **시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"**. (ad-hoc 서명은 해 두어서 "손상된 앱" 오류는 나지 않습니다.)

### 서명 켜기 (나중에)

저장소 Settings → Secrets and variables → Actions 에 아래를 넣으면 워크플로를 고치지 않아도 다음 빌드부터 서명합니다. 값은 파일에 쓰지 않습니다.

| Secret | 내용 |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Windows 코드 서명 인증서(.pfx 를 base64 로 바꾼 값)와 비밀번호 |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Apple "Developer ID Application" 인증서(.p12 를 base64 로)와 비밀번호 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | 공증(notarize)용 Apple ID·앱 암호·팀 ID. `MAC_CSC_LINK` 와 함께 넣어야 합니다 |

## 실행 · 빌드 (직접)

이 폴더(`desktop/`)는 서버와 별도 프로젝트입니다. Electron 이 커서(수백 MB) 저장소 루트에서는 설치하지 않습니다.

```bash
cd desktop
npm install          # electron, electron-builder
npm start            # 개발 실행(미믹 서버가 먼저 켜져 있어야 함)
npm run dist         # 지금 OS 용 설치 파일 → dist/
```

| 명령 | 결과 | 대상 |
| --- | --- | --- |
| `npm run dist:win` | `dist/Mimic-<버전>-win.exe` (x64·ia32 를 함께 담은 NSIS 설치 프로그램, 설치 폴더 선택 가능) | Windows 10·11 |
| `npm run dist:win-legacy` | `dist/legacy/…` (Electron 22.3.27 로 빌드) | Windows 7·8·8.1 (구버전 별도) |
| `npm run dist:mac` | `dist/Mimic-<버전>-mac-arm64.dmg`, `…-mac-x64.dmg` | macOS Apple 칩 · Intel |

- **Windows 구버전**: Electron 23 부터 Windows 7·8·8.1 을 지원하지 않아, 22.3.27 로 따로 빌드합니다. `main.js`·`preload.js` 는 이 버전에서도 돌도록 CommonJS·Node 16 문법만 씁니다. 구버전 빌드는 보안 업데이트가 끝난 Electron 이므로 다운로드 페이지에 "구버전 Windows 전용"으로 표시합니다.
- **macOS 빌드**는 macOS 에서만 됩니다(Mac 이 없으면 위의 GitHub Actions).
- `dist` 스크립트는 모두 `--publish never` 입니다. 릴리스는 워크플로의 초안 릴리스로만 올립니다.
- Windows 에서 "Smart App Control" 이 켜져 있으면 빌드 중 언인스톨러를 만드는 단계가 `spawn UNKNOWN` 으로 멈춥니다(서명 없는 실행 파일 차단). 그때는 GitHub Actions 로 빌드하세요.
- 아이콘(`icon.png`, 512px)은 저장소 루트에서 `node scripts/make-icons.mjs` 로 웹 아이콘과 함께 다시 만듭니다.
- 코드 확인만: `node --check main.js && node --check preload.js` (루트의 `npm test` 가 함께 검사).

## 다른 접점 (계획)

| 접점 | 지금 | 다음 단계 |
| --- | --- | --- |
| Android · iOS | **PWA**: 웹 `manifest.webmanifest` + `sw.js`. Android Chrome 은 "앱 설치", iOS Safari 는 공유 → "홈 화면에 추가". 화면 파일은 네트워크 우선(배포 직후 옛 파일과 섞이지 않게), 오프라인일 때만 캐시로 열림. `/api`·영상은 캐시하지 않음 | Google Play·Galaxy Store 는 같은 PWA 를 TWA(Trusted Web Activity, Bubblewrap)로 감싼 APK/AAB 로 등록. 서버에 `/.well-known/assetlinks.json` 필요(코어 변경: 지금은 404. SPA 대체 경로는 확장자 있는 주소를 건너뛰고 `express.static` 은 점(.) 폴더를 무시하므로, 명시 경로 또는 `.well-known` 한정 `dotfiles: 'allow'` 로 내보내야 함). 직접 배포용 APK 도 같은 빌드 |
| TV (Android TV) | 웹 `/tv` 화면(리모컨 방향키용, admin-content 담당) | TV 전용 APK: `/tv` 를 여는 WebView/TWA 앱 + Leanback 런처 배너(320×180) + `android.software.leanback` 선언. Android SDK 빌드 환경이 없어 아직 만들지 않음 |
| 앱 HDR 재생(C-02) | 해당 없음 | 네이티브 앱 단계에서 |

## K-09 진행 상태: 일부

있는 것: PWA(설치·오프라인 화면), Electron 소스와 빌드 설정(Windows 10·11 x64·ia32, Windows 7·8 구버전, macOS arm64·x64), GitHub Actions 자동 빌드(서명 없음, `desktop-v*` 태그 → 초안 릴리스).

남은 것:

- 서명: 인증서(Windows)·Apple Developer ID(macOS)를 구해 위 secrets 에 넣기. macOS 빌드는 Actions 에서 아직 한 번도 돌려 보지 않음(Windows x64 는 로컬에서 exe 생성 확인)
- Google Play·Galaxy Store 용 TWA APK/AAB, 직접 배포 APK (코어의 `/.well-known/assetlinks.json` 먼저)
- TV 전용 APK (Android SDK 빌드 환경 필요)
- 앱 소개 화면(`web/pages/apps.js`, admin-content 담당)의 설치 버튼: `import { installState, promptInstall, iosHint } from '/pwa.js'` 와 설치 파일 내려받기 링크
- 데스크톱 소셜 로그인: 기본 브라우저에서 로그인 → `mimic://` 로 세션 넘기기(auth 의 일회용 코드 API 필요)
