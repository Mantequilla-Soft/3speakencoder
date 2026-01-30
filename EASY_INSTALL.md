# 🚀 Easy Install Guide - Help Encode Videos!

Want to help 3Speak with video encoding? **This guide gets you running in 5 minutes!**

## 🎯 One-Click Options (Coming Soon)

### Option 1: Windows Installer (Planned)
- Download `3SpeakEncoder-Setup.exe`
- Double-click to install
- Enter your Hive username
- Click "Start Encoding"

### Option 2: Docker Container (Available Now)
```bash
# One command to start encoding!
docker run -d --name 3speak-encoder \
  -e HIVE_USERNAME=your-hive-username \
  -p 3001:3001 \
  ghcr.io/mantequilla-soft/3speakencoder:latest
```

### Option 3: Electron App (Planned)
- Cross-platform desktop app
- GUI configuration
- No command line needed

## 📦 Current Easy Installation

### 🚀 For Windows Users (SUPER EASY!):

**🎯 One-Command Installation (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1 | iex
```

**🎯 Alternative (Command Prompt):**
- Download `install.bat` from [GitHub releases](https://github.com/Mantequilla-Soft/3speakencoder/releases)
- Double-click to run

**✨ What the installer does automatically:**
- ✅ Checks and installs Node.js (if needed)
- ✅ Installs FFmpeg via Chocolatey
- ✅ Installs and initializes IPFS
- ✅ Starts IPFS daemon automatically
- ✅ Downloads the latest encoder
- ✅ Creates desktop shortcuts
- ✅ Configures based on your preferences
- ✅ Offers to start immediately

**🛠️ Manual Windows Installation (if you prefer):**
1. **Install Node.js**: Download from [nodejs.org](https://nodejs.org) (choose LTS)
2. **Install dependencies**: 
   ```cmd
   # Using chocolatey (run as admin)
   choco install ffmpeg ipfs
   
   # Initialize IPFS
   ipfs init
   ```
3. **Get the encoder**:
   ```cmd
   git clone https://github.com/Mantequilla-Soft/3speakencoder
   cd 3speakencoder
   npm install
   ```
4. **Configure** (just your Hive username):
   ```cmd
   echo HIVE_USERNAME=your-hive-username > .env
   ```
5. **Start IPFS and encoder**:
   ```cmd
   start /b ipfs daemon
   npm start
   ```

### 🍎 For Mac Users (Alternative Manual Method):
1. **Install dependencies**:
   ```bash
   # Install homebrew if you don't have it
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   
   # Install everything at once  
   brew install node ffmpeg git ipfs
   ipfs init
   ```
2. **Get and start encoder**:
   ```bash
   git clone https://github.com/Mantequilla-Soft/3speakencoder
   cd 3speakencoder
   npm install
   echo "HIVE_USERNAME=your-hive-username" > .env
   ipfs daemon &
   npm start
   ```

### 🐧 For Linux/Mac Users:
**🎯 Interactive Installation (Recommended):**
```bash
# Download and run interactively for full configuration options
wget https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh
chmod +x install.sh
./install.sh
```

**✨ What this does automatically:**
- ✅ Checks for all dependencies (Node.js, FFmpeg, Git, etc.)
- ✅ Installs IPFS (Kubo v0.23.0) if missing
- ✅ Initializes and starts IPFS daemon
- ✅ Downloads the latest encoder
- ✅ Sets up your configuration interactively
- ✅ Creates shortcuts and starts encoding immediately

## 🔧 Quick Troubleshooting

**❌ "IPFS not found" or connection errors:**
```bash
# Check if IPFS is running
ipfs id

# If not running, start it:
ipfs daemon
```

**❌ Windows: "Execution policy" error:**
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**❌ Permission denied (Linux/Mac):**
```bash
# Make install script executable
chmod +x install.sh
./install.sh
```

**❌ Still having issues?**
- Windows users: Try running PowerShell or Command Prompt as Administrator
- All users: Check firewall settings for IPFS (port 4001)
- Restart your terminal/command prompt after installation

## 🎮 What You'll See

Once running, open **http://localhost:3001** in your browser for a beautiful dashboard showing:
- ✅ System status (including IPFS connection)
- 🎬 Active encoding jobs  
- 📊 Your contribution stats
- 🔧 Health monitoring

**💡 Note:** The install script automatically handles IPFS installation and daemon management!

## 💡 Why Help?

- **Decentralize video infrastructure**
- **Support Web3 content creators**
- **Earn potential future rewards**
- **Learn about video encoding**
- **Contribute to open source**

## 🆘 Need Help?

- **Discord**: Join our community
- **GitHub Issues**: Report problems
- **Documentation**: Full guides available
- **Video Tutorial**: Coming soon!

---
**Ready to make Web3 video better? Let's encode! 🚀**