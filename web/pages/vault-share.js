// 금고 공유 받기(/vs/:token, E-05). 키는 주소 # 뒤(서버로 전송되지 않음) 또는 직접 입력으로만 받고,
// 복호화는 이 브라우저에서 한다. 서버에는 키를 보내지 않는다.
import { api, h, t, icon, formatBytes, formatDate, loadCss, fileIcon } from '/ui.js';
import * as vc from '/pages/vault-crypto.js';
import { saveBlob, readWithProgress, resError, errorMessage } from '/pages/vault.js';

export async function render(root, ctx) {
  loadCss('/css/vault.css');
  const token = ctx.params.token;
  const box = h('div', { class: 'container narrow vault-share' });
  root.replaceChildren(box);
  const card = (...kids) => box.replaceChildren(h('div', { class: 'card vault-lock' }, ...kids));

  let share;
  try {
    share = await api(`/api/vault/public/${encodeURIComponent(token)}`);
  } catch (e) {
    return void card(
      h('div', { class: 'vault-badge', html: icon('lock') }),
      h('h2', {}, e.status === 410 ? t('더 이상 열 수 없는 공유예요', 'This share is no longer available') : t('공유를 찾을 수 없어요', 'Share not found')),
      h('p', { class: 'muted' }, e.status === 410 ? errorMessage(e.code, e.message, t('공유를 열 수 없어요.', 'This share cannot be opened.')) : t('주소가 정확한지 확인해 주세요.', 'Please check the address.')),
    );
  }

  const hashKey = new URLSearchParams(location.hash.slice(1)).get('k');
  if (hashKey) history.replaceState(history.state, '', location.pathname + location.search); // 키가 주소창·방문 기록에 남지 않게
  if (!hashKey || !(await tryOpen(hashKey))) askKey(!!hashKey);

  async function tryOpen(key) {
    try {
      const shareKey = await vc.importShareKey(key);
      const files = [];
      for (const f of share.files) {
        const fk = await vc.unwrapKey(shareKey, f.wrappedKey);
        files.push({ ...f, kind: 'file', key: fk, ...(await vc.openFileMeta(fk, f)) });
      }
      drawFiles(files);
      return true;
    } catch {
      return false;
    }
  }

  function askKey(wrong) {
    const input = h('input', { class: 'input vault-mono', autocomplete: 'off', spellcheck: 'false', placeholder: t('받은 공유 키를 붙여 넣으세요', 'Paste the share key you received') });
    const err = h('p', { class: 'vault-error', role: 'alert' }, wrong ? t('링크에 든 키가 맞지 않아요. 받은 키를 직접 넣어 보세요.', 'The key in the link does not match. Try entering it.') : '');
    const go = h('button', { class: 'btn primary lg block', type: 'submit' }, t('열기', 'Open'));
    card(
      h(
        'form',
        {
          class: 'col',
          onsubmit: async (e) => {
            e.preventDefault();
            go.disabled = true;
            if (!(await tryOpen(input.value))) {
              err.textContent = t('키가 맞지 않아요. 보낸 사람에게 받은 키를 다시 확인해 주세요.', 'Wrong key. Please check the key you received.');
              go.disabled = false;
            }
          },
        },
        h('div', { class: 'vault-badge', html: icon('shield') }),
        h('h2', {}, t('암호화된 공유 파일', 'Encrypted shared files')),
        h('p', { class: 'muted' }, t('보낸 사람이 함께 준 키가 있어야 열 수 있어요. 키는 이 브라우저 안에서만 쓰이고 미믹 서버로 가지 않아요.', 'You need the key from the sender. It is used only in this browser and never sent to Mimic.')),
        input,
        err,
        go,
      ),
    );
    input.focus();
  }

  function drawFiles(files) {
    const rows = files.map((f) => {
      const b = h('button', { class: 'btn sm', type: 'button', html: `${icon('download')}<span>${t('받기', 'Download')}</span>` });
      b.onclick = () => download(f, b);
      return h('tr', {}, h('td', {}, h('span', { class: 'vault-name', html: icon(fileIcon(f)) }, f.name)), h('td', { class: 'muted vault-hide-sm' }, formatBytes(f.size)), h('td', { class: 'vault-actions' }, b));
    });
    box.replaceChildren(
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'vault-badge sm', html: icon('shield') }),
        h('div', {}, h('h2', {}, t('암호화된 공유 파일', 'Encrypted shared files')), h('p', { class: 'small muted' }, share.expiresAt ? t(`${formatDate(share.expiresAt)}까지 받을 수 있어요`, `Available until ${formatDate(share.expiresAt)}`) : t('기한 없는 공유', 'No expiry'))),
      ),
      rows.length
        ? h('table', { class: 'table vault-list' }, h('tbody', {}, ...rows))
        : h('div', { class: 'empty' }, h('p', {}, t('공유한 사람이 파일을 지워서 남은 파일이 없어요.', 'The sender has removed these files.'))),
      h('p', { class: 'small muted vault-foot' }, t('파일은 받은 뒤 이 브라우저에서 풀어 저장해요.', 'Files are decrypted in this browser after download.')),
    );
  }

  async function download(f, b) {
    const label = b.innerHTML;
    b.disabled = true;
    try {
      const res = await fetch(`/api/vault/public/${encodeURIComponent(token)}/files/${encodeURIComponent(f.id)}/blob`);
      if (!res.ok) throw await resError(res, t('받지 못했어요', 'Download failed'));
      const cipher = await readWithProgress(res, (p) => (b.textContent = `${Math.round(p * 90)}%`));
      b.textContent = t('푸는 중', 'Decrypting');
      saveBlob(await vc.decryptBlob(f.key, cipher, null, f.mime), f.name);
      b.innerHTML = label;
    } catch (e) {
      b.textContent = t('실패 — 다시', 'Failed — retry');
      b.title = e.name === 'OperationError' ? t('파일이 손상되어 풀 수 없어요', 'File is damaged') : e.message;
    } finally {
      b.disabled = false;
    }
  }
}
