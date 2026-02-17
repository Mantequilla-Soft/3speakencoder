/**
 * 🔧 Video Encoding Worker Thread
 *
 * Runs FFmpeg encoding in a separate thread to prevent blocking the main event loop.
 * This keeps the dashboard WebSocket responsive during heavy video processing.
 *
 * Architecture:
 * - Main Thread: Express, WebSocket, job coordination
 * - Worker Thread: FFmpeg video encoding (this file)
 * - Communication: parentPort messages for progress updates
 */

import { parentPort, workerData } from 'worker_threads';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';

interface EncodingTask {
  taskId: string;
  sourceFile: string;
  profile: { name: string; height: number };
  profileDir: string;
  outputPath: string;
  codec: { name: string; type: string };
  timeoutMs: number;
  profileSettings: any;
  strategy?: any;
  segmentDuration?: number;
  isShortVideo?: boolean;
}

interface ProgressUpdate {
  type: 'progress';
  taskId: string;
  percent: number;
  fps?: number;
  bitrate?: string;
}

interface SuccessResult {
  type: 'success';
  taskId: string;
  result: {
    profile: string;
    path: string;
    size: number;
    duration: number;
    segments: string[];
    playlist: string;
  };
}

interface ErrorResult {
  type: 'error';
  taskId: string;
  error: string;
  errorDetails?: string;
}

type WorkerMessage = ProgressUpdate | SuccessResult | ErrorResult;

/**
 * Send message to main thread
 */
function sendMessage(message: WorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
  }
}

/**
 * Main encoding function - runs in worker thread
 */
async function encodeProfile(task: EncodingTask): Promise<void> {
  const { taskId, sourceFile, profile, profileDir, outputPath, codec, timeoutMs, profileSettings, strategy, segmentDuration, isShortVideo } = task;

  return new Promise((resolve, reject) => {
    // 🚀 Configure encoding based on codec type
    let command = ffmpeg(sourceFile);

    // 🎯 Apply input options from strategy (if available)
    if (strategy?.inputOptions && strategy.inputOptions.length > 0) {
      strategy.inputOptions.forEach((opt: string) => command = command.inputOptions(opt));
    }

    // 📱 SHORT VIDEO MODE: Limit to 60 seconds
    if (isShortVideo) {
      command = command.addOption('-t', '60');
    }

    // 🔧 Analyze strategy filters
    let useHybridPipeline = false;
    let softwareFilters: string[] = [];

    if (strategy?.videoFilters && strategy.videoFilters.length > 0) {
      strategy.videoFilters.forEach((filter: string) => {
        if (filter.includes('transpose') || filter.includes('rotate')) {
          softwareFilters.push(filter);
          useHybridPipeline = true;
        }
      });
    }

    // Apply codec-specific settings
    if (codec.name === 'h264_vaapi') {
      // AMD/Intel VAAPI
      command = command
        .addInputOptions('-hwaccel', 'vaapi')
        .addInputOptions('-vaapi_device', '/dev/dri/renderD128')
        .addInputOptions('-hwaccel_output_format', 'vaapi')
        .videoCodec(codec.name);

      if (useHybridPipeline && softwareFilters.length > 0) {
        const filterChain = `${softwareFilters.join(',')},hwupload,format=nv12|vaapi,hwmap,scale_vaapi=-2:${profile.height}:format=nv12`;
        command = command.addOption('-vf', filterChain);
      } else {
        command = command.addOption('-vf', `scale_vaapi=-2:${profile.height}:format=nv12`);
      }

      command = command
        .addOption('-qp', '19')
        .addOption('-bf', '2');
    } else if (codec.name === 'h264_nvenc') {
      // NVIDIA NVENC
      command = command
        .addInputOptions('-hwaccel', 'cuda')
        .addInputOptions('-hwaccel_output_format', 'cuda')
        .videoCodec(codec.name);

      if (useHybridPipeline && softwareFilters.length > 0) {
        const filterChain = `${softwareFilters.join(',')},hwupload_cuda,scale_cuda=-2:${profile.height}`;
        command = command.addOption('-vf', filterChain);
      } else {
        command = command.addOption('-vf', `scale_cuda=-2:${profile.height}`);
      }

      command = command
        .addOption('-preset', 'medium')
        .addOption('-cq', '19')
        .addOption('-b:v', profileSettings.bitrate)
        .addOption('-maxrate', profileSettings.maxrate)
        .addOption('-bufsize', profileSettings.bufsize);
    } else if (codec.name === 'h264_qsv') {
      // Intel QuickSync
      command = command
        .addInputOptions('-hwaccel', 'qsv')
        .addInputOptions('-hwaccel_output_format', 'qsv')
        .videoCodec(codec.name);

      if (useHybridPipeline && softwareFilters.length > 0) {
        const filterChain = `${softwareFilters.join(',')},hwupload=extra_hw_frames=64,format=qsv,scale_qsv=-2:${profile.height}`;
        command = command.addOption('-vf', filterChain);
      } else {
        command = command.addOption('-vf', `scale_qsv=-2:${profile.height}`);
      }

      command = command
        .addOption('-preset', 'medium')
        .addOption('-global_quality', '19')
        .addOption('-b:v', profileSettings.bitrate)
        .addOption('-maxrate', profileSettings.maxrate)
        .addOption('-bufsize', profileSettings.bufsize);
    } else {
      // Software encoding (libx264)
      command = command
        .videoCodec(codec.name)
        .addOption('-preset', 'medium')
        .addOption('-crf', '19');

      let swFilterChain = `scale=-2:${profile.height},fps=30`;
      if (softwareFilters.length > 0) {
        swFilterChain = `${softwareFilters.join(',')},${swFilterChain}`;
      }

      command = command
        .addOption('-vf', swFilterChain)
        .addOption('-b:v', profileSettings.bitrate)
        .addOption('-maxrate', profileSettings.maxrate)
        .addOption('-bufsize', profileSettings.bufsize);
    }

    // 🎯 Apply stream mapping from strategy
    if (strategy?.mapOptions && strategy.mapOptions.length > 0) {
      strategy.mapOptions.forEach((opt: string) => command = command.outputOptions(opt));
    }

    // 🎯 Apply extra options from strategy
    if (strategy?.extraOptions && strategy.extraOptions.length > 0) {
      strategy.extraOptions.forEach((opt: string) => command = command.outputOptions(opt));
    }

    // Common settings for all codecs
    command = command
      .addOption('-profile:v', profileSettings.profile)
      .addOption('-level', profileSettings.level)
      .audioCodec('aac')
      .audioBitrate(profileSettings.audioBitrate)
      .addOption('-ac', '2')
      .addOption('-ar', '48000')
      .addOption('-video_track_timescale', '90000')
      .addOption('-hls_time', (segmentDuration || 6).toString())
      .addOption('-hls_playlist_type', 'vod')
      .addOption('-hls_list_size', '0')
      .addOption('-start_number', '0')
      .addOption('-hls_segment_filename', join(profileDir, `${profile.name}_%d.ts`))
      .format('hls')
      .output(outputPath);

    // Set up event handlers
    command
      .on('start', (commandLine) => {
        console.log(`[Worker ${taskId}] FFmpeg started: ${commandLine.substring(0, 100)}...`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          // Send progress update to main thread
          const message: any = {
            type: 'progress',
            taskId,
            percent: progress.percent
          };
          
          // Add optional properties only if defined
          if (progress.currentFps) message.fps = progress.currentFps;
          if (progress.currentKbps) message.bitrate = `${progress.currentKbps}kbps`;
          
          sendMessage(message);
        }
      })
      .on('end', async () => {
        try {
          clearTimeout(timeoutId);

          // Count segments and get file info
          const files = await fs.readdir(profileDir);
          const segmentFiles = files.filter(f => f.endsWith('.ts'));
          const stats = await fs.stat(outputPath);

          const result = {
            profile: profile.name,
            path: outputPath,
            size: stats.size,
            duration: 0,
            segments: segmentFiles,
            playlist: outputPath
          };

          // Send success result to main thread
          sendMessage({
            type: 'success',
            taskId,
            result
          });

          resolve();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          sendMessage({
            type: 'error',
            taskId,
            error: errorMsg
          });
          reject(error);
        }
      })
      .on('error', (error) => {
        clearTimeout(timeoutId);

        // Enhanced error diagnostics
        const errorMsg = error.message || String(error);
        let errorDetails = '';

        if (codec.type === 'hardware') {
          if (errorMsg.includes('scale_cuda')) {
            errorDetails = 'Missing scale_cuda filter. FFmpeg needs: --enable-cuda --enable-libnpp';
          } else if (errorMsg.includes('scale_vaapi')) {
            errorDetails = 'Missing scale_vaapi filter. FFmpeg needs: --enable-vaapi';
          } else if (errorMsg.includes('scale_qsv')) {
            errorDetails = 'Missing scale_qsv filter. FFmpeg needs: --enable-libmfx';
          } else if (errorMsg.includes('hwupload')) {
            errorDetails = 'Missing hwupload filter - cannot transfer to GPU';
          } else if (errorMsg.includes('Cannot load') || errorMsg.includes('cuda')) {
            errorDetails = 'CUDA library not loaded. Check: 1) nvidia-smi works 2) drivers installed';
          } else if (errorMsg.includes('Cannot initialize') || errorMsg.includes('hwaccel')) {
            errorDetails = 'Hardware initialization failed. Check: 1) GPU detected 2) Drivers loaded 3) Permissions';
          } else if (errorMsg.includes('/dev/dri')) {
            errorDetails = 'VAAPI device access denied. Fix: sudo usermod -aG render $USER && logout';
          }
        }

        // Send error to main thread
        sendMessage({
          type: 'error',
          taskId,
          error: errorMsg,
          errorDetails
        });

        // Kill FFmpeg process
        try {
          command.kill('SIGKILL');
        } catch (e) {
          // Ignore kill errors
        }

        reject(error);
      });

    // Set timeout
    const timeoutId = setTimeout(() => {
      console.log(`[Worker ${taskId}] Timeout (${timeoutMs / 1000}s)`);
      try {
        command.kill('SIGKILL');
      } catch (e) {
        // Ignore kill errors
      }

      const timeoutError = `${codec.name} encoding timeout for ${profile.name} (${timeoutMs / 1000}s)`;
      sendMessage({
        type: 'error',
        taskId,
        error: timeoutError
      });

      reject(new Error(timeoutError));
    }, timeoutMs);

    // Start encoding
    command.run();
  });
}

/**
 * Worker thread entry point
 */
if (parentPort) {
  parentPort.on('message', async (task: EncodingTask) => {
    try {
      await encodeProfile(task);
    } catch (error) {
      // Error already sent to main thread via sendMessage
      console.error(`[Worker ${task.taskId}] Encoding failed:`, error);
    }
  });

  // Signal that worker is ready
  sendMessage({
    type: 'progress',
    taskId: 'worker-ready',
    percent: 0
  });
} else {
  console.error('VideoEncodingWorker must be run as a Worker Thread');
  process.exit(1);
}
