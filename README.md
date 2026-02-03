# 3Speak Modern Video Encoder 🎬

A modern, production-ready video encoder with **dual-mode operation**, advanced resilience features, and IPFS storage management for decentralized video infrastructure.

## 🚀 Quick Start

**Get running in 2 minutes!**

### One-Command Installation

**Linux/Mac:**
```bash
wget https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh
chmod +x install.sh
./install.sh
```

**Windows:**
- **PowerShell:** `iwr -useb https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1 | iex`
- **Command Prompt:** Download and run `install.bat` directly

**Docker:**
```bash
docker run -d --name 3speak-encoder \
  -e HIVE_USERNAME=your-hive-username \
  -p 3001:3001 ghcr.io/mantequilla-soft/3speakencoder:latest
```

**Dashboard**: Open **http://localhost:3001** after starting

*Installers automatically handle Node.js, FFmpeg, and IPFS installation + daemon management!*

---

## 🌍 Why Run an Encoder?

- 🚀 **Support Web3 Creators** - Help process videos for decentralized platforms
- 🏗️ **Build the Future** - Contribute to decentralized video infrastructure  
- 💡 **Learn Encoding** - Understand video processing and IPFS
- 🎁 **Potential Rewards** - Future token incentives for network participants
- 🤝 **Join the Community** - Connect with other Web3 builders

**Requirements:**
- Decent internet connection
- Some CPU power
- Storage space (temp files cleaned automatically)

---

## 🎖️ Node Types

### Community Nodes (Default)
**Standard operation** for everyone:
- Gateway job polling and processing
- Direct API mode for private encoding
- Basic resilience and retry logic

### Approved Community Nodes
**Apply for Gateway Aid access** - REST API fallback for higher reliability:
- Continue encoding during gateway outages
- Automatic websocket failover  
- **Primary Mode**: Bypass legacy gateway entirely (recommended during outages)
- Same DID authentication
- No MongoDB required

**How to Apply**: Run reliably for a few weeks → Contact 3Speak with your DID → Enable Gateway Aid

**Primary Mode**: Set `GATEWAY_AID_PRIMARY=true` to poll Gateway Aid REST API directly instead of legacy gateway

### Community Encoders with Gateway Monitor (Recommended)
**Public REST API verification** - Prevent race conditions without database access:
- Check job ownership before claiming
- Avoid wasted work from duplicate processing
- REST API verification tier (between MongoDB and WebSocket)
- No special approval needed

**Enable**: Set `GATEWAY_MONITOR_ENABLED=true` in your `.env` file

### Infrastructure Nodes (3Speak Team)
**Maximum resilience** with direct database access:
- MongoDB verification fallback (ground truth)
- Force processing capability
- Rescue Mode (auto-claim abandoned jobs)
- IPFS Storage Management
- Complete gateway independence

**Note**: Requires MongoDB credentials from 3Speak team

---

## ✨ Key Features

### Core Functionality
- 🚀 **Dual-Mode Architecture**: Gateway jobs + Direct API for miniservice integration
- 🎬 **Multi-Quality Encoding**: Automatic 1080p, 720p, 480p HLS output
- 🔧 **Smart Codec Detection**: Hardware acceleration with automatic fallback and **cached detection** (instant startup after first run)
- 🔐 **DID Authentication**: Secure identity-based gateway authentication
- 🔑 **API Key Security**: Configurable authentication for direct API mode
- ⚡ **Hotnode Upload**: Intelligent traffic-directed uploads to fast IPFS nodes with automatic fallback

### Resilience & Reliability
- 🛡️ **Smart Retry System**: 5 attempts with result caching, skip wasteful re-processing
- 🎯 **Multi-Tier Upload Strategy**: Hotnode → Supernode → Local IPFS fallback chain
- ⚡ **Pinata-Style Completion**: Jobs finish instantly with CID, pinning runs in background
- 🔄 **Lazy Pinning Service**: Background pin queue with automatic retry and fallback
- 💪 **Production Ready**: Intelligent error handling and clean logging
- 📱 **Mobile Dashboard**: Monitor and control encoder from your phone

### Advanced Features (Infrastructure Nodes)
- 🗄️ **MongoDB Verification**: Direct database fallback when gateway APIs fail
- 🚁 **Rescue Mode**: Auto-claims abandoned jobs during outages (5min threshold, 2 jobs/cycle)
- 🔧 **Force Processing**: Emergency job processing via complete gateway bypass
- 📦 **IPFS Storage Management**: Password-protected web UI for pin migration and cleanup
- 🏠 **Local Fallback Pinning**: Continue encoding when supernode is overloaded
- 📊 **Pin Database**: SQLite tracking with automatic sync service

---

## 📦 Installation

### Recommended: Easy Installers

Use the one-command installers above - they handle everything automatically:

**Available Modes:**
- **Gateway Mode** - Process community videos
- **Direct API Mode** - Private encoder for your apps
- **Dual Mode** - Both community and private (best flexibility)

### Manual Installation

**Prerequisites:**
- Node.js 18+ ([nodejs.org](https://nodejs.org/))
- FFmpeg ([ffmpeg.org](https://ffmpeg.org/))
- IPFS ([ipfs.tech](https://ipfs.tech/))
- Git

```bash
git clone https://github.com/Mantequilla-Soft/3speakencoder.git
cd 3speakencoder
npm install
echo "HIVE_USERNAME=your-hive-username" > .env

# Start IPFS daemon (in another terminal)
ipfs daemon &

# Start the encoder
npm start
```

---

## 🌐 Web Dashboard

The dashboard provides real-time monitoring of:
- System status and health
- Active encoding jobs
- Processing statistics
- Error logs and debugging
- Resource usage monitoring
- IPFS Storage Management (nodes with local IPFS)

Access at **http://localhost:3001** after starting the encoder.

---

## ⚙️ Configuration

### Basic Configuration

Create a `.env` file with your Hive username:

```bash
HIVE_USERNAME=your-hive-username

# ⚠️ CRITICAL: Required for persistent encoder identity
# Without this, your encoder gets a new identity on every restart!
ENCODER_PRIVATE_KEY=auto-generated-see-logs-on-first-run
```

**🚨 IMPORTANT:** The `ENCODER_PRIVATE_KEY` is **required** for:
- ✅ **Persistent identity** - Same encoder ID across restarts
- ✅ **Dashboard tracking** - Proper job attribution
- ✅ **Gateway authentication** - Secure communication

**Generate key manually:**
```bash
node -e "console.log('ENCODER_PRIVATE_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

### Advanced Configuration

```bash
# Basic Settings
HIVE_USERNAME=your-hive-username
ENCODER_PRIVATE_KEY=your-generated-key-here

# Gateway Configuration
GATEWAY_URL=https://encoder.3speak.tv
QUEUE_MAX_LENGTH=1
QUEUE_CONCURRENCY=1
REMOTE_GATEWAY_ENABLED=true

# IPFS Configuration# Local or remote IPFS API address (multiaddr format)
# For local IPFS daemon: /ip4/127.0.0.1/tcp/5001
# For remote IPFS node: /ip4/192.168.1.100/tcp/5001IPFS_API_ADDR=/ip4/127.0.0.1/tcp/5001
THREESPEAK_IPFS_ENDPOINT=http://65.21.201.94:5002
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_GATEWAY_URL=https://ipfs.3speak.tv

# Encoder Configuration
TEMP_DIR=./temp
FFMPEG_PATH=/usr/bin/ffmpeg
HARDWARE_ACCELERATION=true
MAX_CONCURRENT_JOBS=1

# Hardware Detection (Optional)
# Force re-detection of hardware capabilities (bypasses cache)
# FORCE_HARDWARE_DETECTION=false  # Default: uses cached results for instant startup

# Direct API Configuration (optional)
DIRECT_API_ENABLED=false
DIRECT_API_PORT=3002
# DIRECT_API_KEY=your-secure-api-key-here

# MongoDB Verification (INFRASTRUCTURE NODES ONLY)
# 🚨 Requires MongoDB credentials from 3Speak team
MONGODB_VERIFICATION_ENABLED=false
# MONGODB_URI=mongodb://username:password@host:port/database
# DATABASE_NAME=spk-encoder-gateway

# Gateway Monitor (Optional - Stats & Verification)
# 🌐 Public REST API for dashboard stats and job verification
# No approval needed - available for all community encoders
GATEWAY_MONITOR_ENABLED=false
# GATEWAY_MONITOR_BASE_URL=https://gateway-monitor.3speak.tv/api

# IPFS Storage Management (LOCAL IPFS NODES)
# 🔐 Password-protected web UI for managing local IPFS pins
# Requires ENABLE_LOCAL_FALLBACK=true (local IPFS daemon)
# Available for both infrastructure and community nodes with local IPFS
# STORAGE_ADMIN_PASSWORD=your-secure-password-here

# Gateway Aid (APPROVED COMMUNITY NODES ONLY)
# ⚠️ Requires DID approval from 3Speak team
# REST API for job polling and processing
GATEWAY_AID_ENABLED=false
# GATEWAY_AID_PRIMARY=false  # Set to true to bypass legacy gateway entirely
# GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
```

### Configuration Examples

#### Community Node (Gateway Mode)
```bash
HIVE_USERNAME=your-hive-username
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=true
DIRECT_API_ENABLED=false
```

#### Private Encoder (Direct API Only)
```bash
HIVE_USERNAME=direct-api-encoder
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=false
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=your-secure-api-key-here
```

#### Dual Mode (Community + Private)
```bash
HIVE_USERNAME=your-hive-username
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=true
DIRECT_API_ENABLED=true
DIRECT_API_PORT=3002
DIRECT_API_KEY=your-secure-api-key-here
MAX_CONCURRENT_JOBS=4
```

#### Infrastructure Node (Maximum Resilience)
```bash
HIVE_USERNAME=infrastructure-node
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=true
DIRECT_API_ENABLED=true
MAX_CONCURRENT_JOBS=4

# MongoDB Direct Verification
MONGODB_VERIFICATION_ENABLED=true
MONGODB_URI=mongodb://username:password@host:port/database
DATABASE_NAME=spk-encoder-gateway

# Local IPFS Fallback + Storage Management
ENABLE_LOCAL_FALLBACK=true
STORAGE_ADMIN_PASSWORD=your-secure-password-here
``` - Fallback Mode)
```bash
HIVE_USERNAME=community-encoder
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=true
MAX_CONCURRENT_JOBS=2

# Gateway Aid Fallback (requires approval)
# Falls back to REST API if legacy gateway fails
GATEWAY_AID_ENABLED=true
GATEWAY_AID_PRIMARY=false
GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
```

#### Approved Community Node (Gateway Aid - Primary Mode)
```bash
HIVE_USERNAME=community-encoder
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=false
MAX_CONCURRENT_JOBS=2

# Gateway Aid Primary Mode (requires approval)
# Bypasses legacy gateway entirely - polls REST API directly
# Recommended during gateway outages or for approved nodes
GATEWAY_AID_ENABLED=true
GATEWAY_AID_PRIMARY=true
GATEWAY_AID_BASE_URL=https://gateway-monitor.3speak.tv/aid/v1
GATEWAY_AID_ENABLED=true
GATEWAY_AID_BASE_URL=https://encoder-gateway.infra.3speak.tv/aid
```

#### Community Node with Local IPFS Management
```bash
HIVE_USERNAME=community-encoder
ENCODER_PRIVATE_KEY=your-generated-key-here
REMOTE_GATEWAY_ENABLED=true
MAX_CONCURRENT_JOBS=2

# Local IPFS for pin management
ENABLE_LOCAL_FALLBACK=true
STORAGE_ADMIN_PASSWORD=your-secure-password-here
```

---

## 🛡️ Infrastructure Features

### Force Processing

When `MONGODB_VERIFICATION_ENABLED=true`, enables emergency job processing:

**Dashboard Features:**
- **Force Processing Section**: Bypass gateway completely
- **MongoDB Status Check**: Real-time database connectivity
- **Mobile Control**: Remote management via web dashboard

**How It Works:**
1. Complete Gateway Bypass - Direct MongoDB manipulation
2. 6-Step Force Pipeline: Claim → Download → Encode → Upload → Complete → Update DB
3. Emergency Recovery - Process stuck jobs when gateway is down

### Rescue Mode

Automatic failsafe for complete gateway outages:

**Features:**
- **Auto-Detection**: Runs every 60 seconds
- **5-Minute Threshold**: Only claims jobs stuck in "queued" for 5+ minutes
- **Rate Limited**: Max 2 jobs per rescue cycle
- **Safe Operation**: Never steals "running" jobs
- **Zero Intervention**: Completely automatic

**How It Works:**
1. Monitors MongoDB every 60 seconds for abandoned jobs
2. Identifies jobs in "queued" status for 5+ minutes
3. Auto-claims up to 2 jobs per cycle via MongoDB
4. Processes jobs offline (complete gateway bypass)
5. Updates completion status directly in database

See `docs/RESCUE_MODE.md` for complete documentation.

### IPFS Storage Management

Password-protected web interface for managing local IPFS pins:

**Configuration:**
```bash
MONGODB_VERIFICATION_ENABLED=true
MONGODB_URI=mongodb://username:password@host:port/database
STORAGE_ADMIN_PASSWORD=your-secure-password-here
```

**Dashboard Features:**
- **Password Protection**: Secure access control
- **Pin Listing**: View all recursively pinned items with metadata
- **Smart Migration**: DHT-based transfer to supernode (no bandwidth waste)
- **Batch Operations**: Select multiple pins for bulk migration
- **Local Cleanup**: Unpin items after successful migration
- **Garbage Collection**: Free up storage space on demand
- **Storage Statistics**: Real-time IPFS repo stats

**How Smart Migration Works:**
1. Select pins to migrate in dashboard
2. Request supernode to pin content (via remote pin API)
3. Supernode fetches content directly from local node via DHT
4. Verification polling ensures content arrived safely
5. Local cleanup after successful verification (optional)

**Benefits:**
- ⚡ **No Re-Upload**: Supernode fetches directly via IPFS network
- 🔒 **Safe Migration**: Verification before local deletion
- 📊 **Full Visibility**: See exactly what's stored locally
- 🧹 **Easy Cleanup**: Batch delete after migration
- 💾 **Space Management**: Monitor and optimize storage usage

**Access**: Dashboard → "IPFS Storage Management" section

---

## ⚡ Hotnode Upload System

### Traffic-Directed Fast Uploads

The encoder uses an intelligent multi-tier upload strategy for optimal speed and reliability:

**How It Works:**
1. **Traffic Director Query**: Request hotnode assignment from `cdn.3speak.tv/api/hotnode`
2. **Hotnode Upload**: Upload to assigned high-speed IPFS node
3. **Automatic Sync**: Hotnode handles migration to supernode storage
4. **Fallback Chain**: Automatic failover if hotnode unavailable

**Upload Tiers:**
- **Tier 1 - Hotnode** (Primary): Fast, load-balanced IPFS nodes for immediate UX
- **Tier 2 - Supernode** (Fallback): Direct upload to long-term storage node
- **Tier 3 - Local IPFS** (Emergency): Local daemon for complete independence

**Benefits:**
- ⚡ **Lightning Fast**: Hotnode prioritizes speed for instant platform UX
- 🔄 **Zero Config**: Traffic director handles load balancing automatically
- 🛡️ **Resilient**: Automatic fallback to proven supernode path
- 🎯 **Transparent**: Same CID reporting, no pipeline changes
- 📊 **Scalable**: Hotnodes scale horizontally as needed

**Traffic Director Response:**
```json
{
  "success": true,
  "data": {
    "name": "Hot Node One",
    "uploadEndpoint": "https://hotipfs-1.3speak.tv/api/v0/add",
    "healthEndpoint": "https://admin-hotipfs-1.3speak.tv/health",
    "owner": "3Speak"
  }
}
```

**Architecture:**
- Hotnodes: Fast UX layer, handle immediate uploads
- Supernodes: Long-term storage, eventual consistency target
- Traffic Director: Dynamic hotnode assignment with health checking
- Encoders: Intelligent upload with automatic tier fallback

**No Configuration Required** - Hotnode system is automatic and transparent!

---

## 🚀 Usage

### Gateway Mode (3Speak Jobs)
The encoder automatically:
1. Connects to 3Speak gateway
2. Polls for available encoding jobs
3. Downloads source videos
4. Processes to multiple qualities (1080p, 720p, 480p)
5. Uploads HLS segments to IPFS
6. Reports completion to gateway

### API Mode (Direct Requests)
Send encoding requests directly:

```bash
curl -X POST http://localhost:3002/api/encode \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "videoUrl": "https://example.com/video.mp4",
    "title": "My Video",
    "description": "Video description"
  }'
```

---

## 🔧 Development

### Building
```bash
npm run build
```

### Running in Development
```bash
npm run dev
```

### Testing
```bash
# Test MongoDB connectivity
node tests/test-mongodb-connection.js

# Test force processing
npx ts-node tests/test-mongo-force.ts

# Run full test suite
npx ts-node tests/test-services.ts
```

See `tests/README.md` for complete testing documentation.

---

## 🚨 Troubleshooting

### Common Issues

#### Dashboard Shows "Offline"
- Check if encoder process is running
- Verify network connectivity
- Look for errors in console output
- Encoder may still work despite showing "offline"

#### Gateway 500 Errors
- Usually temporary server issues
- Smart retry system handles these automatically
- Check dashboard for actual job completion status

#### FFmpeg Not Found
```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg

# Windows
choco install ffmpeg
```

#### IPFS Connection Issues
```bash
# Check if IPFS daemon is running
curl -s http://127.0.0.1:5001/api/v0/id

# Start IPFS daemon if not running
ipfs daemon
```

#### Hardware Acceleration Not Working

The encoder automatically detects and caches hardware capabilities:

**First Run:**
- Tests VAAPI, NVENC, QSV codecs (~5-10 seconds)
- Saves results to `.hardware-cache.json`
- Uses best available codec

**Subsequent Runs:**
- Loads cached results instantly (<1ms)
- Cache valid for 30 days
- Auto-invalidates if FFmpeg version changes

**Force Re-Detection:**
```bash
# Bypass cache and re-test hardware
FORCE_HARDWARE_DETECTION=true npm start

# Or manually delete cache
rm temp/.hardware-cache.json
```

**Common Issues:**
- **VAAPI not working**: Add user to 'render' group
  ```bash
  sudo usermod -a -G render $USER
  # Then logout/login
  ```
- **NVENC not working**: Update NVIDIA drivers
- **Software fallback**: Encoder automatically uses libx264 if hardware fails

# Start IPFS daemon
ipfs daemon
```

#### Missing ENCODER_PRIVATE_KEY
```bash
# Generate a new key
node -e "console.log('ENCODER_PRIVATE_KEY=' + require('crypto').randomBytes(32).toString('base64'))"

# Add to .env file
echo "ENCODER_PRIVATE_KEY=YourGeneratedKeyHere" >> .env
```

### Getting Help

1. Check logs in the dashboard
2. Verify FFmpeg and IPFS are installed
3. Ensure network connectivity
4. Join our Discord community
5. Create GitHub issues for bugs

---

## 📚 API Documentation

### Health Check
```bash
GET /api/health
```

### Encode Video
```bash
POST /api/encode
Content-Type: application/json
Authorization: Bearer your-api-key

{
  "videoUrl": "https://example.com/video.mp4",
  "title": "Video Title",
  "description": "Video Description",
  "tags": ["tag1", "tag2"]
}
```

### Job Status
```bash
GET /api/jobs/:jobId
Authorization: Bearer your-api-key
```

---

## 🤝 Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

---

## 📄 License

MIT License - see LICENSE file for details.

---

## 🆘 Support

- **GitHub Issues**: Report bugs and request features
- **Discord**: Join our community for real-time support
- **Documentation**: Check our comprehensive guides
- **Email**: Contact the 3Speak team

---

**Ready to help decentralize video? Get started with the one-command installers above! 🚀**
