#!/bin/bash
#
# SyncMusic4 launcher + supervisor.
#
# This is what the tmux window `main:syncmusic4` runs (see server_boot.sh). It
# does not just start the app once: it keeps it running, so a restart never
# needs a shell. `POST /api/admin/restart` makes the app exit 42, the loop below
# sees that code and brings it straight back up — that is what `./deploy.sh
# restart` drives.
#
# To stop for real, press Ctrl-C in this tmux window: the trap breaks the loop
# instead of letting it respawn.

cd "$(dirname "${BASH_SOURCE[0]}")"

# Initialize pyenv (works in non-interactive shells)
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
eval "$(pyenv virtualenv-init -)"

# yt-dlp / votify are installed into the pyenv env; keep its bin on PATH so the
# app's shell-outs find them.
sleep 2

pyenv activate syncmusic4

# Exit codes the app can hand back (see RESTART_EXIT_CODE in server/app.py).
RESTART_EXIT_CODE=42
CRASH_BACKOFF=3

# Ctrl-C reaches both bash and python as the pane's foreground process group.
# bash defers the trap until python has returned, so this runs *after* the app
# is already down and simply stops us from restarting it.
trap 'echo; echo "[start.sh] interrupted — not restarting."; exit 130' INT TERM

while true; do
    echo "[start.sh] starting server/app.py ($(date '+%H:%M:%S'))"
    python server/app.py
    code=$?

    case "$code" in
        "$RESTART_EXIT_CODE")
            echo "[start.sh] restart requested (exit $code) — relaunching"
            ;;
        0|130)
            echo "[start.sh] app exited cleanly (exit $code) — stopping"
            break
            ;;
        *)
            echo "[start.sh] app crashed (exit $code) — restarting in ${CRASH_BACKOFF}s"
            sleep "$CRASH_BACKOFF"
            ;;
    esac
done
