# Hardware Acceleration Detection Test

## Overview
This test tool scans your system for available hardware acceleration capabilities and provides an option to save the results to a configuration file for future use.

## Purpose
Instead of scanning for hardware acceleration on every video job (expensive operation), this tool:
1. Runs **once** during installation/setup
2. Detects all available hardware acceleration
3. Tests each codec to ensure it works
4. Saves results to a config file
5. Encoder reads from config file (fast) instead of re-scanning (slow)

## Supported Hardware

### Linux
- **NVIDIA NVENC** - NVIDIA GPU hardware encoding
- **Intel QSV** - Intel Quick Sync Video
- **AMD/Intel VAAPI** - Video Acceleration API

### Windows  
- **NVIDIA NVENC** - NVIDIA GPU hardware encoding
- **Intel QSV** - Intel Quick Sync Video
- **AMD AMF** - AMD Advanced Media Framework

### macOS
- **VideoToolbox** - Apple's native hardware acceleration (M1/M2/Intel)

## How to Run

### Linux / macOS
```bash
# Using npm/Node
npx tsx tests/test-hardware-acceleration.ts

# Or compile first
npm run build
node dist/tests/test-hardware-acceleration.js
```

### Windows
```cmd
# Using npm/Node
npx tsx tests\test-hardware-acceleration.ts

# Or via PowerShell
npm run test:hardware
```

## What It Does

### Step 1: FFmpeg Check
Verifies FFmpeg is installed and accessible

### Step 2: System Hardware Scan
**Linux:**
- Checks for `/dev/dri/renderD128` (VAAPI)
- Runs `nvidia-smi` (NVIDIA)
- Checks `lspci` for Intel GPU
- Verifies user groups (render, video)

**Windows:**
- Uses `wmic` to detect GPU
- Falls back to PowerShell if needed
- Detects NVIDIA, Intel, AMD

**macOS:**
- Uses `system_profiler` for GPU info
- VideoToolbox available on all modern Macs

### Step 3: FFmpeg Codec Check
Queries FFmpeg for available encoders

### Step 4: Hardware Testing
Actually encodes a tiny test video with each codec to verify it works (not just available)

### Step 5: Results & Save
- Displays comprehensive results
- Shows working, available, and unavailable codecs
- Recommends best codec
- **Offers to save to `hardware-acceleration.config`**

## Output File Format

```json
{
  "platform": "linux",
  "detectionDate": "2026-01-23T...",
  "capabilities": [
    {
      "name": "h264_nvenc",
      "type": "hardware",
      "available": true,
      "tested": true,
      "priority": 1,
      "platform": ["linux", "win32"],
      "systemDetected": true,
      "testResult": "Encoded in 245ms"
    }
  ],
  "recommendedCodec": "h264_nvenc",
  "fallbackCodec": "libx264"
}
```

## Integration Plan

### Phase 1 (Current): Standalone Test
Run manually to see what hardware you have

### Phase 2: Installation Integration
Add to `install.sh` / `install.ps1`:
```bash
# Run hardware detection
npx tsx tests/test-hardware-acceleration.ts

# Config saved to hardware-acceleration.config
```

### Phase 3: Encoder Integration
Modify `VideoProcessor.ts`:
```typescript
// Old way (slow):
await this.detectCodecs(); // Scans every time

// New way (fast):
this.loadCodecsFromConfig(); // Reads once
```

## Benefits

### Performance
- **Old:** Scan on every job (~2-5 seconds)
- **New:** Read config file (~2 milliseconds)
- **Savings:** 1000x faster startup per job

### Reliability
- Test codecs during setup when user can fix issues
- Jobs never fail due to codec detection problems
- Clear feedback during installation

### User Experience
- One-time setup with clear output
- Option to re-run if hardware changes
- No surprises during production jobs

## Windows-Specific Notes

### Cross-Platform Test Input
The test uses different input methods for Windows vs Linux:
- **Linux/macOS:** Uses `/dev/zero` (not available on Windows)
- **Windows:** Uses `lavfi` null source (built into FFmpeg)

### PowerShell Execution
If running via PowerShell, you may need:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npx tsx tests/test-hardware-acceleration.ts
```

### GPU Detection
Windows GPU detection uses:
1. `wmic path win32_VideoController get name`
2. Falls back to PowerShell WMI query
3. Detects NVIDIA, Intel, AMD

## Re-Running the Test

You should re-run this test when:
- Installing on a new machine
- Updating graphics drivers
- Adding/changing GPU hardware
- Updating FFmpeg
- Changing Docker/container configuration

## Troubleshooting

### "FFmpeg not available"
- Install FFmpeg: `npm run setup` or download from ffmpeg.org
- Ensure FFmpeg is in PATH

### "No hardware codecs available"
- Check graphics drivers are installed
- Verify FFmpeg was compiled with hardware support
- Run test again with sudo (Linux) to see detailed errors

### "Codec test failed"
- Hardware present but drivers may need updating
- Check user permissions (Linux: render/video groups)
- Review test output for specific error messages

## Example Output

```
╔════════════════════════════════════════════════════════════╗
║     3SPEAK ENCODER - HARDWARE ACCELERATION SCANNER         ║
╚════════════════════════════════════════════════════════════╝

🖥️  Platform: Linux
📁 Temp Directory: /tmp/3speak-hw-test-abc123

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 STEP 1: Testing FFmpeg Availability
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ FFmpeg is available and working
   Found 287 supported formats

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 STEP 2: Scanning System Hardware
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ NVIDIA GPU detected: NVIDIA GeForce RTX 3060
✅ User is in "render" group - VAAPI should work

[... more output ...]

🎯 RECOMMENDATION:
   Primary: h264_nvenc (hardware)
   Fallback: libx264 (software - always reliable)

💾 Save results to hardware-acceleration.config? (y/n):
```
