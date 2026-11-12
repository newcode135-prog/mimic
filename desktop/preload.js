// 최소 권한 preload: Node·IPC 는 열지 않고, 웹 화면이 "데스크톱 앱 안"인지만 알 수 있게 한다.
// (contextIsolation·sandbox 켜짐. 웹 화면에서 window.mimicDesktop?.platform 으로 확인)
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('mimicDesktop', Object.freeze({ isDesktop: true, platform: process.platform }));
