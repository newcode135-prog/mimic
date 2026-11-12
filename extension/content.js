// 팝업이 현재 탭에 주입한다. 페이지의 마그넷·토렌트·영상·파일 링크를 찾아 마지막 식의 값으로 돌려준다
(() => {
  const FILE_RE = /\.(torrent|mp4|mkv|avi|mov|webm|m4v|ts|flv|wmv|rmvb|mp3|flac|wav|m4a|aac|zip|rar|7z|iso|pdf|apk|exe|dmg)(?:[?#]|$)/i;
  const found = new Map();
  const add = (raw, kind, label) => {
    if (!raw) return;
    let url;
    try {
      url = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (!/^(https?:|magnet:)/i.test(url) || found.has(url)) return;
    found.set(url, { url, kind, label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  };
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const label = a.textContent || a.title || a.download;
    if (/^magnet:/i.test(href)) add(href, 'magnet', label);
    else if (/\.torrent(?:[?#]|$)/i.test(a.href)) add(a.href, 'torrent', label);
    else if (FILE_RE.test(a.href) || a.hasAttribute('download')) add(a.href, 'file', label);
  }
  for (const m of document.querySelectorAll('video, audio, video source, audio source')) {
    const src = m.currentSrc || m.src;
    if (src && !/^(blob|data):/.test(src)) add(src, 'media', document.title);
  }
  // 글 안에 그냥 적힌 마그넷 링크
  for (const m of (document.body?.innerText || '').matchAll(/magnet:\?xt=urn:[a-z0-9]+:[a-z0-9]{32,40}[^\s"'<>]*/gi)) add(m[0], 'magnet', '');
  const items = [...found.values()].slice(0, 300);
  // SNS 게시물처럼 페이지 자체를 저장할 수도 있게 마지막에 붙인다(기본 선택 안 함)
  if (/^https?:/.test(location.href)) items.push({ url: location.href, kind: 'page', label: document.title });
  return items;
})();
