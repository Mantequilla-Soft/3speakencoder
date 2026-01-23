#!/bin/bash

echo "🚀 Deploying Local Fallback Enhancement to VPS..."
echo

# SSH to VPS and deploy latest changes
ssh meno@vps-956839db.vps.hostdare.com << 'EOF'
  echo "📍 Current location: $(pwd)"
  cd /opt/3speak-encoder
  
  echo "📋 Current commit:"
  git log --oneline -1
  echo
  
  echo "🔄 Pulling latest changes..."
  git pull origin main
  echo
  
  echo "📋 New commit:"
  git log --oneline -1
  echo
  
  echo "🔧 Building project..."
  npm run build
  echo
  
  echo "🔄 Restarting encoder service..."
  sudo systemctl restart super-encoder
  echo
  
  echo "📊 Service status:"
  sudo systemctl status super-encoder --no-pager -l
  echo
  
  echo "✅ Deployment complete! Local fallback enhancement is now active."
  echo "🏠 Failed lazy pins will now be archived locally for batch processing."
EOF