#!/bin/bash
set -e

echo "🚀 3Speak Super Encoder Deployment Script"
echo "==========================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run as root (use sudo)"
   exit 1
fi

# Configuration
ENCODER_DIR="/opt/3speak-encoder"
ENCODER_USER="encoder"
BACKUP_DIR="/opt/3speak-encoder.backup.$(date +%Y%m%d_%H%M%S)"

echo "📋 Configuration:"
echo "   Encoder Directory: $ENCODER_DIR"
echo "   Backup Directory: $BACKUP_DIR"
echo "   Encoder User: $ENCODER_USER"
echo ""

# Create encoder user if it doesn't exist
if ! id "$ENCODER_USER" &>/dev/null; then
    echo "👤 Creating encoder user..."
    useradd -r -m -s /bin/bash $ENCODER_USER
fi

# Backup existing installation
if [ -d "$ENCODER_DIR" ]; then
    echo "💾 Backing up existing encoder to $BACKUP_DIR"
    cp -r "$ENCODER_DIR" "$BACKUP_DIR"
    chown -R $ENCODER_USER:$ENCODER_USER "$BACKUP_DIR"
fi

# Stop existing services
echo "⏹️  Stopping existing encoder services..."
pkill -f "node.*encoder" || true
systemctl stop super-encoder 2>/dev/null || true
pm2 stop encoder 2>/dev/null || true

# Create/update encoder directory
echo "📁 Setting up encoder directory..."
mkdir -p "$ENCODER_DIR"
chown $ENCODER_USER:$ENCODER_USER "$ENCODER_DIR"
cd "$ENCODER_DIR"

# Clone or update repository
if [ -d ".git" ]; then
    echo "🔄 Updating existing repository..."
    sudo -u $ENCODER_USER git stash
    sudo -u $ENCODER_USER git pull origin main
else
    echo "📥 Cloning repository..."
    # Remove any existing content first
    rm -rf * .[^.]* 2>/dev/null || true
    sudo -u $ENCODER_USER git clone https://github.com/menobass/3speakencoder.git .
fi

# Install system dependencies
echo "🗃️ Installing SQLite3..."
apt update
apt install -y sqlite3

# Install Node.js dependencies
echo "📦 Installing dependencies..."
sudo -u $ENCODER_USER npm install

# Build project
echo "🔨 Building project..."
sudo -u $ENCODER_USER npm run build

# Initialize SQLite database
echo "🗄️ Initializing SQLite database..."
DB_PATH="$ENCODER_DIR/local-pins.db"
if [ ! -f "$DB_PATH" ]; then
    # Create database and tables
    sudo -u $ENCODER_USER sqlite3 "$DB_PATH" <<EOF
CREATE TABLE IF NOT EXISTS local_pins (
    hash TEXT PRIMARY KEY,
    size INTEGER,
    pinned_at INTEGER,
    sync_status TEXT DEFAULT 'pending',
    sync_attempts INTEGER DEFAULT 0,
    last_sync_attempt INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_status ON local_pins(sync_status);
CREATE INDEX IF NOT EXISTS idx_pinned_at ON local_pins(pinned_at);

-- Insert a test record to verify database works
INSERT OR IGNORE INTO local_pins (hash, size, pinned_at, sync_status) 
VALUES ('test_init_hash', 0, strftime('%s', 'now'), 'initialized');
EOF
    
    echo "✅ Database initialized successfully!"
    echo "📊 Database location: $DB_PATH"
    
    # Verify database was created properly
    RECORD_COUNT=$(sudo -u $ENCODER_USER sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM local_pins;")
    echo "📈 Database records: $RECORD_COUNT"
else
    echo "✅ Database already exists at $DB_PATH"
fi

# Create required directories
echo "📂 Creating required directories..."
sudo -u $ENCODER_USER mkdir -p data logs temp
chmod 755 data logs temp

# Setup .env file
if [ ! -f ".env" ]; then
    echo "⚙️  Creating .env file..."
    sudo -u $ENCODER_USER cp .env.example .env
    
    echo ""
    echo "🔧 IMPORTANT: Please edit .env file with your settings:"
    echo "   nano $ENCODER_DIR/.env"
    echo ""
    echo "Required settings for Super Encoder:"
    echo "   HIVE_USERNAME=your-hive-username"
    echo "   ENCODER_PRIVATE_KEY=your-encoder-key"
    echo "   ENABLE_LOCAL_FALLBACK=true"
    echo ""
else
    echo "✅ .env file already exists"
fi

# Create systemd service
echo "🔧 Creating systemd service..."
cat > /etc/systemd/system/super-encoder.service << EOF
[Unit]
Description=3Speak Super Encoder
After=network.target

[Service]
Type=simple
User=$ENCODER_USER
Group=$ENCODER_USER
WorkingDirectory=$ENCODER_DIR
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Limits
LimitNOFILE=65536

# Logging
StandardOutput=append:/var/log/super-encoder.log
StandardError=append:/var/log/super-encoder-error.log

[Install]
WantedBy=multi-user.target
EOF

# Create monitoring script
echo "📊 Creating monitoring script..."
cat > /usr/local/bin/super-encoder-status << 'EOF'
#!/bin/bash
cd /opt/3speak-encoder
echo "=== 3Speak Super Encoder Status ==="
echo "Service: $(systemctl is-active super-encoder)"
echo "Database: $([ -f data/local-pins.db ] && echo "$(ls -lh data/local-pins.db | awk '{print $5}')" || echo "Not found")"
echo "Temp usage: $(du -sh temp/ 2>/dev/null | awk '{print $1}' || echo 'None')"
echo "Last activity: $(tail -1 logs/encoder.log 2>/dev/null | cut -d' ' -f1-2 || echo 'No logs')"
echo "Disk space: $(df -h . | tail -1 | awk '{print $4 " available"}')"
EOF
chmod +x /usr/local/bin/super-encoder-status

# Create database stats script
echo "📈 Creating database stats script..."
cat > "$ENCODER_DIR/check-stats.js" << 'EOF'
import { LocalPinDatabase } from './dist/services/LocalPinDatabase.js';

async function checkStats() {
  try {
    const db = new LocalPinDatabase();
    await db.initialize();
    const stats = await db.getStats();
    console.log('📊 Super Encoder Database Stats:');
    console.log(`   Total pins: ${stats.total}`);
    console.log(`   Pending sync: ${stats.pending}`);
    console.log(`   Synced: ${stats.synced}`);
    console.log(`   Failed: ${stats.failed}`);
    await db.close();
  } catch (error) {
    console.log('❌ Database not available or not configured');
  }
}

checkStats().catch(console.error);
EOF
chown $ENCODER_USER:$ENCODER_USER "$ENCODER_DIR/check-stats.js"

# Setup systemd
systemctl daemon-reload
systemctl enable super-encoder

# Verify installation
echo ""
echo "🔍 Verifying installation..."
echo "✅ Checking SQLite installation..."
if command -v sqlite3 >/dev/null 2>&1; then
    echo "   SQLite3 version: $(sqlite3 --version)"
else
    echo "   ❌ SQLite3 not found!"
fi

echo "✅ Checking database..."
DB_PATH="$ENCODER_DIR/local-pins.db"
if [ -f "$DB_PATH" ]; then
    RECORD_COUNT=$(sudo -u $ENCODER_USER sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM local_pins;" 2>/dev/null || echo "0")
    echo "   Database exists with $RECORD_COUNT records"
else
    echo "   ❌ Database not found at $DB_PATH"
fi

echo "✅ Checking Node.js build..."
if [ -d "$ENCODER_DIR/dist" ]; then
    echo "   Build directory exists"
else
    echo "   ❌ Build directory missing"
fi

echo ""
echo "🎉 Super Encoder deployment completed!"
echo ""
echo "📋 Next Steps:"
echo "1. Edit configuration: nano $ENCODER_DIR/.env"
echo "2. Start the service: systemctl start super-encoder"
echo "3. Check status: systemctl status super-encoder"
echo "4. Monitor: super-encoder-status"
echo "5. Database stats: cd $ENCODER_DIR && node check-stats.js"
echo ""
echo "📁 Important Locations:"
echo "   Config: $ENCODER_DIR/.env"
echo "   Database: $ENCODER_DIR/data/local-pins.db"  
echo "   Logs: $ENCODER_DIR/logs/ and /var/log/super-encoder.log"
echo "   Backup: $BACKUP_DIR"
echo ""
echo "🔧 Quick Commands:"
echo "   systemctl status super-encoder    # Check service"
echo "   super-encoder-status             # Quick status"
echo "   journalctl -u super-encoder -f   # Follow logs"
echo ""

if [ -f "$BACKUP_DIR/.env" ]; then
    echo "💡 Your previous .env settings are backed up in:"
    echo "   $BACKUP_DIR/.env"
fi