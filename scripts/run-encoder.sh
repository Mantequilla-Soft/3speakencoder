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
  exit "$code"
done
