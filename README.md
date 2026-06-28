# 3Speak Encoder v2

A production-ready video encoder for the 3Speak platform. v2 drops the legacy `encoder.3speak.tv` gateway entirely and runs exclusively through the embed system (`embed.3speak.tv`).

## How It Works

Two job entry points feed a single encoding pipeline:

| Mode | How jobs arrive | Who uses it |
|------|----------------|-------------|
| **Community** | Encoder polls `embed.3speak.tv` every 60s (JWS auth) | Community-operated encoders |
| **Managed** | 3Speak pushes jobs via `POST /encode` on port 3002 | 3Speak-administered encoders |

Both modes use the same path: download → encode → IPFS upload → webhook callback.

---

## Quick Start

### One-Command Installation

**Linux/Mac:**
```bash
wget https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh
chmod +x install.sh
./install.sh
```

**Docker:**
```bash
docker run -d --name 3speak-encoder \
  -e ENCODER_PRIVATE_KEY=your-key \
  -e EMBED_SYSTEM_ENABLED=true \
  -e EMBED_SYSTEM_MODE=community \
  -e EMBED_GATEWAY_URL=https://embed.3speak.tv \
  -p 3001:3001 ghcr.io/mantequilla-soft/3speakencoder:latest
```

**Dashboard**: `http://localhost:3001`

### Manual Installation

**Prerequisites:** Node.js 18+, FFmpeg, IPFS daemon

```bash
git clone https://github.com/Mantequilla-Soft/3speakencoder.git
cd 3speakencoder
npm install && npm run build
cp .env.example .env   # then edit
npm start
```

---

## Configuration

### Required

```bash
# Your Hive account name
HIVE_USERNAME=your-hive-username

# Persistent encoder identity — generated on first run, then save to .env
# Without this your encoder gets a new DID on every restart
ENCODER_PRIVATE_KEY=auto-generated-see-logs-on-first-run
```

### Community Mode (polling embed.3speak.tv)

```bash
EMBED_SYSTEM_ENABLED=true
EMBED_SYSTEM_MODE=community
EMBED_GATEWAY_URL=https://embed.3speak.tv
```

### Managed Mode (3Speak pushes jobs to you)

```bash
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=your-secure-api-key-here
```

### IPFS

```bash
# Local IPFS daemon API (default)
IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001

# Upload endpoints (defaults are fine for most nodes)
THREESPEAK_IPFS_ENDPOINT=http://65.21.201.94:5002
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_GATEWAY_URL=https://ipfs.3speak.tv

# Local IPFS fallback — pin locally when remote fails
ENABLE_LOCAL_FALLBACK=false

# IPFS Storage Management UI (requires ENABLE_LOCAL_FALLBACK=true)
STORAGE_ADMIN_PASSWORD=your-secure-password
```

### Encoder Tuning

```bash
HARDWARE_ACCELERATION=true        # VAAPI/NVENC/QSV auto-detected and cached
MAX_CONCURRENT_JOBS=1
ARIA2_CONNECTIONS=12              # parallel download connections (requires aria2)
TEMP_DIR=./temp
```

### Full .env Reference

```bash
# Identity
HIVE_USERNAME=your-hive-username
ENCODER_PRIVATE_KEY=your-key

# Community polling
EMBED_SYSTEM_ENABLED=false
EMBED_SYSTEM_MODE=community         # community | managed
EMBED_GATEWAY_URL=https://embed.3speak.tv

# Managed / push mode
DIRECT_API_ENABLED=false
DIRECT_API_PORT=3002
DIRECT_API_KEY=

# IPFS
IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001
THREESPEAK_IPFS_ENDPOINT=http://65.21.201.94:5002
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_CLUSTER_ENDPOINT=http://65.21.201.94:9094
IPFS_GATEWAY_URL=https://ipfs.3speak.tv
ENABLE_LOCAL_FALLBACK=false
REMOVE_LOCAL_AFTER_SYNC=true
STORAGE_ADMIN_PASSWORD=

# Encoder
HARDWARE_ACCELERATION=true
MAX_CONCURRENT_JOBS=1
ARIA2_CONNECTIONS=12
TEMP_DIR=./temp
FFMPEG_PATH=
```

---

## Dashboard

Real-time monitoring at `http://localhost:3001`:

- Node status, DID key, IPFS peer ID, version
- Active and failed jobs with retry controls
- Live log stream
- IPFS Storage Management (when `ENABLE_LOCAL_FALLBACK=true`)

---

## Upload Strategy

The encoder uses a tiered upload strategy automatically:

1. **Hotnode** — fast, load-balanced IPFS node assigned by traffic director
2. **Supernode** — direct upload to long-term storage (fallback)
3. **Local IPFS** — local daemon (fallback when `ENABLE_LOCAL_FALLBACK=true`)

No configuration required — the traffic director handles hotnode assignment.

---

## Download Acceleration

Install [aria2](https://aria2.github.io/) for parallel multi-connection downloads (recommended on high-latency links):

| Platform | Command |
|----------|---------|
| Ubuntu/Debian | `sudo apt install aria2` |
| macOS | `brew install aria2` |
| Arch | `sudo pacman -S aria2` |
| Windows | Download from [aria2 releases](https://github.com/aria2/aria2/releases/latest) |

Falls back silently to single-stream if aria2 is not installed.

---

## Development

```bash
npm run build       # compile TypeScript
npm run dev         # watch mode
npm start           # run compiled output
```

---

## Troubleshooting

**Dashboard shows "Offline"**
- Check the encoder process is running
- Look for errors in the terminal output

**FFmpeg not found**
```bash
sudo apt install ffmpeg          # Ubuntu/Debian
brew install ffmpeg              # macOS
choco install ffmpeg             # Windows
```

**IPFS connection issues**
```bash
curl -s http://127.0.0.1:5001/api/v0/id   # check daemon
ipfs daemon                                 # start if needed
```

**Hardware acceleration not working**

Detection results are cached in `temp/.hardware-cache.json`. Force re-detection:
```bash
FORCE_HARDWARE_DETECTION=true npm start
# or
rm temp/.hardware-cache.json
```

Add your user to the `render` group if VAAPI fails:
```bash
sudo usermod -a -G render $USER
```

**Missing ENCODER_PRIVATE_KEY**
```bash
node -e "console.log('ENCODER_PRIVATE_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

---

## License

MIT — see LICENSE file.
