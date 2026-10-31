#!/usr/bin/env bash
# 3Speak Video Encoder - installer for Linux and macOS
#
#   curl -fsSL https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh -o install.sh
#   bash install.sh
#
# Installs what's missing (Git, Node.js 20+, FFmpeg, IPFS), downloads the encoder and writes .env.
# Supported: Debian/Ubuntu (apt), Fedora and RHEL-family (dnf), Arch (pacman), macOS (Homebrew).
#
# Unattended (answers from the environment instead of prompts):
#   ENCODER_MODE=embed|direct|dual  HIVE_USERNAME=...  START_NOW=y|n
#   INSTALL_DIR=...  ENCODER_REPO=<git url or path>  (defaults: ~/3speak-encoder, GitHub)

set -euo pipefail

KUBO_VERSION="0.43.1"
NODE_MIN=20
NODE_INSTALL=22   # NodeSource line when the distro's Node.js is too old

ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
step() { echo ""; echo "$*"; }
die()  { echo ""; echo "❌ $*"; echo "   Fix that, then run the installer again."; exit 1; }

# Prompt, unless the answer is already in the environment (unattended installs, CI).
# Reads from the terminal, so it also works when the script itself arrives on stdin.
ask() {
    local var="$1" prompt="$2" answer
    if [[ -n "${!var+set}" ]]; then printf '%s' "${!var}"; return; fi
    if [[ -r /dev/tty ]]; then
        read -r -p "$prompt " answer < /dev/tty
        printf '%s' "$answer"
    else
        die "No terminal to ask \"$prompt\". Set $var in the environment."
    fi
}

if [[ $EUID -eq 0 ]]; then
    die "Don't run this as root. Run it as the user the encoder should run as (it uses sudo where needed)."
fi

case "$OSTYPE" in
    linux-gnu*) OS=linux ;;
    darwin*)    OS=mac ;;
    *) die "Unsupported OS: $OSTYPE. On Windows use install.ps1." ;;
esac

echo "🚀 3Speak Video Encoder - Setup ($OS)"
echo "====================================="

# ---------------------------------------------------------------------------
# Package manager
# ---------------------------------------------------------------------------
if [[ "$OS" == mac ]]; then
    # brew may be installed but not on PATH in a non-login shell (Apple Silicon: /opt/homebrew)
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if ! command -v brew >/dev/null && [[ -x "$b" ]]; then eval "$("$b" shellenv)"; fi
    done
    if ! command -v brew >/dev/null; then
        step "📦 Installing Homebrew (it asks for your password)..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
        for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
            if [[ -x "$b" ]]; then eval "$("$b" shellenv)"; break; fi
        done
        command -v brew >/dev/null || die "Homebrew installed but brew isn't found. Open a new terminal and run the installer again."
    fi
    PKG=brew
elif command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
elif command -v pacman >/dev/null; then PKG=pacman
else
    die "No supported package manager (apt, dnf, pacman). Install Git, Node.js $NODE_MIN+, FFmpeg and IPFS (Kubo), then follow the manual steps in README.md."
fi

APT_UPDATED=false
pkg_install() {
    case "$PKG" in
        apt)
            if [[ "$APT_UPDATED" == false ]]; then sudo apt-get update -qq; APT_UPDATED=true; fi
            sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
        dnf)    sudo dnf install -y -q "$@" ;;
        pacman) sudo pacman -S --needed --noconfirm "$@" ;;
        brew)   brew install "$@" ;;
    esac
}

# /etc/os-release fields (ID, VERSION_ID) for the dnf repositories
if [[ -r /etc/os-release ]]; then . /etc/os-release; fi

step "🔍 Checking what's installed..."

# ---------------------------------------------------------------------------
# Git, curl, tar
# ---------------------------------------------------------------------------
missing=()
for tool in git curl tar; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if ((${#missing[@]})); then
    step "📦 Installing ${missing[*]}..."
    if [[ "$PKG" == apt ]]; then missing+=(ca-certificates); fi
    pkg_install "${missing[@]}"
fi
ok "Git: $(command -v git)"

# ---------------------------------------------------------------------------
# Node.js 20+
# ---------------------------------------------------------------------------
node_major() { local v; v="$(node -v 2>/dev/null || true)"; v="${v#v}"; echo "${v%%.*}" | grep -E '^[0-9]+$' || echo 0; }
if (( $(node_major) < NODE_MIN )); then
    if command -v node >/dev/null; then warn "Node.js $(node -v) is too old; the encoder needs $NODE_MIN or newer"; fi
    step "📦 Installing Node.js..."
    case "$PKG" in
        apt)
            # Distro Node.js is often too old (Ubuntu 22.04: 12). NodeSource's package replaces it.
            sudo apt-get remove -y -qq nodejs npm >/dev/null 2>&1 || true
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_INSTALL}.x" | sudo -E bash - >/dev/null
            sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs ;;
        dnf)
            curl -fsSL "https://rpm.nodesource.com/setup_${NODE_INSTALL}.x" | sudo bash - >/dev/null
            sudo dnf install -y -q nodejs ;;
        pacman) pkg_install nodejs npm ;;
        brew)   pkg_install node ;;
    esac
    hash -r
fi
(( $(node_major) >= NODE_MIN )) || die "Node.js $NODE_MIN+ is required (found: $(node -v 2>/dev/null || echo none)). Install it from https://nodejs.org"
command -v npm >/dev/null || die "npm is missing (it normally comes with Node.js)"
ok "Node.js $(node -v): $(command -v node)"

# ---------------------------------------------------------------------------
# FFmpeg (a full build: libx264 for software encoding)
# ---------------------------------------------------------------------------
if ! command -v ffmpeg >/dev/null; then
    step "📦 Installing FFmpeg..."
    if [[ "$PKG" == dnf ]]; then
        # Fedora and RHEL-family ship no (or a cut-down) FFmpeg; RPM Fusion has the full one
        if [[ "${ID:-}" == fedora ]]; then
            sudo dnf install -y -q "https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm" || true
        else
            sudo dnf install -y -q epel-release || true
            sudo dnf config-manager --set-enabled crb >/dev/null 2>&1 || sudo dnf config-manager --set-enabled powertools >/dev/null 2>&1 || true
            sudo dnf install -y -q "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm" || true
        fi
        sudo dnf install -y -q --allowerasing ffmpeg || die "FFmpeg could not be installed. Enable RPM Fusion (https://rpmfusion.org/Configuration) and run: sudo dnf install ffmpeg"
    else
        pkg_install ffmpeg || die "FFmpeg could not be installed with $PKG"
    fi
    hash -r
fi
FFMPEG_BIN="$(command -v ffmpeg || true)"
[[ -n "$FFMPEG_BIN" ]] || die "FFmpeg isn't installed"
"$FFMPEG_BIN" -hide_banner -version >/dev/null 2>&1 || die "$FFMPEG_BIN doesn't run. Reinstall FFmpeg."
FFPROBE_BIN="$(dirname "$FFMPEG_BIN")/ffprobe"
[[ -x "$FFPROBE_BIN" ]] || FFPROBE_BIN="$(command -v ffprobe || true)"
[[ -n "$FFPROBE_BIN" ]] || die "ffprobe (part of FFmpeg) is missing"
ok "FFmpeg: $FFMPEG_BIN"

# aria2 is optional (faster downloads); don't fail without it
command -v aria2c >/dev/null || pkg_install aria2 >/dev/null 2>&1 || true
if command -v aria2c >/dev/null; then ok "aria2: parallel downloads enabled"; fi

# ---------------------------------------------------------------------------
# IPFS (Kubo). The encoder won't start without its daemon.
# ---------------------------------------------------------------------------
if ! command -v ipfs >/dev/null; then
    step "📦 Installing IPFS (Kubo $KUBO_VERSION)..."
    if [[ "$OS" == mac ]]; then
        pkg_install ipfs
    else
        case "$(uname -m)" in
            x86_64)        KUBO_ARCH=amd64 ;;
            aarch64|arm64) KUBO_ARCH=arm64 ;;
            armv7l|armv6l) KUBO_ARCH=arm ;;
            *) die "No Kubo build for $(uname -m). Install IPFS yourself: https://docs.ipfs.tech/install/command-line/" ;;
        esac
        tmp="$(mktemp -d)"
        file="kubo_v${KUBO_VERSION}_linux-${KUBO_ARCH}.tar.gz"
        # GitHub first: dist.ipfs.tech is sometimes unreachable
        for url in "https://github.com/ipfs/kubo/releases/download/v${KUBO_VERSION}/$file" \
                   "https://dist.ipfs.tech/kubo/v${KUBO_VERSION}/$file"; do
            if curl -fsSL --connect-timeout 15 "$url" -o "$tmp/kubo.tar.gz"; then break; fi
            warn "Couldn't download $url"
        done
        [[ -s "$tmp/kubo.tar.gz" ]] || die "Couldn't download IPFS (Kubo). Install it yourself: https://docs.ipfs.tech/install/command-line/"
        tar -xzf "$tmp/kubo.tar.gz" -C "$tmp"
        sudo install -m 0755 "$tmp/kubo/ipfs" /usr/local/bin/ipfs
        rm -rf "$tmp"
    fi
    hash -r
fi
IPFS_BIN="$(command -v ipfs || true)"
[[ -n "$IPFS_BIN" ]] || die "IPFS isn't installed"
ok "IPFS: $IPFS_BIN ($("$IPFS_BIN" version --number 2>/dev/null || echo unknown version))"
if [[ ! -d "${IPFS_PATH:-$HOME/.ipfs}" ]]; then
    echo "🔧 Initializing IPFS..."
    "$IPFS_BIN" init --profile server >/dev/null
fi

ipfs_up() { curl -fs -X POST --max-time 2 http://127.0.0.1:5001/api/v0/id >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------
step "🎯 Choose your encoder mode:"
echo "  1) Embed Community - Encode videos for the 3Speak community (recommended)"
echo "  2) Direct API Mode - Private encoder for your apps (direct requests only)"
echo "  3) Dual Mode - Community jobs AND a private direct API (for developers)"
case "$(ask ENCODER_MODE 'Enter your choice (1, 2, or 3):')" in
    1|embed)  ENCODER_MODE=embed ;;
    2|direct) ENCODER_MODE=direct ;;
    3|dual)   ENCODER_MODE=dual ;;
    *) warn "Not a valid choice; using Embed Community mode"; ENCODER_MODE=embed ;;
esac
ok "$ENCODER_MODE mode"

if [[ "$ENCODER_MODE" == direct ]]; then
    HIVE_USERNAME="$(ask HIVE_USERNAME 'Hive username (optional for direct-API-only mode, Enter to skip):')"
    HIVE_USERNAME="${HIVE_USERNAME:-direct-api-encoder}"
else
    HIVE_USERNAME="$(ask HIVE_USERNAME "What's your Hive username? (required for encoding):")"
    [[ -n "$HIVE_USERNAME" ]] || die "A Hive username is required for community encoding"
fi

# ---------------------------------------------------------------------------
# Download and build
# ---------------------------------------------------------------------------
INSTALL_DIR="${INSTALL_DIR:-$HOME/3speak-encoder}"
ENCODER_REPO="${ENCODER_REPO:-https://github.com/Mantequilla-Soft/3speakencoder.git}"
step "📁 Installing to $INSTALL_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "📁 Already there, updating..."
    cd "$INSTALL_DIR"
    git pull --ff-only || warn "git pull failed (local changes?); continuing with the current code"
else
    git clone "$ENCODER_REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

step "📦 Installing dependencies (a few minutes the first time)..."
npm ci --no-audit --no-fund || die "npm ci failed (see the errors above)"

step "🔨 Building..."
npm run build --silent || die "The build failed (see the errors above)"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ENCODER_PRIVATE_KEY=""
if [[ -f .env ]]; then
    ENCODER_PRIVATE_KEY="$(sed -n 's/^ENCODER_PRIVATE_KEY=//p' .env | head -n1)"
    cp .env .env.bak
    ok "Previous settings saved to .env.bak"
fi
if [[ -z "$ENCODER_PRIVATE_KEY" ]]; then
    ENCODER_PRIVATE_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
    ok "New encoder identity generated"
else
    ok "Keeping the existing encoder identity"
fi

case "$ENCODER_MODE" in
    embed)  MODE_LABEL="Embed Community"; EMBED_ENABLED=true;  DIRECT_ENABLED=false ;;
    direct) MODE_LABEL="Direct API";      EMBED_ENABLED=false; DIRECT_ENABLED=true ;;
    dual)   MODE_LABEL="Dual";            EMBED_ENABLED=true;  DIRECT_ENABLED=true ;;
esac
API_KEY=""
DIRECT_API_SETTINGS=""
if [[ "$DIRECT_ENABLED" == true ]]; then
    API_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    DIRECT_API_SETTINGS="DIRECT_API_PORT=3002
DIRECT_API_KEY=$API_KEY"
fi

cat > .env << EOF
# 3Speak Encoder Configuration - $MODE_LABEL Mode
HIVE_USERNAME=$HIVE_USERNAME

# Persistent encoder identity. NOT your Hive key; keep it secret and backed up:
# losing it makes this machine a "new encoder".
ENCODER_PRIVATE_KEY=$ENCODER_PRIVATE_KEY

# Embed System - community encoding jobs from 3Speak
EMBED_SYSTEM_ENABLED=$EMBED_ENABLED
EMBED_SYSTEM_MODE=community
EMBED_GATEWAY_URL=https://embed.3speak.tv

# Direct API - private encoding requests from your own apps
DIRECT_API_ENABLED=$DIRECT_ENABLED
$DIRECT_API_SETTINGS

# IPFS Configuration
IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_GATEWAY_URL=https://ipfs.3speak.tv

# Local fallback: if a hotnode upload fails, pin locally and move it to a hotnode later.
# Off: a failed upload fails the job.
ENABLE_LOCAL_FALLBACK=false
REMOVE_LOCAL_AFTER_SYNC=true

# Encoder Configuration
TEMP_DIR=./temp
# FFmpeg found by the installer. Change it if you move or reinstall FFmpeg.
FFMPEG_PATH=$FFMPEG_BIN
FFPROBE_PATH=$FFPROBE_BIN
HARDWARE_ACCELERATION=true
MAX_CONCURRENT_JOBS=1

# Node Configuration
NODE_NAME=3speak-encoder-node
EOF
chmod 600 .env
ok "Configuration written to .env"

# ---------------------------------------------------------------------------
# Launcher: app menu entry (Linux desktops) or a double-clickable file (macOS)
# ---------------------------------------------------------------------------
if [[ "$OS" == linux ]]; then
    apps="$HOME/.local/share/applications"
    mkdir -p "$apps"
    # Terminal=true: the desktop opens it in the user's own terminal, whichever that is
    cat > "$apps/3speak-encoder.desktop" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=3Speak Encoder
Comment=Encode videos for 3Speak
Icon=video-x-generic
Exec=bash -c "cd '$INSTALL_DIR' && ./scripts/run-encoder.sh"
Path=$INSTALL_DIR
Terminal=true
Categories=AudioVideo;
EOF
    chmod +x "$apps/3speak-encoder.desktop"
    if [[ -d "$HOME/Desktop" ]]; then cp "$apps/3speak-encoder.desktop" "$HOME/Desktop/"; fi
    ok "Added '3Speak Encoder' to the app menu"
else
    launcher="$HOME/Desktop/3Speak Encoder.command"
    mkdir -p "$HOME/Desktop"
    printf '#!/bin/bash\ncd %q && ./scripts/run-encoder.sh\n' "$INSTALL_DIR" > "$launcher"
    chmod +x "$launcher"
    ok "Created '3Speak Encoder' on the Desktop (double-click to start)"
fi

# ---------------------------------------------------------------------------
# IPFS daemon
# ---------------------------------------------------------------------------
if ! ipfs_up; then
    echo "🚀 Starting the IPFS daemon..."
    if command -v screen >/dev/null; then
        screen -dmS ipfs-daemon "$IPFS_BIN" daemon
        echo "   (in screen session 'ipfs-daemon': screen -r ipfs-daemon)"
    else
        nohup "$IPFS_BIN" daemon > "${IPFS_PATH:-$HOME/.ipfs}/daemon.log" 2>&1 &
        echo "   (log: ${IPFS_PATH:-$HOME/.ipfs}/daemon.log)"
    fi
    for _ in $(seq 1 30); do ipfs_up && break; sleep 1; done
    ipfs_up || die "The IPFS daemon didn't start. Run 'ipfs daemon' in a terminal to see why."
fi
ok "IPFS daemon running"

# ---------------------------------------------------------------------------
# Final check, the same way the encoder will look things up
# ---------------------------------------------------------------------------
step "🩺 Checking the installation (npm run doctor)..."
npm run doctor --silent || die "The installation check found a problem (see above)"

echo ""
echo "🎉 3Speak Encoder installed!"
echo "   Folder:    $INSTALL_DIR"
echo "   Hive user: $HIVE_USERNAME"
echo "   Mode:      $ENCODER_MODE"
echo "   Dashboard: http://localhost:3001 (once it's running)"
if [[ -n "$API_KEY" ]]; then
    echo "   Direct API: http://localhost:3002, key: $API_KEY"
    echo "   Keep that key secret."
fi
echo ""
echo "   Start it with: cd $INSTALL_DIR && ./scripts/run-encoder.sh"

START_NOW="$(ask START_NOW '🚀 Start the encoder now? (y/n):')"
if [[ "$START_NOW" =~ ^[Yy] ]]; then
    if command -v xdg-open >/dev/null; then (sleep 5 && xdg-open http://localhost:3001 >/dev/null 2>&1) &
    elif command -v open >/dev/null; then (sleep 5 && open http://localhost:3001) &
    fi
    exec ./scripts/run-encoder.sh
fi
