# 🚀 Easy Install Guide - Help Encode Videos!

Want to help 3Speak with video encoding? **This guide gets you running in 5 minutes!**

## 📦 Installation

### 🚀 For Windows Users (SUPER EASY!):

**🎯 One-Command Installation (PowerShell):**
```powershell
iwr -useb https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.ps1 | iex
```

**🎯 Alternative (Command Prompt):**
- Download [`install.bat`](https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.bat) (right-click, "Save link as…")
- Double-click to run

**✨ What the installer does automatically:**
- ✅ Installs whatever is missing: Git, Node.js 20+, FFmpeg (with winget, built into Windows 10 and 11; no administrator window needed) and IPFS
- ✅ Checks that FFmpeg really runs and saves its location in `.env` (`FFMPEG_PATH`), so the encoder finds it even if `PATH` doesn't
- ✅ Starts the IPFS daemon
- ✅ Downloads the latest encoder, builds it and creates desktop and Start menu shortcuts
- ✅ Configures it from your answers (your previous `.env` is kept as `.env.bak`)
- ✅ Ends with `npm run doctor`, which checks everything the encoder needs
- ✅ Offers to start immediately

Windows may ask for permission (a UAC prompt) while Node.js or Git install. If winget isn't available and the window isn't an administrator one, the installer stops and says what to install by hand.

**🛠️ Manual Windows Installation (if you prefer):**
1. **Install Node.js**: Download from [nodejs.org](https://nodejs.org) (choose LTS)
2. **Install dependencies**: 
   ```cmd
   winget install Gyan.FFmpeg
   # IPFS: extract ipfs.exe from kubo_v0.43.1_windows-amd64.zip
   # (https://github.com/ipfs/kubo/releases/tag/v0.43.1) to a folder on your PATH
   
   # Initialize IPFS
   ipfs init
   ```
3. **Get the encoder**:
   ```cmd
   git clone https://github.com/Mantequilla-Soft/3speakencoder
   cd 3speakencoder
   npm ci
   ```
4. **Configure** (asks for your Hive username, creates your encoder identity and enables community jobs):
   ```cmd
   npm run setup
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
   npm ci
   npm run setup   # asks for your Hive username, writes .env
   ipfs daemon &
   npm start
   ```

### 🐧 For Linux/Mac Users:
**🎯 Interactive Installation (Recommended):**
```bash
curl -fsSL https://raw.githubusercontent.com/Mantequilla-Soft/3speakencoder/main/install.sh | bash
```
Run it as your normal user, not root: it uses `sudo` when it installs packages. Prefer to read it first? Download it with `-o install.sh`, look, then `bash install.sh`.

**✨ What this does automatically:**
- ✅ Installs whatever is missing: Git, Node.js 20+ (from NodeSource when your distribution's is too old), FFmpeg and IPFS (Kubo 0.43.1)
- ✅ Works with Debian/Ubuntu (apt), Fedora and RHEL-family (dnf; FFmpeg comes from RPM Fusion), Arch (pacman) and macOS (Homebrew, installed if missing)
- ✅ Saves FFmpeg's location in `.env` (`FFMPEG_PATH`)
- ✅ Starts the IPFS daemon
- ✅ Downloads the latest encoder, builds it and configures it from your answers (your previous `.env` is kept as `.env.bak`)
- ✅ Adds "3Speak Encoder" to your app menu (Linux) or a double-clickable launcher to your Desktop (Mac)
- ✅ Ends with `npm run doctor`, which checks everything the encoder needs

### 🐳 Docker
Runs the encoder and its own IPFS node together:
```bash
git clone https://github.com/Mantequilla-Soft/3speakencoder.git && cd 3speakencoder
cp .env.example .env        # set HIVE_USERNAME and ENCODER_PRIVATE_KEY
GIT_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.production.yml up -d --build
```
Keep `ENCODER_PRIVATE_KEY` in `.env`, or the encoder gets a new identity every time the container restarts.

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

**❌ Dashboard says "Host not allowed":**
You opened it by a name other than an IP address, `localhost` or the computer's own name. Add that name to `.env`, for example `DASHBOARD_ALLOWED_HOSTS=encoder.lan`, and restart the encoder.

**❌ Still having issues?**
- Windows users: Try running PowerShell or Command Prompt as Administrator
- All users: Check firewall settings for IPFS (port 4001)
- Restart your terminal/command prompt after installation

## 🎮 What You'll See

Once running, open **http://localhost:3001** in your browser. The dashboard shows:
- 🟢 Whether the encoder is online, encoding or in trouble (also in the browser tab)
- 🎬 The video it's encoding right now, with progress
- 📋 Recent jobs, and failed ones you can retry
- 🔧 Health (how responsive the encoder is, uptime) and the live log
- ⬆️ A notice when a newer version is available

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