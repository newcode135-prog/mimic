# 미믹 텔레그램 봇

텔레그램으로 보낸 링크·파일을 사용자의 미믹 클라우드("My telegram" 폴더)에 저장하는 봇입니다. 저장소 루트의 `grammy` 의존성을 그대로 씁니다.

## 실행

1. 텔레그램 @BotFather 에서 봇을 만들고 토큰을 받습니다.
2. 미믹 서버와 봇에 **같은** 비밀값을 넣습니다. 서버는 이 값이 없으면 봇 API 를 끕니다.

```sh
# 미믹 서버
MIMIC_BOT_SECRET=<긴 임의 문자열> TELEGRAM_BOT_USERNAME=<봇 사용자명> npm start

# 봇(다른 터미널)
TELEGRAM_BOT_TOKEN=<BotFather 토큰> MIMIC_BOT_SECRET=<같은 문자열> MIMIC_SERVER=http://localhost:4300 node tools/telegram-bot/bot.js
```

## 사용자 흐름

1. 미믹 웹 **설정 > 액세스 및 통합 > 텔레그램**에서 8자리 연결 코드(10분 유효)를 받습니다.
2. 봇에게 `/bind AB12CD34` 처럼 코드를 보냅니다.
3. 마그넷·URL 을 보내면 클라우드 다운로드 작업이 되고, 파일·사진·영상을 전달하면 바로 저장됩니다.
   - 설정의 "다른 앱 파일 전용 폴더"가 켜져 있으면 `My telegram` 폴더, 꺼져 있으면 최상위에 저장합니다.
   - 텔레그램 봇 API 는 20MB 보다 큰 파일을 내려받을 수 없습니다. 큰 파일은 링크로 보내 주세요.
4. `/quota` 로 쿼터를 보고, `/settings` 의 버튼이나 웹 설정에서 연동을 해제합니다.

## 봇 전용 API (`X-Bot-Secret` 헤더 필요)

| 경로 | 본문 |
| --- | --- |
| `POST /api/integrations/telegram/bind` | `{ code, telegramUserId, chatId }` |
| `POST /api/integrations/telegram/unbind` | `{ telegramUserId }` |
| `POST /api/integrations/telegram/links` | `{ telegramUserId, urls[] }` |
| `POST /api/integrations/telegram/upload` | multipart: `telegramUserId`(먼저), `file` |
| `POST /api/integrations/telegram/quota` | `{ telegramUserId }` |
