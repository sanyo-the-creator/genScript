# "Comment GUIDE" funnel — captions + DM flow

## How it plugs into the existing pipeline
metaUpload.js builds the IG caption from `<name>.json` -> `caption` (else title/description/tags),
capped at 2200 chars (metaUpload.js:312, :327). So the only change needed for the captions below
is writing them into the `caption` field of each clip's JSON. No scheduler code change.

## Caption variants (CTA at the end, hook stays first line)

1.
comment "guide" and i'll send you exactly how i quit 🌽 (took me 4 months, i'm 8 months clean now)

2.
if you're on day 1 again... comment "GUIDE" and i'll dm you the setup that finally worked for me 🌽

3.
i tried willpower for 3 years. it never worked. what worked was making it physically impossible.
comment "guide" for the full setup 🌽

4.
the reason you keep relapsing isn't discipline. it's access.
comment "guide" and i'll send you how i cut mine off 🌽

5.
8 months clean. no accountability partner, no cold showers, no cope.
just 2 changes on my phone + pc. comment "guide" 🌽

6.
relapsed 40+ times before this. comment "guide" and i'll send the exact thing that broke the loop 🌽

7.
you don't need more motivation. you need less access.
comment "GUIDE" and i'll dm you my phone + pc setup 🌽

8.
day 1 of quitting 🌽 is easy. day 4 is where you lose.
comment "guide" and i'll send you what to do on day 4.

9.
this is the setup i wish someone sent me at 16.
comment "guide" 🌽

10.
if i had to quit 🌽 again from zero, i'd do these 2 things in the first 10 minutes.
comment "guide" and i'll send them.

Notes:
- Keep the trigger word literally "guide" so matching is case-insensitive contains.
- Do NOT put app links in the caption. Links in comments/captions tank IG reach; the DM carries them.
- Pin your own comment "commented guide? check your requests folder 📩" under each post.

## DM flow (2 steps — platform question first, guide second)

STEP 1 — auto-reply to the comment (private reply):
> yo, saw your comment 🙏
> before i send it — are you on iPhone or Android? the setup is slightly different.
> just reply "iphone" or "android"

(Public comment reply, optional: "sent it 📩")

STEP 2a — iPhone:
> here's exactly what i did 👇
>
> 1. PHONE — i use the Upshift app with strict mode on. the point is that once it's on,
> there's no way to delete it or bypass it when an urge hits. the regular apple adult
> filters and basic web blockers never worked for me because i'd just turn them off
> whenever i got a bad urge... not proud of it but that's the truth.
> https://apps.apple.com/us/app/upshift-1-productivity-app/id6749509316
>
> 2. PC — set your DNS to CleanBrowsing (the Family Filter one). it nukes basically all
> of those sites at the network level, before the browser even loads them.
> incognito, new browsers, none of it gets around it.
>
> 3. FIRST MONTH — this is the part people skip. every time a bad urge hits, you move.
> gym, run, 50 pushups, walk outside, cold shower. anything physical, immediately.
> the urge is ~10 minutes long. you're not fighting it forever, you're outlasting 10 minutes.
> after ~30 days the urges get way quieter, i promise.
>
> that's it. blocked access + a physical replacement. no willpower needed.
> if you actually start, dm me on day 7 and let me know 🤝

STEP 2b — Android: identical, swap the link:
> https://play.google.com/store/apps/details?id=com.upshift.app

Also add: mention @upshift.app (or whatever the brand handle is) in the DM once, so people can
find it without the link — links in DMs sometimes get flagged if you blast them.

## Tooling — verified September 2026

### ManyChat (verified on manychat.com/pricing)
Free = $0, **25 active contacts/month**, any 2 channels, max 4 active automations, 1 user,
ManyChat branding on messages. Comment-to-DM is a basic automation, so it technically works
on Free — but one Reel that pops gives you 25 people and then the funnel is done for the month.
Essential $14/mo = 250 contacts, Pro $29/mo = 2500, Business $69/mo = 7500, Advanced $139/mo = 25000.
Overage is billed per extra contact. An "active contact" = one person per month, regardless of
how many messages. Verdict: fine for testing the flow, not usable free at scale.

### CreatorFlow (verified on creatorflow.so/pricing)
Free forever, no card: 1 Instagram account, **500 automated DMs/month**, comment-to-DM,
story reply automation, unlimited keyword triggers, unlimited active automations.
Pro $12-15/mo = 5000 DMs. Best free tier found for this use case.

### LinkDM (verified on linkdm.com/pricing)
Free: 1 account, **1000 DMs/month**, Posts & Reels auto-reply, story automations — but
LinkDM branding stays, and "Comment Auto-Reply" + "Universal Triggers" are Pro-only ($19/mo).
So on Free you wire the trigger **per post**, you cannot set one account-wide keyword.
Higher DM cap than CreatorFlow, more manual work per scheduled video.

### Others seen but not verified
ReplyKaro, ReplyRush, InstantDM, UnlockDM — every "comparison" article about these is written
by one of the vendors themselves. Do not trust their numbers; check the pricing page directly.

### Rule that applies to all of them
Use only tools built on the official Meta API. Anything that logs into your account with your
password to post/DM is what gets accounts actioned.

## Self-hosted (Meta docs, verified)

Doable, but "free and without problems" is not accurate — the blocker is Meta review, not money.

- Private reply to a comment: POST /<PAGE_ID>/messages with the comment id as recipient.
- Permissions: instagram_manage_comments + pages_messaging (Facebook Login), or
  instagram_business_basic + instagram_business_manage_messages / _manage_comments (Instagram Login).
- **Only ONE message may be sent per comment.** Continuing the conversation requires the user to
  reply first, which opens the standard 24h window.
- Window: 7 days from comment creation for posts/reels (live broadcasts: only while live).
- Rate limit: 750 private-reply calls per hour per IG professional account.
- Webhooks: the `comments` field requires **Advanced Access**, the app must be **Live**, business
  verification is required, and the IG professional account must be **public**.
- Advanced Access = Meta App Review with a screencast and a written use case. This is the real
  cost. Expect days-to-weeks and possible rejections.

The one-message-per-comment rule is not a problem here, it is a gift: it maps exactly onto the
2-step flow above. Message 1 = "iPhone or Android?". Their answer opens the 24h window.
Message 2 = the guide with the right store link. You could not send both anyway.
