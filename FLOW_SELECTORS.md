# How the Flow driver hooks into the page

Confirmed against a live, logged-in Flow page (Chrome 154, flow.google.com)
on 2026-09-26. Flow's class names are generated and change between deploys,
so everything below is matched by `aria-label`, `role` or visible label text.

## Finding the tab

Chrome 130+ wraps each page in a `tab` target, and puppeteer-core 25.12 does
not walk through those — `browser.pages()` comes back **empty** with Flow open
in front of you. `attachOpenPages()` asks CDP for the real target list and
attaches to the page target by hand, after which puppeteer reports it as an
ordinary `Page`. Older Chrome still works through the plain path.

## The prompt bar

| What | How it is found |
| --- | --- |
| Settings chip | `button[aria-label="Settings trigger"]` |
| Add ingredients | `button[aria-label="Add ingredients to the prompt box"]` — its text is `add` when closed, `close` when open |
| Model dropdown | `button[aria-label="Select model family"]` |
| Generate | `button[aria-label="Start generation"]` (text `arrow_forward`) |
| Agent | the `button` whose text is exactly `Agent` |

## The settings panel

**Nothing in it exists in the DOM until the panel is open**, which is what
`openSettings()` is for — clicking labels blindly finds nothing.

Each option is a `[role="radio"]` carrying a material-icon ligature in front of
its text, so `9:16` appears as `crop_9_169:16`. Options are therefore matched
by substring, and skipped when `aria-checked="true"` already.

**Video has to be selected first.** In image mode the panel only offers
Image/Video, aspect and output count; Ingredients, resolution and duration do
not exist until Video is on.

Video mode offers: `Frames`, `Ingredients`, `16:9`, `9:16`, `360p`, `720p`,
`4s`, `6s`, `8s`, `10s`, `x1`–`x4`. Picking Video also switches the model
family to `Omni 1.1 Flash` on its own.

## Uploads

There is **no `<input type="file">`** in the page to feed. Flow opens a native
file chooser from the `Upload media` item inside the add-ingredients menu;
puppeteer answers it with `page.waitForFileChooser()`, so the click and the
waiter must be armed together.

Uploading a **video** raises a "Rights to use this video" dialog, and the
upload stalls behind it until it is answered — `acceptRightsDialog()` clicks
the plain `I agree`, deliberately not `I agree, do not show again`, so the
confirmation stays per-upload.

The picker stays open after an upload, covering the prompt box and the
generate button; `closeMediaMenu()` puts it away.

Clicking `Upload media` while Flow is still ingesting the previous file never
opens the chooser — `waitForUploads()` waits for any `Uploading…` label to
clear before each upload, and the chooser is retried once.

## Between generations

Ingredients are **not** cleared when a generation starts. Without
`clearPrompt()` (`button[aria-label="Clear prompt"]`, which drops the chips and
the text) the second piece generates with the first piece still attached.
