import { describe, expect, it } from 'vitest';
import ffmpeg from 'fluent-ffmpeg';
import { parseFfmpegFormats } from '../../src/common/ffmpegCompat.js';

// Verbatim from `ffmpeg -hide_banner -formats` (FFmpeg 9.0.1 / 8.1.3): three flag columns
const FFMPEG_8 = `Formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ..d = Is a device
 ---
 D   3dostr          3DO STR
 D   aac             raw ADTS AAC (Advanced Audio Coding)
 DE  hls             Apple HTTP Live Streaming
 D d lavfi           Libavfilter virtual input device
 D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV
  E  mp4             MP4 (MPEG-4 Part 14)
 DEd v4l2            Video4Linux2 device
  E  null            raw null video
`;

// FFmpeg <= 7 layout: two flag columns
const FFMPEG_7 = `File formats:
 D. = Demuxing supported
 .E = Muxing supported
 --
 D  aac             raw ADTS AAC (Advanced Audio Coding)
 DE hls             Apple HTTP Live Streaming
 D  lavfi           Libavfilter virtual input device
  E mp4             MP4 (MPEG-4 Part 14)
`;

describe('parseFfmpegFormats', () => {
  it.each([['FFmpeg 8+', FFMPEG_8], ['FFmpeg <= 7', FFMPEG_7]])('parses %s output', (_label, out) => {
    const f = parseFfmpegFormats(out);
    expect(f.lavfi).toMatchObject({ canDemux: true, canMux: false });
    expect(f.hls).toMatchObject({ canDemux: true, canMux: true });
    expect(f.mp4).toMatchObject({ canMux: true });
    expect(f.aac).toMatchObject({ canDemux: true, canMux: false });
    expect(f.lavfi?.description).toBe('Libavfilter virtual input device');
  });

  it('handles devices that mux and demux, and comma-separated names', () => {
    const f = parseFfmpegFormats(FFMPEG_8);
    expect(f.v4l2).toMatchObject({ canDemux: true, canMux: true });
    // "mov,mp4,..." demux entry merges with the separate "mp4" mux entry
    expect(f.mp4).toMatchObject({ canDemux: true, canMux: true });
    expect(f.m4a).toMatchObject({ canDemux: true });
  });

  it('does not turn legend lines or the device flag into formats', () => {
    const f = parseFfmpegFormats(FFMPEG_8);
    expect(f).not.toHaveProperty('d');
    expect(f).not.toHaveProperty('=');
    expect(Object.keys(f)).not.toContain('Demuxing');
  });

  it('is installed on the fluent-ffmpeg prototype', () => {
    expect((ffmpeg as any).prototype.__formatsFixApplied).toBe(true);
  });
});
