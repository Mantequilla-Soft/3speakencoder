# Share the Hardware Acceleration Test

## Ready-to-Share Packages

Two distribution formats are available:

### 📦 For Linux/macOS Users
**File:** `hardware-acceleration-test.tar.gz`

```bash
# Extract
tar -xzf hardware-acceleration-test.tar.gz
cd hardware-acceleration-test

# Install
./install.sh

# Run
npm start
```

### 📦 For Windows Users
**File:** `hardware-acceleration-test.zip`

```cmd
REM Extract the ZIP file
REM Navigate to the extracted folder

REM Install
install.bat

REM Run
npm start
```

## What's Included

```
hardware-acceleration-test/
├── test-hardware-acceleration.ts   # Main test script
├── package.json                    # Dependencies (minimal)
├── README.md                       # Full documentation
├── QUICKSTART.md                   # Quick start guide
├── install.sh                      # Linux/macOS installer
└── install.bat                     # Windows installer
```

## Distribution Methods

### Option 1: Direct File Sharing
- Upload `hardware-acceleration-test.zip` (Windows)
- Upload `hardware-acceleration-test.tar.gz` (Linux/macOS)
- Share via email, Dropbox, Google Drive, etc.

### Option 2: GitHub Release
```bash
# Create a release on GitHub with both files
gh release create v1.0.0 \
  hardware-acceleration-test.zip \
  hardware-acceleration-test.tar.gz \
  --title "Hardware Acceleration Test v1.0.0" \
  --notes "Standalone hardware detection tool"
```

### Option 3: Direct Folder Sharing
Share the entire `standalone-hw-test` folder:
- Via USB drive
- Network share
- Cloud storage

## User Instructions

Send this to users:

---

**Hardware Acceleration Test Tool**

Test your system's video encoding hardware capabilities!

**Requirements:**
- Node.js (v18+) - https://nodejs.org
- FFmpeg - https://ffmpeg.org/download.html

**Quick Setup:**

1. Extract the archive
2. Run the install script:
   - **Linux/Mac:** `./install.sh`
   - **Windows:** `install.bat`
3. Run the test: `npm start`

The test will:
- Detect your GPU(s)
- Test FFmpeg hardware encoders
- Show which acceleration works on your system
- Optionally save results to a config file

**Please share:**
- Your OS (Windows/Linux/macOS)
- GPU model
- Test results (screenshot or text output)

---

## Expected Results to Collect

From each user, you want to see:

1. **Platform:** Windows 10/11, Ubuntu 22.04, macOS Ventura, etc.
2. **GPU:** NVIDIA RTX 3060, Intel UHD 770, AMD Radeon RX 6700, etc.
3. **Working Codecs:** Which hardware encoders passed the test
4. **Failed Codecs:** Which were available but failed
5. **FFmpeg Version:** Output of `ffmpeg -version`

## Why This is Useful

This standalone test helps you:
- ✅ Verify hardware detection works across different systems
- ✅ Identify edge cases (specific GPU models, driver versions)
- ✅ Gather real-world data for improving the encoder
- ✅ Build a compatibility matrix
- ✅ Help users troubleshoot their specific setup

## No App Required

Users don't need:
- Your main 3Speak encoder app
- MongoDB
- IPFS
- Gateway access
- Any configuration

Just Node.js and FFmpeg!

## Archive Sizes

- `.tar.gz` - ~8-10 KB (compressed)
- `.zip` - ~10-12 KB (compressed)

Small enough to email or share anywhere!
