#!/usr/bin/env bash
# Runs the encoder and restarts it when it exits with code 75, which it does
# after applying an update from the dashboard. Any other exit ends this script
# with the same code.
#
#   ./scripts/run-encoder.sh              # npm start
#   ./scripts/run-encoder.sh npm run start:compiled
set -u
cd "$(dirname "$0")/.."

# Tells the encoder a supervisor will restart it (otherwise it asks for a manual restart)
export ENCODER_SUPERVISED=1

if [ "$#" -eq 0 ]; then set -- npm start; fi

# Own process group for the child: Ctrl-C reaches only this script, which forwards it once
set -m
child=0
forward() { if [ "$child" -ne 0 ]; then kill "-$1" "$child" 2>/dev/null; fi; }
trap 'forward INT' INT
trap 'forward TERM' TERM
trap 'forward HUP' HUP

while true; do
  "$@" &
  child=$!
  wait "$child"
  code=$?
  # A trapped signal interrupts `wait`; keep waiting for the real exit status
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  child=0

  if [ "$code" -eq 75 ]; then
    echo "🔄 Encoder updated itself - restarting..."
    sleep 2
    continue
  fi

  # The encoder writes this before a self-update restart and deletes it once the new code
  # has run for a minute. Still here after a failed exit = the update broke startup.
  marker="data/update-previous-commit"
  if [ "$code" -ne 0 ] && [ -f "$marker" ]; then
    prev=$(tr -d '[:space:]' < "$marker")
    rm -f "$marker"
    if printf '%s' "$prev" | grep -Eq '^[0-9a-f]{40}$'; then
      echo "⚠️  Encoder exited with code $code right after an update - rolling back to ${prev:0:7}..."
      if git reset --hard "$prev" && npm ci && npm run build; then
        echo "↩️  Rolled back - starting the previous version"
        sleep 2
        continue
      fi
      echo "🚨 Rollback failed. Fix by hand: git reset --hard $prev && npm ci && npm run build"
    fi
  fi
  exit "$code"
done
