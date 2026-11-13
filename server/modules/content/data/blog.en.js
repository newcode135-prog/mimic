// English blog posts (K-02), keyed by the slugs in blog.js. Mimic's own wording
import { N } from './numbers.js';

export const POSTS_EN = {
  'hello-mimic': {
    title: 'Meet Mimic: paste a link, it lands in your cloud',
    tags: ['News'],
    summary: 'Let the server do the fetching and watch anywhere. Here is the problem Mimic was built to solve.',
    body: `Getting a large video or file used to mean leaving your computer on for hours. You could not close your laptop while it ran, and afterwards you still had to move the file to your phone or TV.

Mimic flips that around. Paste a link and Mimic's servers do the fetching, straight into your cloud. Then just play it on your phone, PC or TV, with nothing to download first.

## Three promises Mimic keeps
- Yours stays yours: files fetched from links you add are saved only to your cloud.
- No waiting: files already on our servers are linked instantly instead of fetched again.
- No peeking: we never use your file contents for ads or AI training, and the vault is encrypted so not even our staff can open it.

## Start for free
Sign up and you get ${N.freeStorage} of space and ${N.freePerDay} cloud downloads a day right away. When you need more space or original quality, choose Premium then.

Mimic is in beta. Tell us what bothers you or what you would like to see through [Contact us] or Feedback in the account menu.`,
  },
  'cloud-download-tips': {
    title: 'Cloud download tips for less effort',
    tags: ['How-to'],
    summary: 'From adding many links at once to sending them from Telegram or the browser extension, here are ways to save a few clicks.',
    body: `## 1. One link per line
Paste links on separate lines in the cloud download box and they are all added at once. Pick the save folder first and there is less tidying up later.

## 2. Make folders first
Create folders like "Shows", "Lectures" and "Files" and choose where each task saves, so nothing needs moving once it is done.

## 3. Send straight from the browser extension
Spot a link or video while browsing? Click the Mimic extension icon. It lists the links found on the page, and the ones you pick go straight to your cloud.

## 4. On your phone, use the Telegram bot
Found a link on your phone? Forward it to the Mimic Telegram bot. Files it fetches collect in the "My telegram" folder.

## 5. Make your free tasks go further
Free members can create up to ${N.freePerDay} tasks a day. A torrent with many files is fetched in one task, so a bundled torrent is the better choice for a series.

## 6. Play as soon as it is done
Finished videos play right away without downloading. Put a subtitle file with the same name in the same folder and it is attached automatically.

Fetching or spreading content you have no rights to is against the law. Mimic blocks links reported by rights holders.`,
  },
  'understanding-quota': {
    title: 'Transfer quota made simple',
    tags: ['Guide'],
    summary: 'What the monthly quota, the daily limit and the connected app cap are, and how each is counted, with examples.',
    body: `In Mimic, "quota" is not the same as storage. If storage is the size of your warehouse, quota is how much can pass through its doors in a month.

## Three monthly quotas
- Cloud download ${N.mCloud}: what our servers fetch from outside links
- Downstream ${N.mDown}: what you play or download to your devices
- Upload ${N.mUp}: what you upload from your devices

Every member gets the same amounts each month, refilled on the 1st, Korea time. Unused amounts do not carry over.

## Daily limit for free members
Free members have a daily downstream of ${N.freeDailyDown}. Watching a 4GB video five times, for example, uses up that day's limit. Past the limit you are not cut off, just slowed to about ${N.slow}, and full speed returns after midnight.

## Connected apps have their own cap
Usage through connected apps such as WebDAV or the CLI is capped at ${N.appShare}% of each monthly quota combined. Of your ${N.mDown} downstream, for example, only ${N.appShare}% can go through connected apps, and the rest is for the Mimic website and official apps.

## Need more?
Extra transfer quota is available. A 1-month pack applies only to the month you buy it, and a 1-year pack adds to each month for 12 months. Your base quota is used first, then the extra.

See how much you have used so far, item by item, in [Settings > Transfer quota].`,
  },
};
