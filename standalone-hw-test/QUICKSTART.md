# Hardware Acceleration Detection Test - Standalone Package

## Quick Start

### Prerequisites
- **Node.js** (v18 or higher) - [Download](https://nodejs.org)
- **FFmpeg** - [Download](https://ffmpeg.org/download.html)

### Installation

**Linux / macOS:**
```bash
chmod +x install.sh
./install.sh
```

**Windows:**
```cmd
install.bat
```

**Manual Installation:**
```bash
npm install
```

### Run the Test

```bash
npm start
```

or

```bash
npm test
```

## What This Test Does

1. ✅ Checks if FFmpeg is installed and working
2. 🔍 Scans your system for GPU hardware (NVIDIA, Intel, AMD, Apple)
3. 📋 Checks which hardware encoders FFmpeg supports
4. 🧪 Tests each hardware encoder to ensure it actually works
5. 📊 Shows you detailed results
6. 💾 Optionally saves results to `hardware-acceleration.config`

## Supported Hardware

### Windows
- NVIDIA NVENC (GeForce/Quadro/Tesla GPUs)
- Intel Quick Sync Video (Intel CPUs with integrated graphics)
- AMD AMF (Radeon GPUs)

### Linux
- NVIDIA NVENC (GeForce/Quadro/Tesla GPUs)
- Intel Quick Sync Video (Intel CPUs with integrated graphics)
- VAAPI (AMD/Intel integrated graphics)

### macOS
- VideoToolbox (Apple Silicon M1/M2/M3 or Intel Macs)

## Expected Output

You'll see:
- 🚀 **Working codecs** - Tested and confirmed to work
- 🔄 **Available codecs** - Present in FFmpeg but couldn't test
- ❌ **Unavailable** - Not compiled into your FFmpeg build
- 🎯 **Recommendation** - Best codec for your system

## Troubleshooting

### "FFmpeg not available"
Install FFmpeg and ensure it's in your system PATH:
- **Windows**: Download from ffmpeg.org, add to PATH
- **Linux**: `sudo apt install ffmpeg` or `sudo yum install ffmpeg`
- **macOS**: `brew install ffmpeg`

### "No hardware codecs available"
- Your FFmpeg might not be compiled with hardware support
- Try: `ffmpeg -codecs | grep h264` to see available encoders
- Download a "full" build of FFmpeg with hardware support

### "Hardware test failed"
- GPU drivers may need updating
- On Linux, check user permissions: `groups` (should include "render" or "video")
- GPU might be in use by another application

## Share Your Results

After running the test, please share:
1. Your platform (Windows/Linux/macOS)
2. Your GPU model
3. The test results (working/failed codecs)
4. The `hardware-acceleration.config` file if generated

This helps improve hardware detection across different systems!

## Files in This Package

- `test-hardware-acceleration.ts` - The test script
- `package.json` - Dependencies
- `install.sh` / `install.bat` - Installation scripts
- `README.md` - This file

## License

MIT

## Support

For issues or questions, create an issue on the main 3Speak Encoder repository.
