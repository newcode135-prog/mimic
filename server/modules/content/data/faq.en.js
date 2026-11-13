// English FAQ (K-01), keyed by the ids in faq.js. Mimic's own wording
import { N } from './numbers.js';

export const FAQ_EN = {
  what: { cat: 'Service', q: 'What is Mimic?', a: `Mimic is a cloud drive. Paste a magnet, torrent, web address or social media post link and Mimic's servers fetch it into your cloud, ready to play, organize and share on the web and in the apps.` },
  free: { cat: 'Service', q: 'Can I use it for free?', a: `Yes. Every account gets ${N.freeStorage} of space and ${N.freePerDay} cloud downloads a day for free, plus ${N.signupBonus} bonus downloads when you sign up.` },
  'device-off': { cat: 'Cloud download', q: 'Does the download keep going if I turn off my computer?', a: 'Yes. Mimic\'s servers do the fetching, so it carries on with your device off, and we notify you when it finishes.' },
  instant: { cat: 'Cloud download', q: 'Some tasks finish in seconds. Is that normal?', a: 'Yes. If the same file is already on our servers, we link it straight to your drive instead of fetching it again.' },
  multi: { cat: 'Cloud download', q: 'Can I add several links at once?', a: 'Yes. Put one link per line in the cloud download box and they are all added together.' },
  'bt-limit': { cat: 'Cloud download', q: 'Can I pick only some files from a torrent?', a: `For now the whole torrent is fetched. One task can hold up to ${N.btMax} files, and the smart filter skips ad files bundled with it.` },
  blocked: { cat: 'Cloud download', q: 'It says "Blocked link".', a: 'Saving from this link was blocked after a rights holder notice or under our policies. If you think the block is a mistake, file an appeal from the task details.' },
  'where-saved': { cat: 'Cloud download', q: 'Can other people see the files I fetch?', a: 'No. Files are saved only to the Mimic cloud of the person who added the link, and nobody else sees them unless you share them.' },
  quality: { cat: 'Playback', q: 'What quality can free members watch in?', a: 'Free members can watch up to 720p. Premium plays the original quality.' },
  subtitle: { cat: 'Playback', q: 'How do I use a subtitle file?', a: 'Put an srt or vtt file with the same name in the same folder as the video and it shows up in the player\'s subtitle menu.' },
  trash: { cat: 'Files', q: 'Can I get deleted files back?', a: `You can restore them from the trash within ${N.trashDays} days. After that they are deleted permanently.` },
  'space-back': { cat: 'Files', q: 'I deleted files but my usage did not go down.', a: 'Files in the trash still take up space. Delete them permanently from the trash and your usage drops right away.' },
  'share-expire': { cat: 'Sharing', q: 'How long does a share link stay open?', a: 'You choose when you create it: forever, 7 days, 14 days or 30 days. You can also cancel it anytime in [My shares].' },
  'quota-what': { cat: 'Quota', q: 'What is the transfer quota?', a: `It is how much you can move in a month. Everyone gets ${N.mCloud} of cloud download, ${N.mDown} of downstream and ${N.mUp} of upload each month, refilled on the 1st.` },
  slow: { cat: 'Quota', q: 'My downloads suddenly got slow.', a: `Free members are slowed to about ${N.slow} after using their ${N.freeDailyDown} daily downstream, and so is anyone over the connected app cap. The daily limit refills at midnight Korea time.` },
  refund: { cat: 'Billing', q: 'Can I get a refund?', a: 'You can withdraw your purchase within 7 days of paying (what you have used may be deducted). If you were charged by mistake, tell us within 30 days and we refund it in full.' },
  cancel: { cat: 'Billing', q: 'Does Premium end as soon as I cancel my subscription?', a: 'No. Only the next payment stops, and you keep Premium until the period you already paid for ends.' },
  expire: { cat: 'Billing', q: 'Are my files deleted when Premium ends?', a: `Not right away. Only if you stay over your space for a long time do we clean up the excess, after several notices. The help article has the full steps.` },
  'coupon-ios': { cat: 'Rewards', q: 'I cannot redeem a coupon in the iPhone app.', a: 'Apple\'s rules do not allow coupons in the iOS app. Please redeem it on the web or in the Android or desktop app.' },
  invite: { cat: 'Rewards', q: 'What do I get for inviting friends?', a: `You get ${N.refRate}% of the Premium days a friend buys within ${N.refWindow} days of signing up, added to your own Premium.` },
  'vault-lost': { cat: 'Security', q: 'I forgot my vault passcode.', a: 'Vault files are encrypted on your device, so even Mimic cannot open them without the passcode. Please keep your passcode somewhere safe.' },
  privacy: { cat: 'Security', q: 'Does Mimic look at my files?', a: 'We never use your file contents for ads or AI training. We check files only through a set process when content is reported or the law requires it. Not even our staff can open vault files.' },
  delete: { cat: 'Account', q: 'Is my account deleted right away?', a: `For ${N.deleteGrace} days after you request it, signing in again restores your account. After ${N.deleteGrace} days, all your data is deleted.` },
  copyright: { cat: 'Reports', q: 'My work is being shared on Mimic.', a: 'Tell us about your work and the infringing addresses on the [Copyright notice] page. We block them once confirmed and email you the result.' },
};
