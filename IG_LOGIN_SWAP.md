# Instagram scheduling: the manual login swap

## Why this is needed

Instagram is **not** an asset inside the Facebook login's Business Suite portfolio.
It is reached through its **own Business Suite login**.

Verified live on Jonathan Bale (debug Chrome, port 9202, 2026-08-25):

- `business.facebook.com/latest/settings/profiles` lists exactly two entries, both
  Facebook Pages: `Upshift: #1 Productivity App` and `Upshift`. No Instagram profile.
- The asset switcher agrees: "Other assets - 2 business assets", both Facebook.
- The account has no business portfolio at all; the home rail still offers
  "Create a business portfolio".
- The reels composer opens, but its "Post to" surface is the Facebook Page only.

So an IG asset can never appear in that switcher, no matter what gets "connected".
Earlier notes in this repo blamed a disconnected portfolio. That diagnosis was wrong.

The Instagram account itself **is** signed in on that same Chrome:
`instagram.com` shows `jonathanbale.upshift`. It is the *Business Suite* session that
is Facebook's, not Instagram's.

## The swap, step by step

Everything below happens in the character's own debug Chrome (Jonathan Bale = port
9202, profile `C:\Users\Jergus\yt-profile-9202`). Never do this in your normal Chrome.

### Before the Instagram pass

1. Make sure no scheduler is running against that port.
2. In the debug Chrome, go to `business.facebook.com`.
3. Sign out of the Facebook Business Suite session (profile menu > Log out).
4. On the login screen choose **Log in with Instagram** and sign in as the character's
   IG account (Jonathan Bale = `jonathanbale.upshift`). The Instagram session is
   already alive in this profile, so this is usually one click and no password.
5. Confirm you landed in the Instagram Business Suite: the top-left asset switcher
   should now show the IG profile, and `Settings > Profiles` should list it.
6. Run the Instagram pass:

```bash
node igUpload.js "C:\Users\Jergus\Desktop\Upshift\internalTools\charakteri\Jonathan Bale\videos" --port=9202 --ig-asset-name="jonathanbale.upshift" --dry-run
```

Drop `--dry-run` once the composer looks right. From the UI, pick the **Instagram**
platform for the character; the server passes `igAssetName` from the character record
automatically.

### After the Instagram pass, to get Facebook back

7. Sign out of the Instagram Business Suite session.
8. Sign back in with the Facebook account that owns the Pages.
9. Confirm `Settings > Profiles` lists `Upshift: #1 Productivity App` again.

The Facebook pass pins its Page explicitly (`--asset-name`), so if you forget step 8
the FB run aborts with exit 2 instead of posting somewhere unintended.

## What happens if you skip the swap

`metaUpload.js` fails the context switch and exits 2 before scheduling anything. It
prints the assets the current login actually has, which tells you immediately that you
are in the Facebook Business Suite rather than the Instagram one.

## Effect on scheduleAll.js

`scheduleAll.js` drives every platform on one Chrome in one run, so a platform list
containing both `fb` and `ig` cannot work unattended: the two need different logins.

Run the browser platforms in two commands with the swap in between:

```bash
node scheduleAll.js "<folder>" --port=9202 --platforms=youtube,fb,x --fb-asset-name="Upshift: #1 Productivity App"
```

then do the swap, then:

```bash
node scheduleAll.js "<folder>" --port=9202 --platforms=ig --ig-asset-name="jonathanbale.upshift"
```

If `ig` is left in a combined list without the swap, that one pass aborts (exit 2) and
the remaining passes still run. Nothing gets posted to the wrong account.

## Per-character configuration

`yt_characters.json` carries both names, so nothing is guessed:

```json
"fbAssetName": "Upshift: #1 Productivity App",
"igAssetName": "jonathanbale.upshift"
```

`fbAssetName` is the Page name exactly as `Settings > Profiles` spells it.
`igAssetName` is the IG profile name as the Business Suite switcher lists it.
Neither has a default. A missing `igAssetName` is a hard error rather than a guess,
because a wrong name would schedule into somebody else's account.
