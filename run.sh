#!/bin/bash
# vibe entry point. start.sh does the pyenv setup and keeps its exit-42
# restart loop; the app listens on $PORT, which vibe sets to 8008 (the port
# nginx proxies sm4.adun.ai to).
cd "$(dirname "${BASH_SOURCE[0]}")"
# Localhost only: nginx is the public entry point.
export HOST=127.0.0.1
exec bash ./start.sh
