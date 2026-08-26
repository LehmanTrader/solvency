#!/bin/zsh
# Desktop-app launcher for the Solvency Bench GUI (invoked by
# ~/Desktop/Solvency Bench.app). Starts the server if needed, opens the
# dashboard.
export PATH="/Users/robertdhanda/.local/bin:$PATH:/usr/local/bin:/opt/homebrew/bin"
[ -f "$HOME/.solvency-bench-env" ] && source "$HOME/.solvency-bench-env"
cd "$HOME/solvency"
if ! curl -s -o /dev/null --max-time 1 http://localhost:4871/api/tasks; then
  nohup node bench/server.mjs > /tmp/solvency-bench-gui.log 2>&1 &
  for i in {1..40}; do curl -s -o /dev/null --max-time 1 http://localhost:4871/api/tasks && break; sleep 0.25; done
fi
open "http://localhost:4871"
