#!/bin/bash
# vibe entry point. start.sh does the pyenv setup and keeps its exit-42
# restart loop; the app listens on $PORT, which vibe sets to 8008 (the port
# nginx proxies sm4.adun.ai to).
cd "$(dirname "${BASH_SOURCE[0]}")"
exec bash ./start.sh
