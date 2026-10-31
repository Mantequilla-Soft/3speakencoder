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

**Windows (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1 | iex
```

**Docker** (encoder + its own IPFS node):
```bash
git clone https://github.com/Mantequilla-Soft/3speakencoder.git && cd 3speakencoder
cp .env.example .env        # set HIVE_USERNAME and ENCODER_PRIVATE_KEY
GIT_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.production.yml up -d --build
```
The encoder needs an IPFS daemon; the compose file runs one next to it. A bare `docker run` of the image has none and won't start.

**Dashboard**: `http://localhost:3001`

### Manual Installation

**Prerequisites:** Node.js 18+ (22 recommended, it's what CI tests), FFmpeg, IPFS daemon

```bash
git clone https://github.com/Mantequilla-Soft/3speakencoder.git
cd 3speakencoder
npm ci                    # exact dependencies from package-lock.json
npm run setup             # asks for your Hive username, writes .env (or: cp .env.example .env and edit)
./scripts/run-encoder.sh  # or: npm start
```

`npm start` compiles first (about 5 seconds), so there's no separate build step. Starting through `scripts/run-encoder.sh` (Windows: `scripts\run-encoder.ps1`) lets the encoder restart itself after an update from the dashboard.

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

# Where uploads go (the default is fine) and the gateway used to read videos
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_GATEWAY_URL=https://ipfs.3speak.tv

# If a hotnode upload fails: pin on this node and move it to a hotnode later (see Uploads)
ENABLE_LOCAL_FALLBACK=false
REMOVE_LOCAL_AFTER_SYNC=true

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

### Everything else

[`.env.example`](.env.example) lists every setting with an explanation, including the dashboard (`DASHBOARD_*`), self-update (`SELF_UPDATE_ENABLED`, `UPDATE_PASSWORD`), the version check (`VERSION_CHECK_*`) and gated content (`GATE_*`).

---

## Dashboard

Live view of the encoder at `http://localhost:3001`:

- **Top bar:** encoder state and how long since the last pulse, version, and whether the page's link to the encoder is up. The browser tab's title and icon show the state too. **Install app** appears there when the browser can install the dashboard (see [Install as an app](#install-as-an-app)).
- **Current job:** the video being encoded, its qualities and progress. The tile's border turns blue while it works.
- **Health:** event-loop lag (how responsive the encoder process is), the worst lag since start, uptime.
- **Recent jobs** and **Needs attention** (failed jobs, with Retry).
- **Log:** the live log stream.
- **Details:** DID key, IPFS peer ID, full commit, and **Check for updates**.
- **Local IPFS storage** tools, on nodes with `ENABLE_LOCAL_FALLBACK=true`.
- An **update** tile when a newer version is available (see [Updating](#updating)).

Encoder states: **Online** (idle, waiting for work), **Encoding**, **Starting**, **Not responding** (no pulse for 15s; the process may be frozen), **Unreachable** (the page can't reach the encoder: it stopped or crashed, or port 3001 is blocked), **Offline** (the encoder is shutting down).

### Install as an app

The dashboard can be installed like an app on a phone or computer: it gets its own icon and opens in its own window.

- **Chrome, Edge, Android:** click **Install app** in the top bar (or the install icon in the address bar).
- **iPhone and iPad:** in Safari, Share, then **Add to Home Screen**.
- **Mac Safari:** File, then **Add to Dock**.

Browsers only offer this when the dashboard is opened over **HTTPS** (or on `localhost`). Opened as `http://192.168.x.x:3001` from another device, it works as a normal page but can't be installed. To install it on your phone, put the dashboard behind a reverse proxy with a certificate (Caddy, nginx, a Cloudflare tunnel), make it pass the original `Host` header through (Caddy does by default; in nginx add `proxy_set_header Host $host;`, plus the WebSocket upgrade headers for the live log), add the name to `DASHBOARD_ALLOWED_HOSTS`, and consider `DASHBOARD_PASSWORD` since it's now reachable from outside.

### Dashboard security

By default the dashboard listens on **all interfaces**, so you can open it from another machine on your network, and it has **no password**. Anyone who can reach port 3001 can:

- read status, job details and the live log stream;
- retry or release jobs (the only state-changing actions).

To restrict it:

```bash
DASHBOARD_HOST=127.0.0.1     # only this machine can open the dashboard
DASHBOARD_PASSWORD=change-me # asked for (once per browser session) before retry/release
DASHBOARD_PORT=3001
DASHBOARD_ALLOWED_HOSTS=encoder.lan  # extra hostnames you open the dashboard by (IPs and localhost always work)
```

Protection against other websites you have open:

- The dashboard only answers requests addressed to an IP address, `localhost`, or this machine's own name. This blocks *DNS rebinding*, where a malicious site points its own domain at your machine to make its requests look same-origin. If you open the dashboard by another name (for example `http://encoder.lan:3001`), add it: `DASHBOARD_ALLOWED_HOSTS=encoder.lan`.
- Requests and live-log connections sent by another site's page (a foreign `Origin`) are refused.
- Retry and release also require an `X-Dashboard-Request: 1` header, which the dashboard page sends.

The IPFS storage tools have their own password (`STORAGE_ADMIN_PASSWORD`).

Running in Docker? `docker-compose.production.yml` publishes port 3001 to the host, so the same applies to the host's network.

---

## Updating

The dashboard shows which commit the encoder runs and how many commits it is behind `main` (checked every ~6h through the GitHub API, read-only). To check right away, click **Check for updates** under Details (at most one GitHub request a minute).

**By hand** (any install):

```bash
git pull && npm ci && npm start
```

**From the dashboard** (opt-in; Linux and macOS git installs only, not Docker or Windows yet). Add to `.env`:

```bash
SELF_UPDATE_ENABLED=true
UPDATE_PASSWORD=choose-a-strong-password
```

When the encoder is behind, the dashboard offers **Update now**. The encoder then:

1. stops taking new jobs (embed heartbeats continue; Direct API answers 503) and waits until every job, including scheduled retries, is finished. You can cancel during this wait;
2. fast-forwards to `origin/main`, runs `npm ci` and `npm run build`;
3. on any failure, goes back to the previous commit (`git reset --hard`, `npm ci`, `npm run build`) and resumes taking jobs;
4. on success, restarts through the restart wrapper (required: the dashboard won't offer the update otherwise).
5. if the new version exits with an error within its first minute, the wrapper rolls back to the previous commit and starts that instead.

Self-update needs the encoder to be started through the wrapper, which restarts it after an update (the installers' shortcuts already do):

```bash
./scripts/run-encoder.sh                                          # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\run-encoder.ps1  # Windows
```

It refuses to update if the encoder wasn't started with the wrapper, the checkout has local changes, isn't on `main` tracking `origin/main`, has diverged from it, or has no `package-lock.json`; the dashboard lists which check fails. Docker installs update by pulling the new image: `docker compose pull && docker compose up -d`.

---

## Uploads

Every encoded video goes to a **hotnode**: an IPFS node the traffic director (`TRAFFIC_DIRECTOR_URL`) picks for each upload. The 3Speak supernode is not used.

If the hotnode upload fails (no hotnode available, network error, timeout):

- **`ENABLE_LOCAL_FALLBACK=true`:** the encoder pins the video on its own IPFS daemon, reports the job as done, and moves the video to a hotnode later. Every 5 minutes it asks the traffic director for a hotnode and re-uploads pending pins, one at a time, backing off after failures (5 min, 1 h, 6 h, then daily). A migration only counts once the hotnode returns the same CID the job reported. Then the local copy is unpinned (unless `REMOVE_LOCAL_AFTER_SYNC=false`). The dashboard's storage tools show each of these videos as *pending migration*, *migrated*, *unpinned* or *deleted*, with dates, links to the video and its CID, and a reachability check. They can also send one to a hotnode right away. See [docs/local-fallback-pinning.md](docs/local-fallback-pinning.md).
- **`ENABLE_LOCAL_FALLBACK=false`** (default): the job fails, the dispatcher gets a failure webhook, and the encoder does not retry it.

Local fallback needs disk space for the pinned videos and an IPFS daemon that stays up until they're moved.

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
npm start              # build, then run from source with tsx
npm run dev            # same, restarting on changes in src/ (the encode worker runs from dist/: rebuild after changing src/workers/)
npm run start:compiled # run the compiled dist/ with plain node (what Docker does)
npm run typecheck      # tsc on src/ and the unit tests
npm run test:unit      # vitest, tests/unit/
npm run build          # compile to dist/ (the encode worker always runs from dist/)
```

CI runs `npm ci`, `typecheck`, `test:unit` and `build` on Linux and Windows for every push and PR.

---

## Troubleshooting

**The encoder never gets jobs**
- At startup it logs `No job source enabled` if neither the embed system nor the Direct API is on. Set `EMBED_SYSTEM_ENABLED=true`, `EMBED_SYSTEM_MODE=community` and `EMBED_GATEWAY_URL=https://embed.3speak.tv`. Encoders installed with the old installer's "Gateway mode" need this.

**Dashboard shows "Offline", "Not responding" or "Unreachable"**
- *Offline*: the encoder is shutting down (you only see this for a moment).
- *Not responding*: the process is running but stopped answering for 15s or more. If it doesn't recover by itself, check CPU and memory, and look for 🐢 lines in `encoder.log`.
- *Unreachable*: the page can't reach the encoder at all. Usually the process stopped or crashed: check its terminal or `encoder.log`. If it's running, check that port 3001 is open.

**Dashboard says "Host not allowed"**
- You opened it by a name other than an IP address, `localhost` or the machine's own name. Add that name to `DASHBOARD_ALLOWED_HOSTS` in `.env` (comma-separated) and restart.

**`npm start` stops with "the build failed"**
- `npm start` rebuilds first and refuses to start on a failed build, so the encoder never runs half-updated code.
- `EACCES: permission denied` means some files belong to another user, usually because `git pull`, `npm` or the encoder was once run with `sudo`. On macOS and Linux, give them back and make them writable, then start again: `sudo chown -R $(whoami): . && chmod -R u+w .` in the encoder folder. After that, run everything without `sudo`.
- Type errors (`error TS…`) after a `git pull`: run `npm ci` to update dependencies, then `npm start` again.

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
