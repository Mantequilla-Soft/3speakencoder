/**
 * fluent-ffmpeg 2.1.3 (unmaintained) parses `ffmpeg -formats` with a regex that
 * expects two flag columns ("D " / " E"). FFmpeg 8 added a third "is a device"
 * column, so device lines like " D d lavfi" are parsed as a format named "d",
 * and any command using `-f lavfi` fails with "Input format lavfi is not available".
 * That broke encoder startup (silence file) and every hardware-encoder test.
 *
 * This replaces fluent-ffmpeg's availableFormats() with the same logic and a regex
 * that accepts both layouts. Import this module for its side effect before running
 * any fluent-ffmpeg command.
 */
import ffmpeg from 'fluent-ffmpeg';

export interface FfmpegFormat {
  description: string;
  canDemux: boolean;
  canMux: boolean;
}

// " D  aac   ..." (FFmpeg <= 7) and " D d lavfi ..." / " DE  hls ..." (FFmpeg >= 8)
const formatRegexp = /^\s*([D ])([E ])([d ])?\s+([^ ]+)\s+(.*)$/;

export function parseFfmpegFormats(stdout: string): Record<string, FfmpegFormat> {
  const data: Record<string, FfmpegFormat> = {};

  // Legend lines (" D.. = Demuxing supported") never match: '.' isn't a flag character.
  for (const line of stdout.split(/\r\n|\r|\n/)) {
    const match = line.match(formatRegexp);
    if (!match) continue;

    for (const name of match[4]!.split(',')) {
      const entry = (data[name] ??= { description: match[5]!, canDemux: false, canMux: false });
      if (match[1] === 'D') entry.canDemux = true;
      if (match[2] === 'E') entry.canMux = true;
    }
  }
  return data;
}

let cachedFormats: Record<string, FfmpegFormat> | undefined;

const proto = (ffmpeg as any).prototype;
if (proto && !proto.__formatsFixApplied) {
  proto.availableFormats = proto.getAvailableFormats = function (
    this: any,
    callback: (err: Error | null, formats?: Record<string, FfmpegFormat>) => void
  ) {
    if (cachedFormats) return callback(null, cachedFormats);

    this._spawnFfmpeg(['-formats'], { captureStdout: true, stdoutLines: 0 }, (err: Error | null, stdoutRing: any) => {
      if (err) return callback(err);
      cachedFormats = parseFfmpegFormats(stdoutRing.get());
      callback(null, cachedFormats);
    });
  };
  proto.__formatsFixApplied = true;
}
