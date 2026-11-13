// English versions of the seven policy documents in policies.js (same slugs and section ids).
// Drafts written in Mimic's own words; legal review is needed before official publication.
import { N } from './numbers.js';

export const POLICIES_EN = {
  terms: {
    title: 'Terms of Service',
    sections: {
      purpose: { title: '1. Purpose', body: 'These Terms set out the rights, obligations and responsibilities of Mimic (the "Company") and its members when they use the cloud storage, cloud download, playback and sharing services the Company provides (the "Service").' },
      definitions: { title: '2. Definitions', body: `- Member: a person who has agreed to these Terms and created an account
- Cloud download: a feature in which the Company's servers fetch the file behind an external link a member submits and place it only in that member's storage
- Content: every file a member uploads or saves through cloud download
- Transfer quota: the amount of data that can be sent and received in a month or a day` },
      account: { title: '3. Accounts', body: `- Members must sign up with accurate information and use their account only themselves. If there are signs that several people are sharing one account, we may suspend its use for 24 hours.
- People under 14 may not sign up.
- Members are responsible for keeping their account details and password safe, and must tell the Company right away if they suspect someone else is using their account.` },
      service: { title: '4. Service and limits', body: `- Free members get ${N.freeStorage} of storage, ${N.freePerDay} cloud downloads per day and ${N.freeDailyDown} of downstream per day.
- Every member receives a monthly transfer quota of ${N.mCloud} for cloud downloads, ${N.mDown} for downstream and ${N.mUp} for uploads. Unused amounts do not carry over.
- To keep the Service running well, the Company sets quotas, speeds and the number of concurrent tasks, and gives notice 7 days before a change takes effect (30 days if the change is unfavorable to members).` },
      content: { title: '5. Responsibility for content', body: `- The rights to, and responsibility for, content belong to the member who saved it. The Company does not screen or vouch for what is behind the links members submit.
- Members must not store or share content that infringes anyone's copyright, image rights or personal information, or that is prohibited by law.
- The Company may block content from being stored, shared or played in response to reports from rights holders, requests made under law, or its blocklist.` },
      restrict: { title: '6. Restrictions on use', body: `The Company may restrict use in the following cases, after giving notice (or, if urgent, notifying afterwards):
- Copyright infringement has been confirmed repeatedly
- Illegal content, such as non-consensual intimate recordings or child sexual exploitation material, has been stored or shared
- Automated tools have been used to put excessive load on the Service or to get around quotas
- Another member's account has been used without permission, or rewards have been obtained by improper means

If you disagree with a restriction, you can ask for another review through the appeal process.` },
      withdraw: { title: '7. Account deletion and inactivity', body: `- Members may ask to delete their account at any time. Logging in again within ${N.deleteGrace} days of the request cancels the deletion; after that, all data is deleted.
- If a free account is not logged into for ${N.dormantMonths} months, we send a notice and remove the account and its files ${N.dormantGrace} days later.` },
      liability: { title: '8. Limitation of liability', body: `The Company is not liable for losses caused by natural disasters, by the member's own fault, or by problems with the original source behind an external link. The Company explains the scope of its backups separately and recommends that members also keep their own copies of important files.` },
      law: { title: '9. Governing law and disputes', body: 'These Terms are governed by the laws of the Republic of Korea. Any dispute will be settled in the court that has jurisdiction under the Civil Procedure Act. Business information: [To be added before official launch]' },
    },
  },
  privacy: {
    title: 'Privacy Policy',
    sections: {
      collect: { title: '1. Information we collect', body: `- Sign-up and login: email address or mobile number, password (stored only as a hash that cannot be reversed), social login identifiers
- Usage records: device, IP address and time of access, transfer volume, payment records
- Customer support: the name, email address and message you give when you contact us
- Reports and copyright notices: the email address for receiving the outcome, the rights holder's name, and the reported item (link or file) and details

We process file contents only to provide the Service (storage, playback and deduplication), and never use them for advertising or AI training.` },
      use: { title: '2. How we use it', body: `- Verifying members, preventing misuse and protecting accounts
- Providing storage, cloud download, playback and sharing features
- Handling payments and refunds, and keeping records required by law
- Announcements and notices of important changes (marketing messages only if you have separately agreed to them)` },
      keep: { title: '3. How long we keep it', body: `- When you delete your account, we destroy your information without delay once the grace period (${N.deleteGrace} days) has passed.
- Information we must keep by law is stored separately for the required period (for example, contract and payment records for 5 years, consumer complaint and dispute records for 3 years, and access logs for 3 months).
- Reports and copyright notices, even once resolved, are kept for 3 years from the date they were received. We then delete the email address and the rights holder's name, and keep only the reported item, the details and the outcome, to identify repeat infringement and for statistics. If the member who filed a report deletes their account, their contact details are deleted immediately.
- Free accounts that have not been used for ${N.dormantMonths} months are removed after advance notice.` },
      share: { title: '4. Sharing with third parties and outsourcing', body: `The Company does not give personal information to anyone else unless there is a legal basis or the member has agreed. To run the Service we may hand the tasks below to service providers, who will be listed before the official launch.
- Payment processing: [Payment gateway provider]
- Text message and email delivery: [Messaging service provider]
- If any information is transferred abroad, we will separately state the destination country, the items transferred and the period.` },
      rights: { title: '5. Your rights', body: 'Members may at any time ask to see, correct or delete their personal information, or ask us to stop processing it. Requests made from the [Account & security] screen or through [Contact us] are handled within 10 days.' },
      security: { title: '6. Security measures', body: `- All communication is encrypted in transit.
- Passwords, login tokens and verification codes are stored as hashes, never in their original form.
- Vault files are encrypted on the member's device, so not even the Company can see what is in them.
- Administrator access is limited to as few people as possible, and every administrative action is logged.` },
      children: { title: '7. Children under 14', body: 'Children under 14 may not sign up, and the Company does not collect personal information from children under 14.' },
      officer: { title: '8. Privacy officer', body: 'Name and contact details: [To be added before official launch]. You can also report privacy violations to bodies such as the Personal Information Infringement Report Center (118).' },
    },
  },
  membership: {
    title: 'Membership Terms',
    sections: {
      scope: { title: '1. Scope', body: 'These Terms apply to paid products such as the Mimic Premium subscription, one-time passes, extra storage and extra transfer quota. Pressing the payment button means you agree to these Terms.' },
      products: { title: '2. Products', body: `- Subscription: Premium billed automatically every month or every year
- One-time pass: a 1-month or 1-year pass with no automatic billing.
- Extra storage: usable only while you have Premium, and frozen when Premium ends.
- Extra transfer quota: the 1-month pack applies only in the month you buy it; the 1-year pack is granted every month for 12 months.` },
      billing: { title: '3. Payment and renewal', body: `- A subscription is billed automatically on the same cycle until you cancel it. We send a reminder before each renewal.
- A first-payment discount applies only once per account.
- Before a free trial turns into a paid plan or a price goes up, we tell you in advance and ask for your consent again. Without your consent, no automatic payment is made.
- Buying a one-time pass while subscribed extends your membership by the length of the pass.
- Members in Korea pay in Korean won and members elsewhere pay in US dollars. Dollar amounts are the won price converted at the exchange rate on the payment date. Subscriptions paid from outside Korea do not renew automatically.` },
      withdrawal: { title: '4. Withdrawal and refunds', body: `- You may withdraw from a purchase within 7 days of the payment date (Article 17 of the Act on the Consumer Protection in Electronic Commerce).
- If you have already used Premium benefits, we may refund the amount minus the part that covers the period and benefits used; we tell you this before you pay.
- If you were charged by mistake, tell us within 30 days of noticing it and we will refund the full amount after checking.
- For any period in which we could not provide the Service for reasons on our side, we make it up with extra days or a refund.
- If you paid through an app store, the store's refund process applies first.` },
      cancel: { title: '5. Cancelling', body: 'You can cancel a subscription at any time from [Subscriptions & purchases > Subscriptions]. Cancelling stops the next payment, and your benefits continue until the end of the period you have already paid for.' },
      expiry: { title: '6. After expiry', body: `When Premium ends, you become a free member. If your stored data is larger than the free storage, you can no longer save new files; online playback stops after ${N.playStop} days; and if you stay over the limit for ${N.overMonths} months, we may, after a ${N.warnMonths}-month grace period with notices, remove your oldest files until you are no longer over the limit.` },
      codes: { title: '7. Coupons and referral rewards', body: 'Premium time received from coupons or referral rewards cannot be exchanged for cash or refunded. However, members who choose Referral Program Pro receive referral rewards in cash instead of Premium time, and this choice cannot be undone. Cash rewards are paid by the Company after review when the member requests a payout. Rewards based on a payment that was later refunded, or obtained by improper means, will be taken back; if already paid, they are deducted from later rewards.' },
    },
  },
  'anti-abuse': {
    title: 'Anti-Abuse Policy',
    sections: {
      goal: { title: '1. Purpose', body: 'So that every member can use Mimic safely and fairly, this policy sets out what is prohibited and how the Company responds.' },
      forbidden: { title: '2. Prohibited behavior', body: `- Storing or spreading malware or phishing files
- Using share links for spam, fraud, or ads for illegal gambling or drugs
- Creating multiple accounts to inflate free limits or referral rewards
- Using unofficial tools to get around quota or speed limits, or sending excessive requests to our servers
- Selling or renting out an account, or sharing one account among several people
- Using another person's account or shares without permission` },
      detect: { title: '3. Detection', body: 'The Company automatically reviews usage records such as transfer volume, devices and request frequency to spot unusual activity. We open the contents of files only when handling a report or a legal request.' },
      action: { title: '4. Actions', body: `Depending on how serious the violation is, we may take the following actions one after another or together:
- Blocking share links, and blocking file hashes and links
- Restricting some features, or temporary suspension (24 hours when account sharing is detected)
- Taking back rewards obtained by improper means
- Terminating the account and restricting sign-up again` },
      appeal: { title: '5. Appeals', body: `If you disagree with an action, you can ask for another review from the [Reports & appeals] page or with the Appeal button in the task details. We will notify you of the reviewer's decision.` },
    },
  },
  'child-safety': {
    title: 'Child Safety Policy',
    sections: {
      zero: { title: '1. Zero tolerance', body: 'Mimic never allows content that sexually exploits or abuses children or teenagers, under any circumstances. Storing it, sharing it and passing on links to it are all prohibited.' },
      detect: { title: '2. Blocking and detection', body: `- We add the hashes and links of known illegal content to a blocklist so that it cannot be stored at all.
- Reports about share links are handled ahead of other reports.` },
      report: { title: '3. Reporting', body: `If you find such content, tell us through [Report] and choose "Child safety" as the reason. You can report without logging in, and the reporter's information is protected.` },
      response: { title: '4. Response', body: `- As soon as it is confirmed, we block the content and its share links and terminate the accounts involved.
- As required by law, we notify investigative agencies and other relevant authorities and preserve the necessary records.
- The number of cases handled is published in our transparency report.` },
      minor: { title: '5. Minor members', body: 'People under 14 may not sign up. The Company processes the personal information of minor members aged 14 and over only to the minimum extent necessary.' },
    },
  },
  copyright: {
    title: 'Copyright Policy',
    sections: {
      respect: { title: '1. Basic principles', body: `Mimic respects creators' rights. Members must store and share only content they hold the rights to or have permission to use. Cloud download is a feature that helps members save files for their own use, and downloaded files are kept only in that member's storage.` },
      notice: { title: '2. Infringement notices', body: `Rights holders or their agents can send the following through the [Copyright report] page:
- The rights holder's name and contact details (email)
- A description of the infringed work
- Where the infringement takes place (share link, magnet, URL, etc.)
- A statement that the notice is accurate and that you hold the rights

When a notice is received, we confirm receipt by email and tell you the outcome after review.` },
      takedown: { title: '3. Blocking', body: `- When infringement is confirmed, we block the share link and add the link, infohash and file hash to the blocklist so the content cannot be saved again.
- We tell the member concerned what action was taken and why.` },
      counter: { title: '4. Counter-notice (request to restore)', body: `A member subject to an action who believes they hold the rights, or that the use is legitimate, can file an appeal from [Reports & appeals]. As soon as it is received, the Company forwards the appeal by email to the person who filed the notice (the rights holder). Unless that person tells us within ${N.counterWaitDays} days of the forwarding date that they have taken legal action, such as filing a lawsuit, we lift the block after review.` },
      repeat: { title: '5. Repeat infringers', body: 'Members found to infringe repeatedly face escalating sanctions: a warning, restricted sharing, temporary suspension and, finally, account termination. As a rule, accounts with three or more confirmed infringements are terminated.' },
      false: { title: '6. False notices', body: 'If someone knowingly files a false notice without holding the rights, we restrict them from filing notices, and they are responsible for any resulting damage.' },
      report: { title: '7. Transparency', body: 'We regularly publish the number of copyright notices received and their outcomes in our transparency report.' },
    },
  },
  cookies: {
    title: 'Cookie Policy',
    sections: {
      what: { title: '1. What cookies are', body: 'Cookies are small text files that a website stores in your browser. Mimic uses cookies and browser storage only as far as is strictly necessary to provide the Service.' },
      kinds: { title: '2. Cookies we use', body: `- Staying logged in (essential): a session cookie that remembers that you are logged in. Our servers store it only as a hash, and it lasts up to 30 days.
- Display settings (functional): choices such as the interface language and sort and view options are remembered in browser storage.
- Advertising and tracking cookies: we do not use them.` },
      third: { title: '3. Third-party cookies', body: `When you use social login (Google, Facebook, Apple) or open a payment window, those companies' cookies may be used, and each company's own policy applies.` },
      control: { title: '4. How to refuse cookies', body: 'You can delete or block cookies in your browser settings. However, if you block the login cookie, you will not be able to log in to Mimic.' },
    },
  },
};
