# Pinterest Scraper + Tinder-style Culler

Download images for any Pinterest search, then keep or trash them one-by-one
with a fast swipe interface.

## Setup

```bash
pip install -r requirements.txt
```

## Run the web app (scrape + review)

```bash
python app.py
```

Then open **http://127.0.0.1:5077** in your browser.

- Type a search term, choose how many images, hit **Scrape**. A progress bar
  tracks the download, then it jumps you into review.
- **Review** shows one image at a time as a card:
  - **→ arrow key**, **Space**, tap the green ♥, or **swipe right** = *Keep*
  - **← arrow key**, **Delete/Backspace**, tap the red 🗑, or **swipe left** = *Delete*
  - **Z** or the ↺ button = *Undo* the last **keep** (deletes are permanent)
- The keep / delete buttons sit right next to each other so you can rip through
  a batch quickly.
- **＋ Add more** (top-right of the review screen) downloads more images of the
  same search into the collection without leaving the page. Pick how many first.

> Port 5000 is taken by another app on this machine, so this defaults to **5077**.
> Change it with `PORT=6000 python app.py` (or set the `PORT` env var on Windows).

## Where files go

```
downloads/
  <your-search>/
    <images to review>.jpg      <- pending
    _keep/                       <- images you kept
    .deleted.json                <- ledger of deleted images (so re-scrapes skip them)
```

**Delete is permanent** — the file is sent to your **Recycle Bin** (removed from
the project, recoverable at the OS level if you fat-finger one). Kept images
collect in `_keep/`. "Add more" won't resurface anything you've already kept or
deleted.

## Command-line only (no UI)

```bash
python scraper.py "cottagecore aesthetic" --limit 60
python scraper.py "brutalist architecture" -n 100 -o downloads
```

## Notes

- Uses Pinterest's public search endpoint (no login/API key). It primes a
  session for cookies, then paginates results and grabs the
  original-resolution image for each pin.
- If Pinterest changes their endpoint or rate-limits you, re-run after a short
  wait; the scraper skips already-downloaded files so it's safe to resume.
