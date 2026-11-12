// 미믹 텔레그램 봇(G-07). 실행: TELEGRAM_BOT_TOKEN=... MIMIC_BOT_SECRET=... MIMIC_SERVER=http://localhost:4300 node tools/telegram-bot/bot.js
// 봇은 미믹 서버의 봇 전용 API(/api/integrations/telegram/*, X-Bot-Secret 헤더)만 부른다.
import { Bot, InlineKeyboard } from 'grammy';

const { TELEGRAM_BOT_TOKEN, MIMIC_BOT_SECRET } = process.env;
const SERVER = (process.env.MIMIC_SERVER || 'http://localhost:4300').replace(/\/+$/, '');
if (!TELEGRAM_BOT_TOKEN || !MIMIC_BOT_SECRET) {
  console.error('환경변수 TELEGRAM_BOT_TOKEN 과 MIMIC_BOT_SECRET 이 필요합니다(서버와 같은 MIMIC_BOT_SECRET).');
  process.exit(1);
}
const API = `${SERVER}/api/integrations/telegram`;
const BOT_FILE_LIMIT = 20 * 1024 * 1024; // 텔레그램 봇 API 로 내려받을 수 있는 파일 크기 상한
const URL_RE = /(magnet:\?[^\s<>"']+|https?:\/\/[^\s<>"']+)/gi;

async function call(path, body) {
  const form = body instanceof FormData;
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'x-bot-secret': MIMIC_BOT_SECRET, ...(form ? {} : { 'content-type': 'application/json' }) },
    body: form ? body : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || `미믹 서버 오류(${r.status})`), { code: data.error });
  return data;
}
const size = (n) => (n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1)} TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

const HELLO = [
  '미믹 봇입니다. 보내 주신 링크와 파일을 미믹 클라우드에 대신 저장해 드려요.',
  '',
  '1) 미믹 웹 > 설정 > 액세스 및 통합 > 텔레그램 에서 8자리 연결 코드를 받으세요.',
  '2) 여기에 /bind AB12CD34 처럼 보내면 계정이 연결됩니다.',
  '3) 마그넷·토렌트·영상 주소를 보내거나 파일·사진·영상을 전달하면 "My telegram" 폴더에 저장됩니다.',
  '',
  '/quota 전송 쿼터 보기 · /settings 연동 해제',
  `텔레그램 봇은 ${BOT_FILE_LIMIT / 1024 / 1024}MB 보다 큰 파일을 받을 수 없어요. 큰 파일은 링크로 보내 주세요.`,
].join('\n');

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const who = (ctx) => String(ctx.from.id);
const fail = (ctx, e) => ctx.reply(e.code === 'not_linked' ? '먼저 /bind 코드 로 미믹 계정을 연결해 주세요.' : `저장하지 못했어요: ${e.message}`);

bot.command(['start', 'help'], (ctx) => ctx.reply(HELLO));

bot.command('bind', async (ctx) => {
  const code = String(ctx.match || '').replace(/[^0-9a-z]/gi, '').toUpperCase();
  if (code.length !== 8) return ctx.reply('사용법: /bind AB12CD34 (미믹 웹 설정에서 받은 8자리 코드)');
  try {
    const r = await call('/bind', { code, telegramUserId: who(ctx), chatId: String(ctx.chat.id) });
    await ctx.reply(`연결했어요: ${r.account}\n이제 링크나 파일을 보내면 미믹 클라우드에 저장됩니다.`);
  } catch (e) {
    await ctx.reply(e.message);
  }
});

bot.command('settings', (ctx) => ctx.reply('텔레그램 연동 설정', { reply_markup: new InlineKeyboard().text('미믹 계정 연동 해제', 'unbind') }));
bot.callbackQuery('unbind', async (ctx) => {
  const r = await call('/unbind', { telegramUserId: who(ctx) }).catch(() => ({ removed: false }));
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(r.removed ? '연동을 해제했어요. 다시 쓰려면 새 코드로 /bind 하세요.' : '연결된 미믹 계정이 없어요.');
});

bot.command('quota', async (ctx) => {
  try {
    const { quota: q, storage } = await call('/quota', { telegramUserId: who(ctx) });
    const ct = q.today?.cloudTasks;
    await ctx.reply(
      [
        `저장공간 ${size(storage.used)} / ${size(storage.total)}`,
        `이번 달 클라우드 다운로드 ${size(q.month.cloud.used)} / ${size(q.month.cloud.limit)}`,
        `이번 달 업로드 ${size(q.month.up.used)} / ${size(q.month.up.limit)}`,
        ct ? `오늘 남은 클라우드 다운로드: ${ct.unlimited ? '무제한' : `${ct.remaining}회`}` : '',
      ].filter(Boolean).join('\n'),
    );
  } catch (e) {
    await fail(ctx, e);
  }
});

async function saveLinks(ctx, text) {
  const urls = [...new Set(String(text || '').match(URL_RE) || [])];
  if (!urls.length) return false;
  try {
    await call('/links', { telegramUserId: who(ctx), urls });
    await ctx.reply(`링크 ${urls.length}개를 클라우드 다운로드에 넣었어요. 완료되면 "My telegram" 폴더에서 볼 수 있어요.`);
  } catch (e) {
    await fail(ctx, e);
  }
  return true;
}

// 파일·사진·영상·음성 포워딩 → 업로드
bot.on(['message:document', 'message:video', 'message:audio', 'message:photo', 'message:animation', 'message:voice', 'message:video_note'], async (ctx) => {
  const m = ctx.message;
  const f = m.document || m.video || m.audio || m.animation || m.voice || m.video_note || m.photo?.at(-1);
  const stamp = new Date(m.date * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const ext = m.photo ? 'jpg' : m.voice ? 'ogg' : m.video_note ? 'mp4' : 'bin';
  const name = f.file_name || `telegram_${stamp}.${ext}`;
  if (f.file_size > BOT_FILE_LIMIT) {
    await ctx.reply(`"${name}" 은(는) ${size(f.file_size)} 라서 받을 수 없어요. 텔레그램 봇은 20MB 까지만 내려받을 수 있습니다. 큰 파일은 링크로 보내 주세요.`);
  } else {
    try {
      const file = await ctx.api.getFile(f.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`);
      if (!res.ok) throw new Error('텔레그램에서 파일을 받지 못했어요');
      const fd = new FormData();
      fd.append('telegramUserId', who(ctx)); // 파일보다 먼저 보내야 한다
      fd.append('file', new Blob([await res.arrayBuffer()], { type: f.mime_type || (m.photo ? 'image/jpeg' : 'application/octet-stream') }), name);
      const r = await call('/upload', fd);
      await ctx.reply(`저장했어요: ${r.file.name} (${size(r.file.size)})`);
    } catch (e) {
      await fail(ctx, e);
    }
  }
  await saveLinks(ctx, m.caption);
});

// 글·캡션 안의 링크
bot.on('message', async (ctx) => {
  if (!(await saveLinks(ctx, ctx.message.text || ctx.message.caption))) await ctx.reply('저장할 링크나 파일을 보내 주세요. 사용법은 /start');
});

bot.catch((err) => console.error('[telegram-bot]', err.error || err));
await bot.api.setMyCommands([
  { command: 'bind', description: '미믹 계정 연결 (/bind 코드)' },
  { command: 'quota', description: '전송 쿼터 보기' },
  { command: 'settings', description: '연동 해제' },
  { command: 'start', description: '사용법' },
]);
bot.start({ onStart: (me) => console.log(`미믹 텔레그램 봇 @${me.username} 실행 중 → ${SERVER}`) });
