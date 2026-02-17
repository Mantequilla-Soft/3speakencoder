# 🔧 GPU Hardware Acceleration Fixes

**Branch:** `fix/gpu-hardware-acceleration`
**Date:** 2026-02-14
**Status:** Ready for Testing

## 📋 Summary

This branch fixes critical issues preventing users from successfully using GPU hardware acceleration for video encoding. The main problem was a **mismatch between detection testing and production encoding**, causing hardware codecs to appear available but fail during actual use.

---

## 🚨 Issues Fixed

### **Issue #1: Testing vs Production Mismatch (CRITICAL)**

**Problem:**
- Detection tests used simple codec tests WITHOUT hwaccel options
- Production encoding used FULL hwaccel pipeline WITH input options
- Result: Tests pass ✅ but production fails ❌

**Files Changed:**
- `src/services/HardwareDetector.ts` (lines 350-400)

**What Changed:**
```typescript
// BEFORE (h264_nvenc testing):
.inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
.videoCodec('h264_nvenc')
.addOption('-preset', 'fast')

// AFTER (matches production):
.inputOptions([
  '-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1',
  '-hwaccel', 'cuda',              // ✅ Added
  '-hwaccel_output_format', 'cuda' // ✅ Added
])
.videoCodec('h264_nvenc')
.addOption('-vf', 'scale_cuda=-2:64')  // ✅ Test hardware filter
.addOption('-preset', 'medium')
.addOption('-cq', '19')
```

**Impact:**
- **NVENC (NVIDIA):** Now properly tests CUDA pipeline
- **QSV (Intel):** Now properly tests QSV pipeline
- **VAAPI (AMD/Intel):** Already tested correctly, enhanced with hardware filter

---

### **Issue #2: Hardware Filters Not Tested**

**Problem:**
- Hardware scaling filters (`scale_cuda`, `scale_vaapi`, `scale_qsv`) were never tested
- FFmpeg could have codec but lack the required filters
- Result: Detection passes but encoding fails with "Filter not found"

**What Changed:**
- All hardware codec tests now include their respective scaling filters
- Catches FFmpeg builds lacking hardware filter support

**Example Error You'll Now Catch:**
```
❌ h264_nvenc test failed: Filter scale_cuda not found
💡 FFmpeg lacks CUDA filters. Rebuild with: --enable-cuda --enable-libnpp
```

---

### **Issue #3: Strategy Filters Breaking Hardware Pipeline**

**Problem:**
- Video transformations (rotation, format conversion) were applied naively
- Software filters before hardware filters forced CPU decoding
- Result: GPU available but not used (fallback to CPU)

**Files Changed:**
- `src/services/VideoProcessor.ts` (lines 1452-1577)

**What Changed:**
- **Intelligent Filter Analysis:** Separates software-only vs hardware-compatible filters
- **Hybrid Pipeline Support:** CPU filters → GPU upload → hardware encoding
- **Optimized Filter Chains:** Preserves hardware acceleration when possible

**Example Scenarios:**

**Scenario A: Pure Hardware (No Rotation)**
```bash
# Input: Normal video, no transformation needed
# Pipeline: GPU decode → GPU scale → GPU encode
-hwaccel cuda -hwaccel_output_format cuda -vf "scale_cuda=-2:720"
```

**Scenario B: Hybrid Pipeline (iPhone Rotation)**
```bash
# Input: iPhone video with 90° rotation metadata
# Pipeline: CPU decode → CPU rotate → GPU upload → GPU scale → GPU encode
-hwaccel cuda -vf "transpose=1,hwupload_cuda,scale_cuda=-2:720"
```

**Before This Fix:**
- Hybrid scenario would fail or fall back to pure CPU

**After This Fix:**
- Hybrid pipeline seamlessly combines CPU + GPU for best performance

---

### **Issue #4: Poor Error Diagnostics**

**Problem:**
- Generic error messages didn't help users fix issues
- No guidance on missing drivers, filters, or permissions

**What Changed:**
- **Specific Error Detection:** Identifies exact failure reason
- **Actionable Guidance:** Provides fix commands and links

**Example Enhanced Errors:**

**Missing CUDA Filters:**
```
❌ h264_nvenc test failed: Filter scale_cuda not found
💡 FFmpeg lacks CUDA filters. Rebuild with: --enable-cuda --enable-libnpp
```

**CUDA Library Not Loaded:**
```
❌ h264_nvenc test failed: Cannot load libcuda.so.1
💡 CUDA library not found. Install NVIDIA drivers: nvidia-driver-XXX
💡 Check: 1) nvidia-smi works 2) drivers installed
```

**VAAPI Permission Denied:**
```
❌ h264_vaapi test failed: Permission denied /dev/dri/renderD128
💡 Device access denied. Fix: sudo usermod -aG render $USER && logout/login
```

**QSV Drivers Missing:**
```
❌ h264_qsv test failed: Cannot load libmfx
💡 Intel QSV drivers missing. Install: intel-media-driver, libmfx
```

---

## 🧪 How to Test These Fixes

### **Step 1: Switch to the Fix Branch**

```bash
git checkout fix/gpu-hardware-acceleration
npm install
npm run build
```

### **Step 2: Test Hardware Detection**

```bash
# Force re-detection (clears cache)
FORCE_HARDWARE_DETECTION=true npm start
```

**What to Look For:**
- ✅ **Better error messages** if hardware fails
- ✅ **Accurate detection** (only marks working codecs as available)
- ✅ **Filter testing** included in codec tests

**Expected Output Examples:**

**NVIDIA Success:**
```
🧪 Testing h264_nvenc...
✅ h264_nvenc test passed
🎯 BEST CODEC: h264_nvenc (Hardware 🚀)
```

**NVIDIA Failure (Missing Filters):**
```
🧪 Testing h264_nvenc...
❌ h264_nvenc test failed: Filter scale_cuda not found
💡 FFmpeg lacks CUDA filters. Rebuild with: --enable-cuda --enable-libnpp
⏭️ Falling back to software encoding
```

**AMD/Intel Success:**
```
🧪 Testing h264_vaapi...
✅ h264_vaapi test passed
🎯 BEST CODEC: h264_vaapi (Hardware 🚀)
```

---

### **Step 3: Test Actual Encoding**

Create a test job with a sample video:

```bash
# Use a real video file (not ultra-short test)
# This will test the full production encoding pipeline
```

**What to Look For:**
- ✅ **Hardware encoding actually works** (fast encoding, low CPU usage)
- ✅ **Hybrid pipeline works** for rotated/transformed videos
- ✅ **Fallback works** if hardware fails mid-encoding

**Monitor with:**
```bash
# NVIDIA GPU usage
nvidia-smi -l 1

# AMD/Intel GPU usage
intel_gpu_top
# or
radeontop

# CPU usage (should be LOW during hardware encoding)
htop
```

---

### **Step 4: Test Edge Cases**

**Test A: iPhone Rotated Video**
- Upload an iPhone video shot vertically
- Should use hybrid pipeline (CPU rotation → GPU encoding)
- Check logs for: `🔧 NVENC hybrid pipeline: CPU filters → GPU upload → hardware scaling`

**Test B: High Bit Depth Video**
- Upload a 10-bit HEVC video
- Should convert to 8-bit yuv420p and encode with GPU
- Check logs for format conversion + hardware encoding

**Test C: Ultra-Compressed Video**
- Upload a tiny file (< 500MB for 30+ min video)
- Should use passthrough mode (no re-encoding)
- GPU should not be used (copy mode)

---

## 📊 Expected Performance Improvements

### **Before (Software Fallback):**
- Encoding Speed: 1x realtime (1 hour video = 1 hour encoding)
- CPU Usage: 90-100%
- Power Consumption: High

### **After (Working Hardware Acceleration):**

| Hardware | Speed | CPU Usage | Power Savings |
|----------|-------|-----------|---------------|
| **NVIDIA NVENC** | 8-15x realtime | 20-30% | 70% less |
| **Intel QSV** | 5-8x realtime | 30-40% | 60% less |
| **AMD VAAPI** | 3-5x realtime | 40-50% | 50% less |

**Example:**
- **1 hour video** with NVENC: 4-8 minutes encoding time
- **1 hour video** with CPU: 60+ minutes encoding time

---

## 🔍 Manual Testing Commands

If you want to verify hardware acceleration manually:

### **Test NVENC (NVIDIA):**
```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda \
  -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 \
  -c:v h264_nvenc -vf "scale_cuda=-2:720" \
  -preset medium -cq 19 -frames:v 300 test_nvenc.mp4

# Should encode 300 frames very fast with GPU
# Check nvidia-smi during encoding - GPU usage should spike
```

### **Test VAAPI (AMD/Intel):**
```bash
ffmpeg -hwaccel vaapi -vaapi_device /dev/dri/renderD128 \
  -hwaccel_output_format vaapi \
  -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 \
  -c:v h264_vaapi -vf "scale_vaapi=-2:720:format=nv12" \
  -qp 19 -bf 2 -frames:v 300 test_vaapi.mp4

# Should encode 300 frames using GPU
# Check intel_gpu_top or radeontop
```

### **Test QSV (Intel):**
```bash
ffmpeg -hwaccel qsv -hwaccel_output_format qsv \
  -f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 \
  -c:v h264_qsv -vf "scale_qsv=-2:720" \
  -preset medium -global_quality 19 -frames:v 300 test_qsv.mp4

# Should encode 300 frames using Intel QuickSync
```

**If these commands fail, the error messages will now tell you WHY.**

---

## 🐛 Common Issues You Might Encounter

### **1. "Filter scale_cuda not found"**

**Cause:** FFmpeg not compiled with CUDA filter support

**Fix:**
```bash
# Check FFmpeg build
ffmpeg -filters | grep scale_cuda

# If empty, rebuild FFmpeg with:
./configure --enable-cuda --enable-cuvid --enable-nvenc --enable-libnpp
make && sudo make install
```

### **2. "Cannot load libcuda.so.1"**

**Cause:** NVIDIA drivers not installed or not loaded

**Fix:**
```bash
# Check if drivers are loaded
nvidia-smi

# If fails, install drivers:
# Ubuntu/Debian:
sudo apt install nvidia-driver-535

# Arch:
sudo pacman -S nvidia-utils
```

### **3. "Permission denied: /dev/dri/renderD128"**

**Cause:** User not in render/video group

**Fix:**
```bash
# Add user to render group
sudo usermod -aG render $USER

# Add user to video group (may also be needed)
sudo usermod -aG video $USER

# Logout and login for group changes to take effect
```

### **4. "Cannot initialize hardware encoder"**

**Cause:** GPU busy, out of memory, or driver issue

**Fix:**
```bash
# Check GPU status
nvidia-smi  # For NVIDIA
intel_gpu_top  # For Intel

# Reboot to clear GPU state
sudo reboot
```

---

## 📝 Files Modified

| File | Lines Changed | Description |
|------|---------------|-------------|
| `src/services/HardwareDetector.ts` | 350-450 | Aligned testing with production, enhanced error messages |
| `src/services/VideoProcessor.ts` | 1452-1620 | Smart filter chain handling, hybrid pipeline support |
| `GPU_FIXES.md` | New | This documentation |

---

## ✅ Testing Checklist

Before merging this branch:

- [ ] Hardware detection runs without errors
- [ ] NVENC properly detected (if NVIDIA GPU present)
- [ ] QSV properly detected (if Intel GPU present)
- [ ] VAAPI properly detected (if AMD/Intel GPU present)
- [ ] Test encoding completes successfully with hardware codec
- [ ] Encoding actually uses GPU (verify with nvidia-smi/intel_gpu_top)
- [ ] Hybrid pipeline works for rotated videos
- [ ] Fallback to software works if hardware fails
- [ ] Error messages are helpful and actionable
- [ ] Performance improvement visible (faster encoding, lower CPU)

---

## 🎯 Merge Criteria

This branch is ready to merge when:

1. ✅ All tests pass on systems WITH GPU hardware
2. ✅ Graceful fallback works on systems WITHOUT GPU hardware
3. ✅ No regressions (existing working setups still work)
4. ✅ At least one community encoder confirms GPU now works

---

## 📞 Support

If you encounter issues testing this branch:

1. **Capture full logs:** Run with `FORCE_HARDWARE_DETECTION=true`
2. **Provide FFmpeg info:** `ffmpeg -version` and `ffmpeg -encoders | grep 264`
3. **GPU details:** `nvidia-smi` (NVIDIA) or `lspci | grep VGA` (others)
4. **Error messages:** Share exact error from logs

---

## 🎉 Expected Outcome

After these fixes:

✅ Users with GPUs can actually USE their GPUs
✅ Clear error messages when hardware doesn't work
✅ Hybrid pipelines work for complex video transformations
✅ Proper fallback when hardware is unavailable
✅ 5-15x faster encoding for GPU users

**This should make hardware acceleration actually work for the community!** 🚀
