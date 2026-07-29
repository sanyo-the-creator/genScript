"""Pinterest image scraper.

Uses Pinterest's public (unauthenticated) search resource endpoint to fetch
pin metadata, then downloads the original-resolution images to disk.

Usage (CLI):
    python scraper.py "cottagecore aesthetic" --limit 60
    python scraper.py "brutalist architecture" -n 100 -o downloads

Images are saved to:  <output>/<slugified-query>/<hash>.jpg
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

import requests

SEARCH_URL = "https://www.pinterest.com/resource/BaseSearchResource/get/"

BASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-") or "search"


def make_session():
    """Prime a session with Pinterest cookies (csrftoken etc.)."""
    s = requests.Session()
    s.headers.update(BASE_HEADERS)
    s.get("https://www.pinterest.com/", timeout=20)
    return s


def _best_image_url(images):
    """Pick the highest-resolution image URL from a pin's images dict."""
    if not images:
        return None
    if "orig" in images and images["orig"].get("url"):
        return images["orig"]["url"]
    # fall back to the largest sized variant available
    order = ["736x", "564x", "474x", "236x", "170x"]
    for key in order:
        if key in images and images[key].get("url"):
            return images[key]["url"]
    # otherwise take whatever exists
    for v in images.values():
        if isinstance(v, dict) and v.get("url"):
            return v["url"]
    return None


def search_pins(query, limit=50, session=None, delay=0.6, skip_names=None, max_pages=60):
    """Yield up to `limit` *new* image URLs for a search query.

    `skip_names` is a set of content-based filenames we already have (kept,
    pending, or deleted). Results matching those are skipped and do NOT count
    toward `limit`, so the search paginates deeper to surface genuinely new
    images instead of stopping on pins you've already seen. `max_pages` caps how
    far we page before giving up.
    """
    skip_names = skip_names or set()
    session = session or make_session()
    csrf = session.cookies.get("csrftoken")
    headers = {
        "Accept": "application/json, text/javascript, */*, q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "X-APP-VERSION": "a9e4e5e",
        "X-Pinterest-AppState": "active",
        "X-Pinterest-PWS-Handler": "www/search/[scope].js",
        "Referer": f"https://www.pinterest.com/search/pins/?q={query}",
    }
    if csrf:
        headers["X-CSRFToken"] = csrf

    seen = set()
    bookmarks = [""]
    collected = 0
    pages = 0

    while collected < limit and pages < max_pages:
        pages += 1
        options = {
            "query": query,
            "scope": "pins",
            "page_size": 25,
            "bookmarks": bookmarks,
        }
        params = {
            "source_url": f"/search/pins/?q={query}",
            "data": json.dumps({"options": options, "context": {}}),
        }
        try:
            r = session.get(SEARCH_URL, params=params, headers=headers, timeout=25)
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f"  ! request failed: {e}", file=sys.stderr)
            break

        rr = data.get("resource_response", {})
        results = rr.get("data", {}).get("results", []) or []
        if not results:
            break

        for pin in results:
            url = _best_image_url(pin.get("images"))
            if not url or url in seen:
                continue
            seen.add(url)
            if image_name_for(url) in skip_names:
                continue  # already kept / pending / deleted -> keep looking
            collected += 1
            yield url
            if collected >= limit:
                return

        new_bookmark = rr.get("bookmark")
        if not new_bookmark or new_bookmark == bookmarks[0] or new_bookmark == "-end-":
            break
        bookmarks = [new_bookmark]
        time.sleep(delay)


def image_name_for(url):
    """Stable, content-based filename for an image URL.

    Pinterest uses content-addressed storage: the same image always lives at a
    path like `.../originals/40/fa/c3/40fac3...e56.jpg`, where the basename is a
    hash of the image bytes -- identical across different pins, searches, and
    resolutions. Using that basename as our filename means the *same image* gets
    the *same name* everywhere, so dedup / delete-tracking recognises it even
    when it turns up again in a future search under a different pin URL.

    Falls back to a hash of the URL for anything that isn't a Pinterest CDN URL.
    """
    base = os.path.basename(urlparse(url).path)
    if re.match(r"^[0-9a-f]{16,}\.(jpg|jpeg|png|gif|webp)$", base, re.I):
        return base.lower()
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        ext = ".jpg"
    return hashlib.md5(url.encode()).hexdigest() + ext


def download_image(url, out_dir, session, skip=None):
    name = image_name_for(url)
    path = os.path.join(out_dir, name)
    if os.path.exists(path) or (skip and name in skip):
        return path, False
    try:
        r = session.get(url, timeout=30)
        r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)
        return path, True
    except Exception as e:
        print(f"  ! download failed {url}: {e}", file=sys.stderr)
        return None, False


def scrape(query, limit=50, output="downloads", workers=8, progress=None):
    """Scrape and download images. Returns dict with folder and counts.

    `progress` is an optional callback(done, total) for UI updates.
    """
    session = make_session()
    folder = os.path.join(output, slugify(query))
    os.makedirs(folder, exist_ok=True)

    # Build the set of images we already have so the search can page past them
    # and only surface *new* ones. Covers: pending (in the folder root), kept
    # (moved to _keep/), and deleted (recorded in .deleted.json).
    skip = set()
    for f in os.listdir(folder):
        if os.path.isfile(os.path.join(folder, f)):
            skip.add(f)
    keep_dir = os.path.join(folder, "_keep")
    if os.path.isdir(keep_dir):
        skip.update(os.listdir(keep_dir))
    ledger = os.path.join(folder, ".deleted.json")
    if os.path.isfile(ledger):
        try:
            with open(ledger) as f:
                skip.update(json.load(f))
        except Exception:
            pass

    print(f"Searching Pinterest for: {query!r} (target {limit} new images; "
          f"{len(skip)} already known)")
    urls = list(search_pins(query, limit=limit, session=session, skip_names=skip))
    print(f"Found {len(urls)} new image URLs. Downloading to {folder} ...")

    downloaded = 0
    done = 0
    total = len(urls)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(download_image, u, folder, session, skip): u for u in urls}
        for fut in as_completed(futures):
            path, is_new = fut.result()
            if path and is_new:
                downloaded += 1
            done += 1
            if progress:
                progress(done, total)
            if done % 10 == 0 or done == total:
                print(f"  {done}/{total} processed ({downloaded} new)")

    print(f"Done. {downloaded} new images saved in {folder}")
    return {
        "query": query,
        "folder": folder,
        "found": total,
        "downloaded": downloaded,
    }


def main():
    ap = argparse.ArgumentParser(description="Download Pinterest images for a search query.")
    ap.add_argument("query", help="search term, e.g. 'cottagecore aesthetic'")
    ap.add_argument("-n", "--limit", type=int, default=50, help="max images (default 50)")
    ap.add_argument("-o", "--output", default="downloads", help="output base folder")
    ap.add_argument("-w", "--workers", type=int, default=8, help="parallel downloads")
    args = ap.parse_args()
    scrape(args.query, limit=args.limit, output=args.output, workers=args.workers)


if __name__ == "__main__":
    main()
