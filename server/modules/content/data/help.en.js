// English versions of help.js (K-03). Keys match help.js; numbers come from N exactly like the Korean text.
import { N } from './numbers.js';

export const CATEGORY_DESC_EN = {
  start: 'Ways to create an account and log in',
  cloud: 'Paste a link and let our servers fetch it for you',
  files: 'Organizing, search, trash, uploads and downloads',
  play: 'Video playback, quality, subtitles and external players',
  share: 'Share links and share codes',
  vault: 'An encrypted space only you can open',
  quota: 'Monthly and daily limits, and the connected-app cap',
  premium: 'Plan comparison, payment methods, refunds and what happens after expiry',
  rewards: 'Friend invites, coupon codes and daily check-in',
  integrations: 'WebDAV, CLI, MCP, Telegram and the browser extension',
  account: 'Security settings, inactive accounts, closing and restoring your account',
  safety: 'Reporting harmful content, copyright notices and appeals',
  apps: 'Install on your phone, PC, TV or browser',
};

export const ARTICLES_EN = {
  // ---------- Sign up & log in ----------
  'signup-methods': {
    title: 'How to sign up for Mimic',
    body: `You can sign up and log in to Mimic in any of the six ways below. Whichever one you start with, you get the same drive.

- Continue with Google
- Log in with Facebook
- Sign in with Apple — choosing "Hide My Email" works fine too.
- Phone number — pick your country code (+82 for Korea) and enter the code we text you. If the number is new to us, your account is created on the spot.
- Email — confirm the verification code, then set a password. Passwords must be 6–16 characters mixing letters, numbers and symbols.
- QR code — scan the QR code on screen with the Mimic phone app you're already logged in to, then approve.

## What you get right away
- ${N.freeStorage} of free storage
- A default "My Pack" folder with a how-to video
- ${N.freePerDay} free cloud downloads a day, plus ${N.signupBonus} sign-up bonus downloads

If you sign up with a social account, you start without a password. You can create one later under [Account & security > Password] if you need it.`,
  },
  'login-trouble': {
    title: "When you can't log in",
    body: `If you can't log in, check the following in order.

1. Make sure you're using the method you signed up with. If you signed up with your phone, email login won't work (link an email under Account & security to use both).
2. For an email account, use "Forgot password" on the login screen to get a verification code and set a new password.
3. Verification codes are valid for 5 minutes, and you can request a new one after 60 seconds.
4. Too many wrong attempts in a short time will block login for a while. Wait a bit, then try again.

If you can no longer use your old phone number or email, reach out via [Contact us] with something that shows the account is yours.`,
  },
  'qr-login': {
    title: 'Log in with a QR code',
    body: `Typing a password on a PC or TV is a hassle, so try QR login instead.

1. Choose "QR login" on the login screen and a QR code appears.
2. Scan it with the Mimic phone app you're already logged in to.
3. Check the device details on the approval screen in the app and tap "Approve".

The QR code expires after a few minutes and works only once. If an approval screen appears that you didn't ask for, never approve it.`,
  },
  // ---------- Cloud download ----------
  'what-is-cloud-download': {
    title: 'What is cloud download?',
    body: `Cloud download lets Mimic's servers fetch files for you instead of your device. Hand over a link and you can even switch your device off: the server keeps downloading and puts the files in your drive.

## Links you can add
- Magnet links (magnet:)
- Torrent files (.torrent)
- HTTP and HTTPS addresses that point straight to a file
- Post URLs from social sites such as YouTube, X, TikTok and Facebook (videos and images are extracted)

Fetched files are stored only in the Mimic cloud of the person who added the link. Nobody else can see them and they aren't redistributed. To get them onto your device, download them from your drive.

## Limits and concurrent tasks
- Free: ${N.freePerDay} a day (plus ${N.signupBonus} sign-up bonus), ${N.freeTasks} at a time
- Premium: unlimited, ${N.premiumTasks} at a time`,
  },
  'add-links': {
    title: 'How to add links and torrents',
    body: `1. Click the "Cloud download" button at the top left of your drive.
2. Paste your link. For several links, put one per line and they're all added at once.
3. If you have a torrent file, choose it in the same window.
4. Pick a destination folder and click "Start".

Track progress on the "Cloud download" tab of the transfer panel at the bottom right. We'll notify you when it's done.

## Torrent task rules
- One task can hold up to ${N.btMax} files.
- You can't pick just some of the files inside a torrent.
- With "BT smart filter" on, extras that look like promo txt or url files or short ad videos aren't saved. You can turn it off under [Settings > Transfer].`,
  },
  'instant-complete': {
    title: 'Why do some tasks finish instantly?',
    body: `Mimic keeps only one copy of each file on its servers. If a file matches one someone has already fetched, by content hash or torrent infohash, it's linked straight into your drive instead of being downloaded again.

That's why popular files switch to "Done" within seconds. Once a file is in your drive it's managed as yours, so it stays put even if someone else deletes theirs.`,
  },
  'failed-tasks': {
    title: 'When a task fails or is blocked',
    body: `Click a failed task in the transfer panel to see why.

- The link has expired or the source site isn't responding — try again with another link.
- Nobody is sharing the torrent right now — it may work again later.
- Not enough storage — free up some space or get more with Premium.
- You've used today's free downloads — they refill at midnight Korea time.
- The link is blocked — saving it has been stopped because of a rights-holder notice or our policies.

If you think a block is a mistake, click "Appeal" in the task details or tell us on the [Reports & appeals] page. Our team will review it and send you the result as a notification.`,
  },
  // ---------- Files ----------
  'file-menu': {
    title: 'What you can do from the file menu',
    body: `Right-click a file or folder (long-press on a phone) to open its menu.

- Open, Open in external player
- Share, Favorite
- Details — size, location, source and download link
- Download to device
- Move, Copy, Rename, Delete

Select several items and a toolbar appears at the bottom of the screen. On a keyboard, Shift+S opens the share window straight away.`,
  },
  trash: {
    title: 'Trash and permanent deletion',
    body: `Deleted files go to the trash first and are kept for ${N.trashDays} days. You can restore them any time during that period.

- After ${N.trashDays} days they're permanently deleted automatically.
- Files in the trash still use storage. To get the space back right away, delete them from the trash.
- Permanently deleted files can't be recovered.`,
  },
  'upload-download': {
    title: 'Uploading and downloading to your device',
    body: `## Upload
Click "Local upload" or drag files onto your drive. By default 3 files upload at a time, and failed uploads are retried automatically (you can change this in Settings). What you upload counts toward your monthly upload quota.

## Download to your device
Choose "Download to device" from the file menu. Interrupted downloads pick up where they left off, and what you download counts toward your downstream quota. Free accounts can download up to ${N.freeDailyDown} a day.`,
  },
  'search-sort': {
    title: 'Search, sort and change the view',
    body: `- Search: type part of a name in the search bar at the top (Ctrl+F) to search your whole drive.
- Sort: by name (A–Z or Z–A), newest, oldest, largest or smallest, and choose whether folders stay on top.
- View: switch between list and grid (thumbnails).

Under [Settings > General], choose whether sort order and view are remembered per folder or applied to your whole drive.`,
  },
  // ---------- Playback ----------
  'online-playback': {
    title: 'Online playback and video quality',
    body: `Videos in your drive play right away, no download needed.

- Free: up to 720p
- Premium: original quality (including 4K)

In the player you can change quality, set the speed to 0.5, 1.0, 1.25, 1.5, 2.0 or 3.0x, jump to the previous or next file, and share or favorite. Where you stopped is saved in your watch history so you can pick up later.

Playback also counts toward your downstream quota.`,
  },
  subtitles: {
    title: 'Switch subtitles and audio tracks',
    body: `If a video has built-in subtitles, they appear automatically in the player's subtitle menu. An srt or vtt file with the same name in the same folder shows up there too.

For videos with several audio tracks (for example original and dubbed), switch between them in the audio menu.`,
  },
  'external-player': {
    title: 'Open in an external player',
    body: `To watch in another player such as the Mimic desktop app, VLC or PotPlayer, choose "Open in external player" from the file menu. A short-lived playback address is created and handed to the player you pick.

The address stops working after a while. Don't pass it on to anyone else.`,
  },
  // ---------- Sharing ----------
  'create-share': {
    title: 'Create a share link',
    body: `1. Select the files or folders to share and click "Share".
2. Choose how long it lasts: permanent, 7 days, 14 days or 30 days.
3. Turn on a password so only people who have both the link and the password can open it. With it off, anyone with the link can view it.
4. Click "Create link", then copy and send it.

Recipients can view the files, play videos and save them to their own Mimic drive. You can see the shares you've made under [My shares] and cancel them at any time.

Sharing illegally filmed content or files that infringe others' rights can get the link blocked and your account restricted.`,
  },
  'share-code': {
    title: 'Find a share by code',
    body: `Every share also gets a short share code made of numbers, letters and symbols. Recipients can enter the code in Mimic's search bar to go straight to the share.

Under [Settings > General > Share code display], choose whether content found by code opens right away or shows a warning first.`,
  },
  // ---------- Vault ----------
  'vault-intro': {
    title: 'What makes the vault different?',
    body: `The vault is a separately locked space for Premium members.

- Files are encrypted on your device (AES-GCM) before they're uploaded. Only the encrypted data reaches our servers, so not even Mimic's staff can see what's inside.
- Its storage is kept separate from your regular drive.
- Each share needs its own share key. Sending the link and the key separately is safer.

If you forget your passcode, Mimic can't recover your files either. Be sure to write your passcode down somewhere safe.`,
  },
  'vault-lock': {
    title: 'Passcode and auto-lock',
    body: `You set a dedicated passcode the first time you open the vault. In the phone app you can also use fingerprint or face unlock.

The vault locks automatically when:
- you close the app or switch to another app
- there's no activity for the time you've set
- you tap "Lock now"`,
  },
  // ---------- Transfer quota ----------
  'monthly-quota': {
    title: 'Monthly transfer quota',
    body: `Your transfer quota is how much data you can move in a month. Every member gets the same amount each month, and it refills on the 1st of the next month (Korea time). Unused quota doesn't carry over.

- Cloud download: ${N.mCloud}
- Downstream (playback and downloads to your device): ${N.mDown}
- Upload: ${N.mUp}

Your base quota is used first, then any extra quota you've bought. See usage for each item under [Settings > Transfer quota]. Uploads may count as less than the file size because of compression.`,
  },
  'free-daily-limits': {
    title: 'Daily limits for free members',
    body: `Free members have daily limits on top of the monthly quota. They refill every day at midnight Korea time.

- Cloud download: ${N.freePerDay} a day (the ${N.signupBonus} sign-up bonus downloads can each be used once on top of that)
- Downstream: ${N.freeDailyDown} a day

Once the day's downstream is used up, downloads don't stop; they slow to about ${N.slow}. Premium has no daily limits.`,
  },
  'app-quota': {
    title: 'Connected-app quota cap',
    body: `Everything you transfer outside the official Mimic apps, such as WebDAV, the CLI and third-party apps, can together use up to ${N.appShare}% of each monthly quota. This cap isn't extra quota; it's a share of your monthly quota.

Once you go over the cap
- downloads slow to about ${N.slow}, and
- uploads and new cloud downloads are blocked (tasks already running keep going).

Free members can download up to ${N.freeAppDown} a day through connected apps. The Mimic website and official apps aren't subject to this cap.

If you hit the cap sooner than expected, check [Account & security > Connected apps] to make sure your account isn't being shared and no app you don't recognize is connected.`,
  },
  // ---------- Premium & billing ----------
  'premium-benefits': {
    title: 'Free vs Premium',
    body: `- Storage: Free ${N.freeStorage} / Premium ${N.premiumStorage}
- Cloud download: Free ${N.freePerDay} a day / Premium unlimited
- Concurrent tasks: Free ${N.freeTasks} / Premium ${N.premiumTasks}
- Daily downstream: Free ${N.freeDailyDown} / Premium no daily limit
- Video quality: Free 720p / Premium original
- Vault, online unzip, WebDAV, high-speed download: Premium only
- Ads: shown on Free only

The monthly transfer quota (cloud ${N.mCloud}, downstream ${N.mDown}, upload ${N.mUp}) is the same for everyone.`,
  },
  'payment-methods': {
    title: 'Payment methods and auto-renewal',
    body: `You can choose an auto-renewing monthly or yearly subscription, or a one-time 1-month or 1-year pass.

- Subscriptions are charged automatically on the same day each month or year. Cancel any time under [Subscriptions & purchases > Manage subscription]; you keep access until the end of the paid period.
- Buying a one-time pass while subscribed extends your membership by that much.
- First-purchase discounts are limited to one per account.
- Before a price goes up or a free trial turns into a paid plan, we tell you in advance and ask for your consent.
- In Korea you pay in Korean won; elsewhere you pay in US dollars. Dollar prices are the won price converted at that day's exchange rate, so they can change slightly from day to day.
- Outside Korea you can pay with international cards (Visa, Mastercard, JCB, UnionPay, AMEX), PayPal or Alipay. Subscriptions paid this way don't renew automatically, so pay again before your period ends.

If you paid but the benefits haven't shown up, send us the payment time and order number via [Contact us].`,
  },
  refund: {
    title: 'Refunds and withdrawal',
    body: `Mimic handles refunds in line with Korea's e-commerce consumer protection law.

- You can withdraw from a purchase (full refund) within 7 days of payment. If you've already used Premium features, we may deduct what you used from the refund.
- If you were charged in error, tell us within 30 days of noticing and we'll refund it in full once we've checked.
- If you cancel a subscription, you won't be charged again, and you can use the period you've already paid for until it ends.
- If you paid through an app store (Google Play or the App Store), follow that store's refund process.

Request a refund from [Subscriptions & purchases] or [Contact us]. The full rules are in the membership terms.`,
  },
  'after-expiry': {
    title: 'What happens when Premium ends?',
    body: `Your files aren't deleted the moment Premium ends. Here's what happens, in order.

1. You become a free member. You can still log in and organize your files.
2. If you're using more than the free storage (${N.freeStorage}), uploads, new cloud downloads and saving new files are blocked.
3. From ${N.playStop} days after expiry, online playback stops and downloads to your device slow to ${N.slow}.
4. If you stay over the limit for ${N.overMonths} months, we give you a ${N.warnMonths}-month grace period and remind you several times.
5. If it still isn't sorted out, the excess is deleted over the following ${N.delWindow} days, starting with the files modified longest ago. Files deleted this way can't be recovered.

Extra storage you bought is paused when Premium ends and comes back when you subscribe again.`,
  },
  // ---------- Rewards ----------
  'invite-rewards': {
    title: 'Friend invite rewards',
    body: `If a friend signs up with your invite link or referral code and buys Premium within ${N.refWindow} days, you get ${N.refRate}% of the days they bought as Premium days. For example, if your friend buys a 1-year subscription, you get about 128 days.

- For every ${N.refEvery} invited friends who buy in a month, you get an extra ${N.refBonus} of upload quota (up to ${N.refMax}, valid until the end of the next month).
- Your friend's invite has to be linked within ${N.refBind} hours of signing up to count.
- Subscriptions, in-app purchases and Premium codes count as purchases; free codes and gifted periods don't.
- Rewards are taken back if we find abuse, such as creating several accounts on one device.

## Referral Program Pro

Switch to Referral Program Pro on the [Invite friends] screen to earn a share of what your friends pay as cash instead of Premium days. Once your balance reaches the minimum, you can request a payout to PayPal or a Korean bank account.

- The switch is permanent: you can't go back to Premium-day rewards.
- If a friend's payment is refunded or found to be abuse, that reward is taken back; if you've already been paid, it is deducted from future rewards.

Track your invites on the [Invite friends] screen.`,
  },
  coupon: {
    title: 'Redeem a coupon code',
    body: `Click "Coupon code" at the top of your drive and enter the code; the Premium time is added right away.

- You can redeem codes on the web, on Android and in the desktop app. Apple's policies don't allow redeeming in the iOS app.
- Only codes issued by Mimic or received from official partners work.
- Each code can be used once, and expired codes can't be redeemed.`,
  },
  'check-in': {
    title: 'Get Premium with daily check-in',
    body: `Install the Mimic browser extension and press the check-in button every day to earn free Premium time. The [Check-in guide] page walks you through the steps.`,
  },
  // ---------- Integrations ----------
  webdav: {
    title: 'Connect with WebDAV',
    body: `With WebDAV on, you can open your Mimic drive like a network drive in programs such as File Explorer, Finder, video players and NAS devices. It's a Premium feature.

1. Turn on WebDAV under [Settings > Access & integrations].
2. Enter the address and dedicated account details shown on screen into the program you want to use.

You can't permanently delete files or empty the trash over WebDAV. Data moved over WebDAV counts toward the connected-app quota cap (${N.appShare}%).`,
  },
  'cli-mcp': {
    title: 'CLI and MCP (connecting AI tools)',
    body: `## CLI
A tool for working with Mimic from the command line. Run "auth login" and a browser opens; approve there and you're logged in without typing your password into the terminal. For unattended use on a server, use a personal access token. You can list files, upload and download, share, and add cloud downloads.

## MCP
A way to connect AI tools such as Claude and ChatGPT so they can browse and organize your drive. Connect under [Settings > Access & integrations > MCP], and disconnect any time.`,
  },
  telegram: {
    title: 'Save with the Telegram bot',
    body: `Link your account to the Mimic Telegram bot and the links and files you send it are saved to your drive.

- Files the bot receives are collected in the "My telegram" folder (you can turn off the dedicated folder under [Settings > Transfer]).
- Send /settings to the bot to unlink it.`,
  },
  extension: {
    title: 'Use the browser extension',
    body: `The Mimic extension for Chrome and Edge finds downloadable links and videos on the page you're viewing and saves them to your Mimic drive in one click. If you can't install it from the store, get the offline installer under [Apps > Browser extension].`,
  },
  tokens: {
    title: 'Personal access tokens and connected-app permissions',
    body: `A personal access token is a key that lets scripts or other apps use Mimic as you.

- Pick an expiry between 30 days and 1 year (90 days by default). Tokens that never expire can't be created.
- The token value is shown only once, when you create it. If you lose it, create a new one.
- For your security, we email you whenever a token is created.

Connected apps can be given six levels of permission: read files / read & write / manage (including moving to and restoring from the trash) / permanent delete (not granted by default) / services (cloud download and sharing) / account (invites and settings). Grant only what's needed, and disconnect apps you don't use under [Connected apps] right away.`,
  },
  // ---------- Account & security ----------
  'account-security': {
    title: 'The Account & security menu',
    body: `[Account & security] in the profile menu has 7 tabs.

- Account info: profile picture and name
- Password: change it or create one
- Phone & email: link or change
- Facebook account: link or unlink
- Connected apps: list and remove tokens and connected apps
- Close account: request account deletion

If you see an unfamiliar device in the list of logged-in devices, log it out right away and change your password.`,
  },
  'delete-account': {
    title: 'Closing and restoring your account',
    body: `When you request deletion under [Account & security > Close account], your account goes inactive immediately.

- Log in again within ${N.deleteGrace} days of your request to cancel the deletion and keep using your account as before.
- After ${N.deleteGrace} days, your files and account details are all erased and can't be recovered.
- Once deletion is complete, you can sign up again with the same phone number or email.
- Any remaining Premium time is lost when you close your account. If you need a refund, contact us before closing it.

If there are signs of illegal activity or the account may have been taken over, we can pause deletion until our review is done.`,
  },
  dormant: {
    title: 'Cleanup of long-unused accounts',
    body: `A free account that hasn't logged in once in ${N.dormantMonths} months becomes due for cleanup.

1. We notify you first by email and app notification.
2. Log in within ${N.dormantGrace} days of the notice to cancel the cleanup.
3. If you don't log in, the account and its files are deleted.

Accounts that haven't logged in for more than ${N.hardYears} years and can't be reached through their registered contact details may be cleaned up without notice. Time with Premium doesn't count as inactive time.`,
  },
  'account-sharing': {
    title: "Why you shouldn't share your account",
    body: `A Mimic account is meant for one person. If we detect signs that several people are sharing one account, it's suspended for 24 hours for security.

To share files with family or friends, use share links.`,
  },
  // ---------- Reports & copyright ----------
  'report-content': {
    title: 'Report illegal or harmful content',
    body: `If you find illegally filmed content, child abuse material, violent or hateful material, or scams and malicious files in a share link or file, tell us through [Report]. You don't need to be logged in.

- Choose what you're reporting (share link, file, web address or user) and why.
- Our team reviews it and takes action such as blocking the link, blocking the file hash or suspending the account.
- If you reported while logged in, we'll notify you of the outcome.

Content that harms children is handled first and reported to the relevant authorities.`,
  },
  'copyright-notice': {
    title: 'Report copyright infringement',
    body: `If a work you hold the rights to is being shared on Mimic without permission, let us know on the [Copyright report] page.

What we need
- Name of the rights holder (or their agent) and an email address where we can reach you
- Which work it is
- Where the infringement is (share link, magnet, URL and so on) — one per line if there are several
- Confirmation that your report is accurate and that you hold the rights

We'll send a confirmation email once we receive it, and block the links and files when our review is done. Accounts that infringe repeatedly are restricted.`,
  },
  appeal: {
    title: 'Appeal a block',
    body: `If you think your link, share or account was blocked by mistake, you can appeal.

- Blocked cloud download: click "Appeal" in the task details in the transfer panel.
- Restricted share link or account: choose "Appeal" on the [Reports & appeals] page and explain why.

Our team takes another look. If the block was a mistake we lift it right away, and we'll notify you of the outcome either way.`,
  },
  // ---------- Apps ----------
  'install-apps': {
    title: 'Install Mimic on each platform',
    body: `Mimic works in plenty of places besides the web. Pick your platform on the [Apps] page.

- Phone: Android (APK, Google Play, Galaxy Store) and iOS. For now you can add the website to your home screen and use it like an app.
- PC: Windows 10 and 11 (with a separate build for older Windows), macOS (Apple silicon and Intel builds)
- TV: a dedicated Android TV app
- Browser extension: Chrome and Edge
- Command-line tool (CLI)

Platforms without an official installer yet are marked "Coming soon".`,
  },
  'tv-setup': {
    title: 'Watch Mimic on TV',
    body: `1. In your TV's browser, open the Mimic address with /tv added to the end (once the TV app is out, just install it).
2. Scan the QR code on screen with your logged-in phone app and approve.
3. Move between tiles with the remote's arrow keys and open one with the OK button.

Recent videos, all files and watch history appear as large tiles, so choosing from the sofa is easy.`,
  },
};
