"""Web UI: scrape Pinterest images, then cull them Tinder-style.

Run:
    python app.py
Then open http://127.0.0.1:5000

Review model:
  - Images to review live in the folder root.
  - "Keep"   -> moved to <folder>/_keep/
  - "Delete" -> moved to <folder>/_trash/  (reversible; nothing is erased)
  - "Undo"   -> moves the last-decided image back to the root.
"""

import json
import os
import shutil
import subprocess
import threading

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    send_from_directory,
)

try:
    from send2trash import send2trash  # deletes to the OS Recycle Bin
except ImportError:  # fallback: hard delete
    def send2trash(path):
        os.remove(path)

import scraper

app = Flask(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOADS = os.path.join(BASE_DIR, "downloads")
KEEP = "_keep"
TRASH = "_trash"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".webp")

# in-memory scrape job state
job = {"running": False, "done": 0, "total": 0, "query": "", "result": None, "error": None}


def safe_folder(name):
    """Prevent path traversal; return absolute folder path inside downloads."""
    name = os.path.basename(name)
    return os.path.join(DOWNLOADS, name)


def list_root_images(folder):
    if not os.path.isdir(folder):
        return []
    return sorted(
        f for f in os.listdir(folder)
        if f.lower().endswith(IMAGE_EXTS) and os.path.isfile(os.path.join(folder, f))
    )


def count_in(folder, sub):
    p = os.path.join(folder, sub)
    if not os.path.isdir(p):
        return 0
    return len([f for f in os.listdir(p) if f.lower().endswith(IMAGE_EXTS)])


@app.route("/")
def index():
    collections = []
    if os.path.isdir(DOWNLOADS):
        for name in sorted(os.listdir(DOWNLOADS)):
            folder = os.path.join(DOWNLOADS, name)
            if not os.path.isdir(folder):
                continue
            collections.append({
                "name": name,
                "pending": len(list_root_images(folder)),
                "kept": count_in(folder, KEEP),
            })
    return render_template("index.html", collections=collections)


# ---------------------------------------------------------------- scraping

def _run_scrape(query, limit):
    job.update(running=True, done=0, total=0, query=query, result=None, error=None)

    def progress(done, total):
        job["done"] = done
        job["total"] = total

    try:
        result = scraper.scrape(query, limit=limit, output=DOWNLOADS, progress=progress)
        job["result"] = result
    except Exception as e:  # noqa: BLE001
        job["error"] = str(e)
    finally:
        job["running"] = False


@app.route("/api/scrape", methods=["POST"])
def api_scrape():
    if job["running"]:
        return jsonify({"error": "A scrape is already running."}), 409
    data = request.get_json(force=True)
    query = (data.get("query") or "").strip()
    limit = int(data.get("limit") or 50)
    if not query:
        return jsonify({"error": "Query is required."}), 400
    limit = max(1, min(limit, 500))
    threading.Thread(target=_run_scrape, args=(query, limit), daemon=True).start()
    return jsonify({"ok": True})


@app.route("/api/scrape/status")
def api_scrape_status():
    return jsonify(job)


# ---------------------------------------------------------------- review

@app.route("/review/<folder>")
def review(folder):
    return render_template("review.html", folder=folder)


@app.route("/api/images/<folder>")
def api_images(folder):
    path = safe_folder(folder)
    imgs = list_root_images(path)
    return jsonify({
        "folder": folder,
        "images": imgs,
        "kept": count_in(path, KEEP),
        "trashed": count_in(path, TRASH),
    })


@app.route("/image/<folder>/<path:name>")
def image(folder, name):
    return send_from_directory(safe_folder(folder), name)


@app.route("/api/decide", methods=["POST"])
def api_decide():
    data = request.get_json(force=True)
    folder = safe_folder(data.get("folder", ""))
    name = os.path.basename(data.get("name", ""))
    action = data.get("action")
    if action not in ("keep", "delete"):
        return jsonify({"error": "bad action"}), 400

    src = os.path.join(folder, name)
    if not os.path.isfile(src):
        return jsonify({"error": "not found"}), 404

    if action == "keep":
        dst_dir = os.path.join(folder, KEEP)
        os.makedirs(dst_dir, exist_ok=True)
        shutil.move(src, os.path.join(dst_dir, name))
    else:  # delete -> Recycle Bin (recoverable at OS level, gone from the project)
        send2trash(os.path.abspath(src))
        _record_deleted(folder, name)
    return jsonify({"ok": True})


def _record_deleted(folder, name):
    """Remember deleted filenames so a re-scrape ('Add more') won't resurface them."""
    ledger = os.path.join(folder, ".deleted.json")
    names = []
    if os.path.isfile(ledger):
        try:
            with open(ledger) as f:
                names = json.load(f)
        except Exception:
            names = []
    if name not in names:
        names.append(name)
        with open(ledger, "w") as f:
            json.dump(names, f)


RESTORE_PS = os.path.join(BASE_DIR, "restore.ps1")


def restore_from_recycle_bin(folder_abs, name):
    """Pull a file back out of the Windows Recycle Bin into its folder."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", RESTORE_PS, "-dest", os.path.abspath(folder_abs), "-fname", name],
            capture_output=True, text=True, timeout=30,
        )
        return "OK" in (out.stdout or "")
    except Exception:
        return False


def _unrecord_deleted(folder, name):
    ledger = os.path.join(folder, ".deleted.json")
    if not os.path.isfile(ledger):
        return
    try:
        with open(ledger) as f:
            names = json.load(f)
    except Exception:
        return
    if name in names:
        names.remove(name)
        with open(ledger, "w") as f:
            json.dump(names, f)


@app.route("/api/undo", methods=["POST"])
def api_undo():
    data = request.get_json(force=True)
    folder = safe_folder(data.get("folder", ""))
    name = os.path.basename(data.get("name", ""))
    action = data.get("action")

    if action == "keep":
        src = os.path.join(folder, KEEP, name)
        if not os.path.isfile(src):
            return jsonify({"error": "not found"}), 404
        shutil.move(src, os.path.join(folder, name))
        return jsonify({"ok": True})

    # delete -> pull the file back out of the Recycle Bin
    if os.path.isfile(os.path.join(folder, name)):
        _unrecord_deleted(folder, name)
        return jsonify({"ok": True})  # already there somehow
    if restore_from_recycle_bin(folder, name):
        _unrecord_deleted(folder, name)
        return jsonify({"ok": True})
    return jsonify({"error": "norestore",
                    "message": "Couldn't restore from Recycle Bin."}), 409


if __name__ == "__main__":
    os.makedirs(DOWNLOADS, exist_ok=True)
    port = int(os.environ.get("PORT", 5077))
    print(f"Pinterest Scraper + Culler running at http://127.0.0.1:{port}")
    app.run(debug=False, port=port)
