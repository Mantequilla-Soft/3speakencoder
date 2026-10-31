#!/usr/bin/env bash
# Run install.sh unattended in a fresh distro container, as a normal user with sudo,
# then start the installed encoder until it has found and used FFmpeg.
#   tests/installer/in-container.sh ubuntu:22.04
#   tests/installer/in-container.sh fedora:42
# Installs the repo's committed HEAD (ENCODER_REPO=/src), using the working-tree install.sh.
set -euo pipefail
image="$1"
repo="$(cd "$(dirname "$0")/../.." && pwd)"

case "$image" in
    ubuntu*|debian*) prep="apt-get update -qq && apt-get install -y -qq sudo >/dev/null" ;;
    fedora*|rocky*|alma*) prep="dnf install -y -q sudo >/dev/null" ;;
    arch*) prep="pacman -Sy --noconfirm --needed sudo >/dev/null" ;;
    *) echo "unknown image family: $image"; exit 2 ;;
esac
# Ubuntu 22.04's own Node.js is 12: install it first so the upgrade path gets tested
if [[ "$image" == ubuntu:22.04 ]]; then prep="$prep && apt-get install -y -qq nodejs >/dev/null"; fi

docker run --rm -v "$repo":/src:ro "$image" bash -c "
set -e
$prep
useradd -m -s /bin/bash op
echo 'op ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/op
# /src belongs to another user; git refuses to clone it without this (git isn't installed yet)
printf '[safe]\n\tdirectory = *\n' > /home/op/.gitconfig && chown op: /home/op/.gitconfig
# Run a copy: bash reads scripts as it goes, so edits to /src mid-run would break it
cp /src/install.sh /tmp/install.sh
sudo -iu op env ENCODER_MODE=embed HIVE_USERNAME=ci-installer-test AUTOSTART=n START_NOW=n ENCODER_REPO=/src bash /tmp/install.sh
sudo -iu op bash -c 'cd ~/3speak-encoder && node tests/installer/smoke-start.mjs .'
"
