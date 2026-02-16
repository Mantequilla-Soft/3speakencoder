# 🧪 Quick Testing Guide - GPU Fixes

## Current Branch
`fix/gpu-hardware-acceleration`

## Quick Start Testing

### 1️⃣ **Force Hardware Re-Detection**

```bash
# Clear cache and re-detect hardware
FORCE_HARDWARE_DETECTION=true npm start
```

**What to watch for:**
- Enhanced error messages if hardware fails
- Hardware filter testing (scale_cuda, scale_vaapi, scale_qsv)
- Accurate "tested" vs "available" status

---

### 2️⃣ **Test with Real Video**

```bash
# Test with a sample video
# Hardware encoding should be MUCH faster than before
```

**Monitor GPU usage:**

**NVIDIA:**
```bash
watch -n 1 nvidia-smi
# GPU utilization should be 60-90% during encoding
```

**AMD/Intel:**
```bash
sudo intel_gpu_top  # Intel
# or
radeontop  # AMD
```

**CPU usage should be LOW** (20-40%) if GPU is working

---

### 3️⃣ **Check for Improved Errors**

If hardware fails, you should see:

**Old Error (Unhelpful):**
```
❌ h264_nvenc test failed: Error
```

**New Error (Helpful):**
```
❌ h264_nvenc test failed: Filter scale_cuda not found
💡 FFmpeg lacks CUDA filters. Rebuild with: --enable-cuda --enable-libnpp
```

---

## Expected Results

### ✅ **Success Indicators:**

1. **Hardware Detection:**
   - Codec marked as `tested: true` and `available: true`
   - Logs show: `✅ h264_nvenc test passed`
   - No filter-related errors

2. **Actual Encoding:**
   - GPU usage spikes to 60-90%
   - CPU usage stays low (20-40%)
   - Encoding is 5-15x faster than software
   - Logs show: `🎯 Attempting 720p encoding with h264_nvenc (hardware)`

3. **Hybrid Pipeline (Rotated Videos):**
   - Logs show: `🔧 NVENC hybrid pipeline: CPU filters → GPU upload → hardware scaling`
   - Still uses GPU for encoding (just CPU for rotation)

### ❌ **Failure Indicators:**

1. **Missing Filters:**
   ```
   ❌ h264_nvenc test failed: Filter scale_cuda not found
   💡 FFmpeg lacks CUDA filters. Rebuild with: --enable-cuda --enable-libnpp
   ```
   **Action:** Rebuild FFmpeg with proper flags

2. **Missing Drivers:**
   ```
   ❌ h264_nvenc test failed: Cannot load libcuda.so.1
   💡 CUDA library not found. Install NVIDIA drivers: nvidia-driver-XXX
   ```
   **Action:** Install GPU drivers

3. **Permission Issues:**
   ```
   ❌ h264_vaapi test failed: Permission denied /dev/dri/renderD128
   💡 Device access denied. Fix: sudo usermod -aG render $USER && logout
   ```
   **Action:** Add user to render/video groups

---

## Manual FFmpeg Tests

Test hardware acceleration manually:

### **NVIDIA Test:**
```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda \
  -i input.mp4 -c:v h264_nvenc \
  -vf "scale_cuda=-2:720" -preset medium -cq 19 \
  output.mp4
```

### **AMD/Intel Test:**
```bash
ffmpeg -hwaccel vaapi -vaapi_device /dev/dri/renderD128 \
  -hwaccel_output_format vaapi -i input.mp4 \
  -c:v h264_vaapi -vf "scale_vaapi=-2:720:format=nv12" \
  -qp 19 -bf 2 output.mp4
```

### **Intel QSV Test:**
```bash
ffmpeg -hwaccel qsv -hwaccel_output_format qsv \
  -i input.mp4 -c:v h264_qsv \
  -vf "scale_qsv=-2:720" -preset medium \
  -global_quality 19 output.mp4
```

If these **fail**, the new error messages will tell you why!

---

## Performance Comparison

Before encoding, note the video duration.

**Example: 1 hour video**

| Method | Time | CPU | GPU |
|--------|------|-----|-----|
| **Software (broken GPU)** | 60+ min | 95% | 0% |
| **NVENC (working)** | 4-8 min | 25% | 85% |
| **VAAPI (working)** | 10-15 min | 35% | 70% |
| **QSV (working)** | 7-12 min | 30% | 75% |

---

## Reporting Results

When reporting test results, please include:

1. **System Info:**
   ```bash
   ffmpeg -version
   nvidia-smi  # or lspci | grep VGA
   ffmpeg -encoders | grep h264
   ```

2. **Detection Logs:**
   - Copy the hardware detection output
   - Include any error messages

3. **Encoding Test:**
   - Video duration vs encoding time
   - GPU/CPU usage during encoding
   - Any errors or warnings

4. **Success/Failure:**
   - ✅ GPU working: Include speed improvement
   - ❌ GPU not working: Include error messages

---

## Common Questions

**Q: How do I know if GPU is actually being used?**
A: Run `nvidia-smi -l 1` (or `intel_gpu_top`) during encoding. GPU usage should be 60-90%.

**Q: Detection says available but encoding fails?**
A: This was the OLD bug! The NEW code tests the full pipeline, so this shouldn't happen anymore.

**Q: What if I don't have a GPU?**
A: Encoder will gracefully fall back to software (libx264). No issues expected.

**Q: Hybrid pipeline - what does that mean?**
A: For videos needing rotation/transformation, CPU does the transform, then GPU does the encoding. Best of both worlds!

---

## Next Steps

1. **Test on your system** with the commands above
2. **Report results** (success or failure)
3. **Share logs** if you encounter issues
4. **Help others** by documenting your FFmpeg build process if you had to rebuild

---

## Merge Readiness

✅ Ready to merge when:
- At least 2-3 community encoders test successfully
- No regressions on systems without GPU
- Error messages proven helpful for troubleshooting

See `GPU_FIXES.md` for complete technical details.
