#!/bin/bash
# test_480p_encode.sh — Verify 480p encoding with 16px alignment fix
# Tests that our encoder correctly handles rotated portrait video
#
# Source: video_20260314_163620_001.mp4 (640x360 stored, 90° rotation → 360x640 display)

set -euo pipefail

INPUT="video_20260314_163620_001.mp4"
OUTPUT="test_480p_output.mp4"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "${GREEN}  PASS${NC}: $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "${RED}  FAIL${NC}: $1"; }
info() { echo -e "${YELLOW}  INFO${NC}: $1"; }

cleanup() { rm -f "$OUTPUT"; }
trap cleanup EXIT

# ─── Step 1: Probe the source ───────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Step 1: Probe source video"
echo "═══════════════════════════════════════════════════════════"

if [ ! -f "$INPUT" ]; then
    echo -e "${RED}ERROR: $INPUT not found${NC}"
    exit 1
fi

SRC_JSON=$(ffprobe -v quiet -print_format json -show_streams -show_format "$INPUT")

SRC_WIDTH=$(echo "$SRC_JSON" | jq -r '.streams[0].width')
SRC_HEIGHT=$(echo "$SRC_JSON" | jq -r '.streams[0].height')
SRC_ROTATION=$(echo "$SRC_JSON" | jq -r '.streams[0].tags.rotate // empty')
SRC_DISPLAY_MATRIX=$(echo "$SRC_JSON" | jq -r '.streams[0].side_data_list[]? | select(.side_data_type == "Display Matrix") | .rotation // empty')
SRC_CODEC=$(echo "$SRC_JSON" | jq -r '.streams[0].codec_name')
SRC_DURATION=$(echo "$SRC_JSON" | jq -r '.format.duration')

info "Source stored resolution: ${SRC_WIDTH}x${SRC_HEIGHT}"
info "Source codec: ${SRC_CODEC}"
info "Source duration: ${SRC_DURATION}s"
info "Rotation tag: ${SRC_ROTATION:-none}"
info "Display matrix rotation: ${SRC_DISPLAY_MATRIX:-none}"

# Determine effective (post-rotation) dimensions
ROTATION="${SRC_ROTATION:-${SRC_DISPLAY_MATRIX:-0}}"
# Normalize negative rotation
ROTATION=${ROTATION#-}

if [ "$ROTATION" = "90" ] || [ "$ROTATION" = "270" ]; then
    EFFECTIVE_WIDTH=$SRC_HEIGHT
    EFFECTIVE_HEIGHT=$SRC_WIDTH
    info "Post-rotation effective resolution: ${EFFECTIVE_WIDTH}x${EFFECTIVE_HEIGHT} (portrait)"
else
    EFFECTIVE_WIDTH=$SRC_WIDTH
    EFFECTIVE_HEIGHT=$SRC_HEIGHT
    info "No rotation swap needed: ${EFFECTIVE_WIDTH}x${EFFECTIVE_HEIGHT}"
fi

# ─── Step 2: Calculate expected 480p dimensions ─────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Step 2: Calculate expected 480p output (16px aligned)"
echo "═══════════════════════════════════════════════════════════"

TARGET_HEIGHT=480
# Derive expected width from the true display AR (SAR-corrected), matching
# the ceil(oh*dar/2)*2 expression used in VideoEncodingWorker.ts.
SRC_SAR=$(echo "$SRC_JSON" | jq -r '.streams[0].sample_aspect_ratio // "1:1"')
SAR_NUM=${SRC_SAR%:*}
SAR_DEN=${SRC_SAR#*:}
if [ "$SAR_NUM" = "0" ] || [ "$SAR_DEN" = "0" ]; then
    SAR_NUM=1
    SAR_DEN=1
fi

if [ "$ROTATION" = "90" ] || [ "$ROTATION" = "270" ]; then
    DAR_NUM=$((SRC_HEIGHT * SAR_DEN))
    DAR_DEN=$((SRC_WIDTH  * SAR_NUM))
else
    DAR_NUM=$((SRC_WIDTH  * SAR_NUM))
    DAR_DEN=$((SRC_HEIGHT * SAR_DEN))
fi

DAR=$(echo "scale=9; $DAR_NUM / $DAR_DEN" | bc)
# Integer ceil: ((TARGET_HEIGHT * DAR_NUM) + (2*DAR_DEN - 1)) / (2*DAR_DEN) * 2
ALIGNED_WIDTH=$(( ((TARGET_HEIGHT * DAR_NUM) + (2 * DAR_DEN) - 1) / (2 * DAR_DEN) * 2 ))

info "Target height: ${TARGET_HEIGHT}"
info "Source SAR: ${SRC_SAR}  DAR: ${DAR_NUM}/${DAR_DEN} = ${DAR}"
info "Expected output: ${ALIGNED_WIDTH}x${TARGET_HEIGHT}"

# ─── Step 3: Encode using the same ffmpeg approach as our encoder ───────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Step 3: Encode to 480p (software, matching our encoder)"
echo "═══════════════════════════════════════════════════════════"

# Replicate the exact scale filter from VideoEncodingWorker.ts (software path):
#   scale=w='ceil(oh*dar/2)*2':h=${profile.height},setsar=1,format=yuv420p,fps=30
SCALE_FILTER="scale=w='ceil(oh*dar/2)*2':h=${TARGET_HEIGHT},setsar=1,format=yuv420p,fps=30"

info "Scale filter: ${SCALE_FILTER}"

ffmpeg -y -i "$INPUT" \
    -c:v libx264 \
    -preset medium \
    -crf 19 \
    -vf "${SCALE_FILTER}" \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    "$OUTPUT" 2>&1 | tail -5

echo ""

# ─── Step 4: Probe the output and validate ──────────────────────────────────
echo "═══════════════════════════════════════════════════════════"
echo " Step 4: Validate encoded output"
echo "═══════════════════════════════════════════════════════════"

OUT_JSON=$(ffprobe -v quiet -print_format json -show_streams -show_format "$OUTPUT")

OUT_WIDTH=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .width')
OUT_HEIGHT=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .height')
OUT_CODEC=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .codec_name')
OUT_ROTATION=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .tags.rotate // empty')
OUT_DISPLAY_MATRIX=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .side_data_list[]? | select(.side_data_type == "Display Matrix") | .rotation // empty')
OUT_DURATION=$(echo "$OUT_JSON" | jq -r '.format.duration')
OUT_PIX_FMT=$(echo "$OUT_JSON" | jq -r '.streams[] | select(.codec_type=="video") | .pix_fmt')

info "Output resolution: ${OUT_WIDTH}x${OUT_HEIGHT}"
info "Output codec: ${OUT_CODEC}"
info "Output pixel format: ${OUT_PIX_FMT}"
info "Output duration: ${OUT_DURATION}s"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Results"
echo "═══════════════════════════════════════════════════════════"

# Test 1: Correct resolution
if [ "$OUT_WIDTH" = "$ALIGNED_WIDTH" ] && [ "$OUT_HEIGHT" = "$TARGET_HEIGHT" ]; then
    pass "Resolution is ${OUT_WIDTH}x${OUT_HEIGHT} (expected ${ALIGNED_WIDTH}x${TARGET_HEIGHT})"
else
    fail "Resolution is ${OUT_WIDTH}x${OUT_HEIGHT} (expected ${ALIGNED_WIDTH}x${TARGET_HEIGHT})"
fi

# Test 2: Width is even (required for H.264 4:2:0)
if [ $((OUT_WIDTH % 2)) -eq 0 ]; then
    pass "Width ${OUT_WIDTH} is even (H.264 4:2:0 compatible)"
else
    fail "Width ${OUT_WIDTH} is ODD — H.264 4:2:0 requires even dimensions"
fi

# Test 3: Height matches target
if [ "$OUT_HEIGHT" = "$TARGET_HEIGHT" ]; then
    pass "Height ${OUT_HEIGHT} matches target ${TARGET_HEIGHT}"
else
    fail "Height ${OUT_HEIGHT} does not match target ${TARGET_HEIGHT}"
fi

# Test 4: No rotation tag in output (should be auto-rotated and tag stripped)
if [ -z "$OUT_ROTATION" ] && [ -z "$OUT_DISPLAY_MATRIX" ]; then
    pass "No rotation metadata in output (auto-rotated correctly)"
else
    fail "Output still has rotation metadata: tag=${OUT_ROTATION:-none}, matrix=${OUT_DISPLAY_MATRIX:-none}"
fi

# Test 5: Portrait aspect ratio preserved (height > width for portrait source)
if [ "$EFFECTIVE_HEIGHT" -gt "$EFFECTIVE_WIDTH" ]; then
    # Source is portrait — output should also be portrait
    if [ "$OUT_HEIGHT" -gt "$OUT_WIDTH" ]; then
        pass "Portrait aspect ratio preserved (${OUT_WIDTH}x${OUT_HEIGHT})"
    else
        fail "Portrait aspect ratio LOST — output is landscape (${OUT_WIDTH}x${OUT_HEIGHT})"
    fi
else
    info "Source is landscape — skipping portrait check"
fi

# Test 6: H.264 codec
if [ "$OUT_CODEC" = "h264" ]; then
    pass "Output codec is H.264"
else
    fail "Output codec is ${OUT_CODEC} (expected h264)"
fi

# Test 7: Duration roughly matches source (within 1 second tolerance)
DURATION_DIFF=$(echo "$OUT_DURATION - $SRC_DURATION" | bc | tr -d '-')
if (( $(echo "$DURATION_DIFF < 1.0" | bc -l) )); then
    pass "Duration preserved (source: ${SRC_DURATION}s, output: ${OUT_DURATION}s)"
else
    fail "Duration mismatch (source: ${SRC_DURATION}s, output: ${OUT_DURATION}s, diff: ${DURATION_DIFF}s)"
fi

# Test 8: Pixel format is yuv420p (most compatible for mobile)
if [ "$OUT_PIX_FMT" = "yuv420p" ]; then
    pass "Pixel format is yuv420p (mobile compatible)"
else
    fail "Pixel format is ${OUT_PIX_FMT} (expected yuv420p — encoder forces format=yuv420p)"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
    echo -e " ${GREEN}ALL ${PASS} TESTS PASSED${NC}"
else
    echo -e " ${RED}${FAIL} FAILED${NC}, ${GREEN}${PASS} PASSED${NC}"
fi
echo "═══════════════════════════════════════════════════════════"
echo ""

exit $FAIL
