#!/usr/bin/env python3
"""
Fallback SoundCloud downloader using the public DownCloudMe service.

This is a backup for yt_dl_downloader.py / the `soundcloud` library: when those
fail (e.g. region-locked or SoundCloud Go+ tracks), this routes the download
through https://downcloudme.com, which resolves a free direct MP3 link via its
scloudme.com job backend. It also handles Go+ tracks that yt-dlp cannot fetch.

Reverse-engineered flow (no API key needed):
  1. GET https://downcloudme.com/enTc/  -> scrape the `downloader_verify` nonce
     and pick up session cookies.
  2. POST https://downcloudme.com/download-track  (url + nonce)  -> the returned
     HTML embeds a `jobId` and a status URL on www.scloudme.com.
  3. Poll https://www.scloudme.com/dl/status/<jobId>  until the JSON `api2`
     object exposes `rapid_url` (direct MP3) or signals completion/error.
  4. Download the MP3 from `rapid_url` to downloads/.
"""

import sys
import os
import re
import time

import requests

HOME_URL = "https://downcloudme.com/enTc/"
TRACK_URL = "https://downcloudme.com/download-track"
STATUS_URL = "https://www.scloudme.com/dl/status/{job_id}"
# The site's "Backup Download" form posts the (encrypted) final_direct_link here
# and sc.php decrypts it server-side and streams back the MP3. This is the
# reliable path: the "fast" rapid_url on 123tokyo.xyz frequently 404s.
SC_DOWNLOAD_URL = "https://downcloudme.com/sc.php"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# How long to wait for the backend to resolve a download link.
POLL_INTERVAL_SEC = 1.0
POLL_TIMEOUT_SEC = 90

_NONCE_RE = re.compile(r'name="downloader_verify"\s+value="([^"]+)"')
_JOB_ID_RE = re.compile(r'jobId\s*=\s*"([0-9a-fA-F-]{36})"')
_FILENAME_RE = re.compile(r'fileName\s*=\s*"([^"]+)"')
# Fields on the backup download form in the /download-track response page.
_SC_NONCE_RE = re.compile(r'name="_nonce"\s+value="([^"]+)"')
_TITLE_RE = re.compile(r'name="title"\s+value="([^"]*)"')
_INVALID_FS_CHARS = re.compile(r'[\\/:*?"<>|]')


def _new_session():
    """Build a requests session preloaded with browser-like headers."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return session


def _scrape_nonce(session):
    """GET the homepage to obtain session cookies + the form nonce.

    @param {requests.Session} session
    @returns {str} the `downloader_verify` nonce value
    """
    resp = session.get(HOME_URL, timeout=30)
    resp.raise_for_status()
    match = _NONCE_RE.search(resp.text)
    if not match:
        raise RuntimeError("Could not find downloader_verify nonce on homepage")
    return match.group(1)


def _submit_track(session, nonce, url):
    """POST the SoundCloud URL and return the details needed to download it.

    @param {requests.Session} session
    @param {str} nonce - the `downloader_verify` value
    @param {str} url - the SoundCloud track URL
    @returns {dict} - {job_id, file_name, sc_nonce, title}; sc_nonce/title drive
                      the backup sc.php download form.
    """
    resp = session.post(
        TRACK_URL,
        data={
            "downloader_verify": nonce,
            "_wp_http_referer": "/enTc/",
            "url": url,
        },
        headers={"Referer": HOME_URL},
        timeout=30,
    )
    resp.raise_for_status()

    job_match = _JOB_ID_RE.search(resp.text)
    if not job_match:
        raise RuntimeError("Backend did not return a job id (track may be unsupported)")

    name_match = _FILENAME_RE.search(resp.text)
    sc_nonce_match = _SC_NONCE_RE.search(resp.text)
    title_match = _TITLE_RE.search(resp.text)
    return {
        "job_id": job_match.group(1),
        "file_name": name_match.group(1) if name_match else None,
        "sc_nonce": sc_nonce_match.group(1) if sc_nonce_match else None,
        "title": title_match.group(1) if title_match else "",
    }


def _poll_for_link(session, job_id):
    """Poll the scloudme status endpoint until the job's links are ready.

    Waits for `final_direct_link` (the value the backup sc.php download uses),
    which is the last field the backend fills in and signals the file is ready.
    `rapid_url` appears earlier but points at 123tokyo.xyz and often 404s, so it
    is only returned as an optional fast-path hint.

    @param {requests.Session} session
    @param {str} job_id
    @returns {dict} - {final_direct_link: str, rapid_url: str|None}
    """
    status_url = STATUS_URL.format(job_id=job_id)
    headers = {"Origin": "https://downcloudme.com", "Referer": "https://downcloudme.com/"}
    deadline = time.time() + POLL_TIMEOUT_SEC

    while time.time() < deadline:
        resp = session.get(status_url, headers=headers, timeout=30)
        if resp.status_code == 200:
            api2 = (resp.json() or {}).get("api2") or {}
            if api2.get("error"):
                raise RuntimeError(f"Backend error: {api2['error']}")
            if api2.get("final_direct_link"):
                return {
                    "final_direct_link": api2["final_direct_link"],
                    "rapid_url": api2.get("rapid_url"),
                }
            if api2.get("completed"):
                raise RuntimeError("Job completed without a download link")
        time.sleep(POLL_INTERVAL_SEC)

    raise TimeoutError("Timed out waiting for download link")


def _safe_filename(name):
    """Strip filesystem-hostile characters from a suggested file name."""
    return _INVALID_FS_CHARS.sub("_", name).strip() or "track.mp3"


def _stream_to_disk(resp, dest):
    """Stream an HTTP response body to `dest`, returning the bytes written."""
    written = 0
    with open(dest, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                fh.write(chunk)
                written += len(chunk)
    return written


def _looks_like_audio(resp):
    """True if an HTTP response looks like an audio file rather than an error.

    The convert backend answers a bad/expired link with a tiny text/plain
    "Not Found" body, so reject those before treating the response as a track.
    """
    ctype = (resp.headers.get("Content-Type") or "").lower()
    return "text/html" not in ctype and "text/plain" not in ctype


def _download_rapid(session, rapid_url, dest):
    """Try the fast 123tokyo.xyz link. Returns bytes written, or 0 if unusable."""
    with session.get(rapid_url, headers={"Referer": "https://downcloudme.com/"},
                     stream=True, timeout=120) as resp:
        if resp.status_code != 200 or not _looks_like_audio(resp):
            return 0
        return _stream_to_disk(resp, dest)


def _download_backup(session, links, submit, dest):
    """Download via the backup sc.php form (decrypts final_direct_link server-side).

    @param {requests.Session} session
    @param {dict} links - result of _poll_for_link (needs 'final_direct_link')
    @param {dict} submit - result of _submit_track (needs 'sc_nonce', 'title')
    @param {str} dest - output path
    @returns {int} bytes written
    """
    if not submit.get("sc_nonce"):
        raise RuntimeError("Could not find backup-form nonce on the track page")
    with session.post(
        SC_DOWNLOAD_URL,
        data={
            "_nonce": submit["sc_nonce"],
            "_wp_http_referer": "/download",
            "action": "download_mp3",
            "title": submit.get("title", ""),
            "yt": links["final_direct_link"],
        },
        headers={"Referer": TRACK_URL, "Origin": "https://downcloudme.com"},
        stream=True, timeout=180,
    ) as resp:
        resp.raise_for_status()
        if not _looks_like_audio(resp):
            raise RuntimeError(f"Backup endpoint returned non-audio "
                               f"({resp.headers.get('Content-Type')})")
        return _stream_to_disk(resp, dest)


def download_audio(url, download_dir="downloads"):
    """Download a SoundCloud track via DownCloudMe as a fallback path.

    Mirrors yt_dl_downloader.download_audio's return contract so it can be
    swapped in by the download manager. Prefers the fast 123tokyo.xyz link when
    it works and falls back to the sc.php backup form (which decrypts the
    final_direct_link server-side) — the path that reliably returns the MP3.

    @param {str} url - The SoundCloud track URL to download
    @param {str} download_dir - Where to write the .mp3 (default 'downloads')
    @returns {dict} - {'success': bool, 'file'/'message' | 'error'/'details'}
    """
    if not url:
        return {"success": False, "error": "No URL provided"}

    os.makedirs(download_dir, exist_ok=True)
    session = _new_session()

    try:
        nonce = _scrape_nonce(session)
        submit = _submit_track(session, nonce, url)
        links = _poll_for_link(session, submit["job_id"])

        file_name = submit.get("file_name")
        if not file_name:
            file_name = url.rstrip("/").split("/")[-1] + ".mp3"
        if not file_name.lower().endswith(".mp3"):
            file_name += ".mp3"
        file_name = _safe_filename(file_name)
        dest = os.path.join(download_dir, file_name)

        # Fast path first (often 404s), then the reliable backup form.
        written = 0
        if links.get("rapid_url"):
            try:
                written = _download_rapid(session, links["rapid_url"], dest)
            except Exception:
                written = 0
        if not written:
            written = _download_backup(session, links, submit, dest)

        if not written:
            raise RuntimeError("Both fast and backup downloads returned no data")

        return {
            "success": True,
            "message": f"Download completed: {os.path.basename(dest)}",
            "file": dest,
        }
    except Exception as exc:
        return {"success": False, "error": "Download failed", "details": str(exc)}


def test_downloader():
    """Live end-to-end test against the project's sample track."""
    test_url = "https://soundcloud.com/outsidersnlmusic/free"

    print(f"Testing DownCloudMe fallback with: {test_url}")
    result = download_audio(test_url)

    if result["success"] and os.path.exists(result["file"]):
        size = os.path.getsize(result["file"])
        print(f"Test passed: {result['message']} ({size} bytes)")
        return size > 0
    print(f"Test failed: {result}")
    return False


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--test":
        sys.exit(0 if test_downloader() else 1)
    elif len(sys.argv) < 2:
        print("Usage: python downcloud_downloader.py <SoundCloud URL>")
        print("Or:    python downcloud_downloader.py --test")
        sys.exit(1)

    outcome = download_audio(sys.argv[1])
    if outcome["success"]:
        print(f"Success: {outcome['message']}")
    else:
        print(f"Error: {outcome['error']}")
        if "details" in outcome:
            print(f"Details: {outcome['details']}")
        sys.exit(1)
