#!/bin/bash
export PATH="$HOME/.deno/bin:$HOME/.pyenv/versions/syncmusic4/bin:$PATH"
exec yt-dlp \
  --cookies "$HOME/syncmusic4/cookies_youtube.txt" \
  --remote-components ejs:github \
  --no-playlist --simulate \
  --print "OK %(title)s [%(ext)s]" \
  "https://www.youtube.com/watch?v=sok8kp_DSqE"
