#!/bin/bash

# 3Speak Encoder - Easy Linux Setup Script
# Run with: curl -sSL https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh | bash

set -e

echo "🚀 3Speak Video Encoder - Easy Setup"
echo "====================================="sh

# 3Speak Encoder - Easy Linux Setup Script
# Run with: curl -sSL https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh | bash

set -e

echo "🚀 3Speak Video Encoder - Easy Setup"
echo "====================================="

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "❌ Don't run this script as root! Run as your normal user."
   exit 1
fi

# Detect OS
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="mac"
else
    echo "❌ Unsupported OS: $OSTYPE"
    echo "Please use Windows installer or manual installation"
    exit 1
fi

echo "✅ Detected OS: $OS"

# Check for required tools
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo "❌ $1 is not installed"
        return 1
    else
        echo "✅ $1 is available"
        return 0
    fi
}

# Install dependencies based on OS
install_deps() {
    if [[ "$OS" == "linux" ]]; then
        if command -v apt &> /dev/null; then
            echo "📦 Installing dependencies with apt..."
            sudo apt update
            sudo apt install -y nodejs npm ffmpeg git curl aria2
        elif command -v yum &> /dev/null; then
            echo "📦 Installing dependencies with yum..."
            sudo yum install -y nodejs npm ffmpeg git curl aria2
        elif command -v pacman &> /dev/null; then
            echo "📦 Installing dependencies with pacman..."
            sudo pacman -S nodejs npm ffmpeg git curl aria2
        else
            echo "❌ Unsupported Linux distribution. Please install manually:"
            echo "   - Node.js 18+"
            echo "   - npm"
            echo "   - ffmpeg" 
            echo "   - git"
            echo "   - aria2"
            exit 1
        fi
    elif [[ "$OS" == "mac" ]]; then
        if ! command -v brew &> /dev/null; then
            echo "📦 Installing Homebrew..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        fi
        echo "📦 Installing dependencies with brew..."
        brew install node ffmpeg git aria2
    fi
}

# Install IPFS
install_ipfs() {
    if [[ "$OS" == "linux" ]]; then
        echo "📦 Installing IPFS for Linux..."
        
        # Download and install IPFS
        IPFS_VERSION="0.23.0"
        ARCH=$(uname -m)
        
        if [[ "$ARCH" == "x86_64" ]]; then
            IPFS_ARCH="amd64"
        elif [[ "$ARCH" == "aarch64" ]] || [[ "$ARCH" == "arm64" ]]; then
            IPFS_ARCH="arm64"
        else
            echo "❌ Unsupported architecture: $ARCH"
            exit 1
        fi
        
        cd /tmp
        wget -O kubo.tar.gz "https://dist.ipfs.tech/kubo/v${IPFS_VERSION}/kubo_v${IPFS_VERSION}_linux-${IPFS_ARCH}.tar.gz"
        tar -xzf kubo.tar.gz
        cd kubo
        sudo bash install.sh
        cd ..
        rm -rf kubo kubo.tar.gz
        
        # Initialize IPFS
        if [ ! -d ~/.ipfs ]; then
            echo "🔧 Initializing IPFS..."
            ipfs init
        fi
        
    elif [[ "$OS" == "mac" ]]; then
        echo "📦 Installing IPFS with brew..."
        brew install ipfs
        
        # Initialize IPFS  
        if [ ! -d ~/.ipfs ]; then
            echo "🔧 Initializing IPFS..."
            ipfs init
        fi
    fi
}

# Start IPFS daemon
start_ipfs_daemon() {
    echo "🚀 Starting IPFS daemon in background..."
    
    # Start IPFS daemon in screen session so it persists
    if command -v screen &> /dev/null; then
        screen -dmS ipfs-daemon ipfs daemon
        echo "💡 IPFS daemon started in screen session 'ipfs-daemon'"
        echo "   Use 'screen -r ipfs-daemon' to view logs"
    else
        # Fallback: start in background with nohup
        nohup ipfs daemon > ~/.ipfs/daemon.log 2>&1 &
        echo "💡 IPFS daemon started in background"
        echo "   Logs available at: ~/.ipfs/daemon.log"
    fi
    
    # Wait a moment for daemon to start
    echo "⏳ Waiting for IPFS daemon to start..."
    sleep 3
    
    # Verify daemon is running
    for i in {1..10}; do
        if curl -s --connect-timeout 1 http://127.0.0.1:5001/api/v0/id >/dev/null 2>&1; then
            echo "✅ IPFS daemon is now running!"
            return 0
        fi
        sleep 1
    done
    
    echo "⚠️ IPFS daemon might not be ready yet. The encoder will check again when it starts."
}

# Check if dependencies are installed
echo ""
echo "🔍 Checking dependencies..."

NEED_INSTALL=false

if ! check_command node; then NEED_INSTALL=true; fi
if ! check_command npm; then NEED_INSTALL=true; fi
if ! check_command ffmpeg; then NEED_INSTALL=true; fi
if ! check_command git; then NEED_INSTALL=true; fi

if [[ "$NEED_INSTALL" == "true" ]]; then
    echo ""
    echo "📦 Installing missing dependencies..."
    install_deps
    echo "✅ Dependencies installed!"
fi

# Check IPFS installation and daemon status
echo ""
echo "📦 Checking IPFS..."

if ! check_command ipfs; then
    echo "⚠️ IPFS not found. Installing IPFS..."
    install_ipfs
    echo "✅ IPFS installed!"
else
    echo "✅ IPFS is installed"
fi

# Check if IPFS daemon is running
if ! curl -s --connect-timeout 3 http://127.0.0.1:5001/api/v0/id >/dev/null 2>&1; then
    echo "⚠️ IPFS daemon is not running. Starting IPFS daemon..."
    start_ipfs_daemon
    echo "✅ IPFS daemon started!"
else
    echo "✅ IPFS daemon is running"
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [[ $NODE_VERSION -lt 18 ]]; then
    echo "❌ Node.js version $NODE_VERSION is too old. Need 18+."
    echo "Please update Node.js from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Choose encoder mode
echo ""
echo "🎯 Choose your encoder mode:"
echo "  1) Embed Community - Encode videos for the 3Speak community (recommended)"
echo "  2) Direct API Mode - Private encoder for your apps (direct requests only)"
echo "  3) Dual Mode - Community jobs AND a private direct API (for developers)"
echo ""
read -p "Enter your choice (1, 2, or 3): " MODE_CHOICE

case $MODE_CHOICE in
    1)
        ENCODER_MODE="embed"
        echo "✅ Embed Community Mode selected - you'll help encode videos for the 3Speak community"
        ;;
    2)
        ENCODER_MODE="direct"
        echo "✅ Direct API Mode selected - private encoder for your applications"
        ;;
    3)
        ENCODER_MODE="dual"
        echo "✅ Dual Mode selected - community jobs plus your private direct API"
        ;;
    *)
        echo "❌ Invalid choice. Defaulting to Embed Community Mode."
        ENCODER_MODE="embed"
        ;;
esac

# Get Hive username (required for community modes, optional for direct-only)
echo ""
if [[ "$ENCODER_MODE" == "direct" ]]; then
    echo "👤 Hive username (optional for direct-API-only mode):"
    read -p "Hive username (or press Enter to skip): " HIVE_USERNAME
    if [[ -z "$HIVE_USERNAME" ]]; then
        HIVE_USERNAME="direct-api-encoder"
        echo "ℹ️ Using default username: $HIVE_USERNAME"
    fi
else
    echo "👤 What's your Hive username? (required for encoding)"
    read -p "Hive username: " HIVE_USERNAME
    if [[ -z "$HIVE_USERNAME" ]]; then
        echo "❌ Hive username is required for community encoding"
        exit 1
    fi
fi

# Clone and setup encoder
echo ""
echo "📥 Downloading 3Speak Encoder..."

INSTALL_DIR="$HOME/3speak-encoder"

if [[ -d "$INSTALL_DIR" ]]; then
    echo "📁 Directory exists, updating..."
    cd "$INSTALL_DIR"
    git pull
else
    git clone https://github.com/Mantequilla-Soft/3speakencoder.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

echo "📦 Installing npm packages..."
npm install

echo "🔨 Building encoder..."
# Not fatal (set -e): tsc still emits JavaScript on type errors, and `npm start` rebuilds anyway
npm run build || echo "⚠️  Build reported errors - continuing; npm start will rebuild"

# Generate API key for direct modes
if [[ "$ENCODER_MODE" == "direct" ]] || [[ "$ENCODER_MODE" == "dual" ]]; then
    echo ""
    echo "🔑 Generating secure API key for direct requests..."
    # Generate a secure random API key
    API_KEY=$(openssl rand -hex 32 2>/dev/null || xxd -l 32 -p /dev/urandom | tr -d '\n' || head -c 64 /dev/urandom | base64 | tr -d '\n' | head -c 64)
    echo "✅ Generated secure API key: ${API_KEY:0:16}..."
    echo "⚠️  Keep this key secret - you'll need it to make API requests!"
fi

# Preserve or generate encoder private key for persistent identity
echo ""
if [[ -f .env ]]; then
    ENCODER_PRIVATE_KEY=$(sed -n 's/^ENCODER_PRIVATE_KEY=//p' .env | head -n1)
fi

if [[ -z "$ENCODER_PRIVATE_KEY" ]]; then
    echo "🔑 Generating new encoder identity..."
    ENCODER_PRIVATE_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
    echo "✅ Generated persistent encoder identity"
else
    echo "✅ Reusing existing encoder identity"
fi

# Create .env file based on mode
echo "⚙️  Creating configuration..."

case $ENCODER_MODE in
    embed)  MODE_LABEL="Embed Community"; EMBED_ENABLED=true;  DIRECT_ENABLED=false ;;
    direct) MODE_LABEL="Direct API";      EMBED_ENABLED=false; DIRECT_ENABLED=true ;;
    dual)   MODE_LABEL="Dual";            EMBED_ENABLED=true;  DIRECT_ENABLED=true ;;
esac

if [[ "$DIRECT_ENABLED" == "true" ]]; then
    DIRECT_API_SETTINGS="DIRECT_API_PORT=3002
DIRECT_API_KEY=$API_KEY"
else
    DIRECT_API_SETTINGS=""
fi

cat > .env << EOF
# 3Speak Encoder Configuration - $MODE_LABEL Mode
HIVE_USERNAME=$HIVE_USERNAME

# 🚨 CRITICAL: DID Identity Authentication Key (REQUIRED for persistent identity)
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
THREESPEAK_IPFS_ENDPOINT=http://65.21.201.94:5002
TRAFFIC_DIRECTOR_URL=https://cdn.3speak.tv/api/hotnode
IPFS_GATEWAY_URL=https://ipfs.3speak.tv

# IPFS Cluster Support (optional - reduces main daemon load)
USE_CLUSTER_FOR_PINS=false
IPFS_CLUSTER_ENDPOINT=http://65.21.201.94:9094

# Local Fallback Pinning (optional - for 3Speak-operated encoder nodes)
ENABLE_LOCAL_FALLBACK=false
LOCAL_FALLBACK_THRESHOLD=3
REMOVE_LOCAL_AFTER_SYNC=true

# Encoder Configuration
TEMP_DIR=./temp
# FFMPEG_PATH is optional - ffmpeg is found on your PATH automatically.
# FFMPEG_PATH=/path/to/ffmpeg
HARDWARE_ACCELERATION=true
MAX_CONCURRENT_JOBS=1

# Node Configuration
NODE_NAME=3speak-encoder-node
EOF

# Create desktop shortcut (Linux with GUI)
if [[ "$OS" == "linux" ]] && [[ -n "$DISPLAY" ]]; then
    DESKTOP_FILE="$HOME/Desktop/3Speak-Encoder.desktop"
    cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=3Speak Encoder
Comment=Help encode videos for 3Speak
Icon=video-x-generic
Exec=gnome-terminal -- bash -c "cd '$INSTALL_DIR' && npm start; exec bash"
Path=$INSTALL_DIR
Terminal=false
Categories=AudioVideo;
EOF
    chmod +x "$DESKTOP_FILE"
    echo "🖥️  Desktop shortcut created!"
fi

# Success message
echo ""
echo "🎉 3Speak Encoder installed successfully!"
echo ""
echo "📍 Installation directory: $INSTALL_DIR"
echo "👤 Configured for user: $HIVE_USERNAME"
echo "🎯 Mode: $(echo $ENCODER_MODE | tr '[:lower:]' '[:upper:]')"
echo ""

# Mode-specific instructions
if [[ "$ENCODER_MODE" == "embed" ]]; then
    echo "🌐 Embed Community Mode:"
    echo "   • Dashboard: http://localhost:3001"
    echo "   • Polls the 3Speak embed system every 60 seconds for encoding jobs"
    echo "   • Automatically registers and maintains heartbeat"
    echo "   • Reports progress and completion via webhooks"
else
    if [[ "$ENCODER_MODE" == "dual" ]]; then
        echo "🚀 Dual Mode - Community + Direct API:"
        echo "   • Processes 3Speak community jobs AND your direct requests"
    else
        echo "🔌 Direct API Mode - Private Encoding:"
    fi
    echo "   • Dashboard: http://localhost:3001"
    echo "   • API Endpoint: http://localhost:3002"
    echo "   • Your API Key: $API_KEY"
    echo "   • Use this key to make direct encoding requests to your encoder"
    echo ""
    echo "📝 Example API Request:"
    echo "   curl -X POST http://localhost:3002/encode \\"
    echo "        -H \"Authorization: Bearer $API_KEY\" \\"
    echo "        -H \"Content-Type: application/json\" \\"
    echo "        -d '{\"owner\":\"alice\", \"permlink\":\"my-video\", \"input_cid\":\"Qm...\", \"short\":false, \"webhook_url\":\"https://example.com/hook\", \"api_key\":\"webhook-secret\"}'"
fi

echo ""
echo "🚀 To start encoding:"
echo "   cd $INSTALL_DIR"
echo "   npm start"
echo ""
echo "💡 The encoder will automatically:"
if [[ "$ENCODER_MODE" != "direct" ]]; then
    echo "   ✅ Register with the 3Speak embed system"
    echo "   ✅ Poll for community encoding jobs every 60 seconds"
fi
if [[ "$ENCODER_MODE" != "embed" ]]; then
    echo "   ✅ Start direct API server for your applications"
fi
echo "   ✅ Process videos and upload to IPFS"
echo "   ✅ Provide real-time dashboard monitoring"
echo ""
echo "❓ Need help? Check the README.md or join our Discord!"
echo ""

# Offer to start immediately
read -p "🚀 Start the encoder now? (y/n): " START_NOW

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
    echo ""
    echo "🎬 Starting 3Speak Encoder..."
    echo "📱 Opening dashboard at http://localhost:3001"
    
    if command -v xdg-open &> /dev/null; then
        sleep 3 && xdg-open http://localhost:3001 &
    elif command -v open &> /dev/null; then
        sleep 3 && open http://localhost:3001 &
    fi
    
    npm start
else
    echo ""
    echo "✨ Setup complete! Start encoding when ready with:"
    echo "   cd $INSTALL_DIR && npm start"
fi
