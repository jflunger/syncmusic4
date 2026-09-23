"""
Standalone minimal PWA test server (port 8009).

Serves a tiny, dependency-free fullscreen-PWA test page in complete isolation from
the main SyncMusic4 app, so we can confirm whether iOS actually renders an installed
PWA edge-to-edge — independent of the main app's layout/shadow-DOM complexity.

Started in the background by start.sh alongside the main app. Throwaway debugging aid;
delete server/pwatest.py + server/pwatest_static/ and the start.sh line when done.
"""
import os
from flask import Flask, send_from_directory

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pwatest_static')
app = Flask(__name__, static_folder=None)


@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8009, debug=False)
