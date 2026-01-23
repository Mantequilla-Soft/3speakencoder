import ffmpeg from 'fluent-ffmpeg';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { VideoJob, EncodedOutput, CodecCapability, EncodingProgress, FileProbeResult, ProbeIssue, StreamInfo, EncodingStrategy } from '../types/index.js';
import { logger } from './Logger.js';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { IPFSService } from './IPFSService.js';
import { DashboardService } from './DashboardService.js';
import { cleanErrorForLogging } from '../common/errorUtils.js';

export class VideoProcessor {
  private config: EncoderConfig;
  private availableCodecs: CodecCapability[] = [];
  private tempDir: string;
  private ipfsService: IPFSService;
  private dashboard: DashboardService | undefined;
  private currentJobId?: string;

  constructor(config: EncoderConfig, ipfsService: IPFSService, dashboard?: DashboardService) {
    this.config = config;
    this.ipfsService = ipfsService;
    this.dashboard = dashboard;
    this.tempDir = config.encoder?.temp_dir || join(tmpdir(), '3speak-encoder');
  }
  
  setCurrentJob(jobId: string): void {
    this.currentJobId = jobId;
  }

  async initialize(): Promise<void> {
    try {
      // Ensure temp directory exists
      await fs.mkdir(this.tempDir, { recursive: true });
      
      // Test FFmpeg availability
      await this.testFFmpeg();
      
      // Detect available codecs
      await this.detectCodecs();
      
      logger.info(`🎬 Video processor ready with ${this.availableCodecs.length} codecs`);
    } catch (error) {
      logger.error('❌ Failed to initialize video processor:', error);
      throw error;
    }
  }

  private async testFFmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          reject(new Error(`FFmpeg not available: ${err.message}`));
        } else {
          logger.info('✅ FFmpeg is available');
          resolve();
        }
      });
    });
  }

  private async checkSystemCapabilities(): Promise<void> {
    try {
      // Check for VAAPI support
      try {
        const { access } = await import('fs/promises');
        await access('/dev/dri/renderD128');
        logger.info('✅ VAAPI device found: /dev/dri/renderD128');
      } catch {
        logger.debug('ℹ️ VAAPI device not found (/dev/dri/renderD128)');
      }

      // Check for NVIDIA GPU
      try {
        const { exec } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
          exec('nvidia-smi', (error) => {
            if (error) {
              logger.debug('ℹ️ NVIDIA GPU not detected (nvidia-smi not available)');
              reject();
            } else {
              logger.info('✅ NVIDIA GPU detected');
              resolve();
            }
          });
        });
      } catch {
        // nvidia-smi not available, that's fine
      }

      // Check user groups for hardware access
      try {
        const { exec } = await import('child_process');
        const groups = await new Promise<string>((resolve, reject) => {
          exec('groups', (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout.trim());
          });
        });
        
        logger.info(`👤 User groups: ${groups}`);
        
        if (groups.includes('render')) {
          logger.info('✅ User is in "render" group - VAAPI should work');
        } else {
          logger.warn('⚠️ User not in "render" group - VAAPI may not work');
          logger.warn('💡 To fix: sudo usermod -a -G render $USER (then logout/login)');
        }
        
        if (groups.includes('video')) {
          logger.info('✅ User is in "video" group - hardware access available');
        }
      } catch (error) {
        logger.debug('Could not check user groups:', error);
      }
    } catch (error) {
      logger.warn('System capability check failed:', error);
    }
  }

  private async detectCodecs(): Promise<void> {
    const codecs: CodecCapability[] = [
      { name: 'libx264', type: 'software', available: false, tested: false, priority: 10 },
      { name: 'h264_qsv', type: 'hardware', available: false, tested: false, priority: 1 },
      { name: 'h264_nvenc', type: 'hardware', available: false, tested: false, priority: 2 },
      { name: 'h264_vaapi', type: 'hardware', available: false, tested: false, priority: 3 }
    ];

    // 🔍 System hardware capability checks
    logger.info('🔍 Checking system hardware capabilities...');
    await this.checkSystemCapabilities();

    // Check which codecs are available in FFmpeg
    const availableEncoders = await new Promise<any>((resolve, reject) => {
      ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) reject(err);
        else resolve(encoders);
      });
    });

    for (const codec of codecs) {
      if (availableEncoders[codec.name]) {
        codec.available = true;
        logger.info(`📋 ${codec.name} is available in FFmpeg`);
        
        // Test hardware codecs to ensure they actually work with the system
        if (codec.type === 'hardware') {
          logger.info(`🧪 Testing hardware codec: ${codec.name}`);
          codec.tested = await this.testCodec(codec.name);
        } else {
          codec.tested = true; // Assume software codecs work
        }
      } else {
        logger.debug(`❌ ${codec.name} not available in FFmpeg build`);
      }
    }

    // 🛡️ CASCADING FALLBACK: Include ALL available codecs for fallback options
    // Primary: tested codecs (confirmed working)
    const testedCodecs = codecs
      .filter(c => c.available && c.tested)
      .sort((a, b) => a.priority - b.priority);
    
    // Fallback: untested but available codecs (for cascading fallback)
    const fallbackCodecs = codecs
      .filter(c => c.available && !c.tested)
      .sort((a, b) => a.priority - b.priority);
    
    // Always ensure libx264 is available as final fallback
    const softwareFallback = codecs.find(c => c.name === 'libx264' && c.available);
    
    // Combine: tested first, then untested hardware, then software
    this.availableCodecs = [...testedCodecs];
    
    // Add untested hardware codecs as fallback options
    fallbackCodecs.forEach(codec => {
      if (codec.type === 'hardware' && !this.availableCodecs.find(c => c.name === codec.name)) {
        this.availableCodecs.push(codec);
      }
    });
    
    // Ensure software fallback is always last
    if (softwareFallback && !this.availableCodecs.find(c => c.name === 'libx264')) {
      this.availableCodecs.push(softwareFallback);
    }

    // 📊 Detailed codec detection results with cascading fallback info
    logger.info('🔍 Codec Detection Summary (Cascading Fallback Strategy):');
    logger.info('═══════════════════════════════════════');
    
    const testedHardware = this.availableCodecs.filter(c => c.type === 'hardware' && c.tested);
    const untestedHardware = this.availableCodecs.filter(c => c.type === 'hardware' && !c.tested);
    const softwareCodecs = this.availableCodecs.filter(c => c.type === 'software');
    
    if (testedHardware.length > 0) {
      logger.info('🚀 PRIMARY: Tested Hardware (Will try first):');
      testedHardware.forEach(codec => {
        logger.info(`  ✅ ${codec.name} - Priority ${codec.priority} (Confirmed working)`);
      });
    }
    
    if (untestedHardware.length > 0) {
      logger.info('🔄 FALLBACK: Untested Hardware (Will try if primary fails):');
      untestedHardware.forEach(codec => {
        logger.info(`  🧪 ${codec.name} - Priority ${codec.priority} (Available but untested)`);
      });
    }
    
    if (softwareCodecs.length > 0) {
      logger.info('🔄️ FINAL FALLBACK: Software (Bulletproof reliability):');
      softwareCodecs.forEach(codec => {
        logger.info(`  💻 ${codec.name} - Always reliable`);
      });
    }
    
    // Show completely failed codecs for debugging
    const failedCodecs = codecs.filter(c => c.available && !this.availableCodecs.find(ac => ac.name === c.name));
    if (failedCodecs.length > 0) {
      logger.warn('❌ Excluded Codecs (Failed tests):');
      failedCodecs.forEach(codec => {
        logger.warn(`  ❌ ${codec.name} (${codec.type}) - Test failed, not included in fallback chain`);
      });
    }
    
    logger.info('═══════════════════════════════════════');
    
    if (this.availableCodecs.length === 0) {
      throw new Error('No working video codecs found');
    }
    
    // Log the codec that will be used
    const bestCodec = this.availableCodecs[0]!;
    if (bestCodec.type === 'hardware') {
      logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Hardware acceleration ACTIVE!) 🚀`);
    } else {
      logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Software encoding)`);
    }
  }

  private async testCodec(codecName: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      const testFile = join(this.tempDir, `test-${codecName}-${randomUUID()}.mp4`);
      
      logger.info(`🧪 Testing codec: ${codecName}`);
      
      let command: any;
      
      // 🎯 SERVER-COMPATIBLE: Use /dev/zero instead of lavfi (works on all systems)
      if (codecName === 'h264_vaapi') {
        // VAAPI test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-b:v', '100k')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_nvenc') {
        // NVENC test - use /dev/zero with rawvideo format  
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'fast')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_qsv') {
        // Intel QuickSync test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'medium')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else {
        // Software codec test - use /dev/zero with rawvideo format
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      }
      
      command
        .output(testFile)
        .on('start', (cmdLine: string) => {
          logger.debug(`🔧 ${codecName} test command: ${cmdLine}`);
        })
        .on('end', async () => {
          try {
            await fs.unlink(testFile);
          } catch {
            // File might not exist, that's fine
          }
          logger.info(`✅ ${codecName} test passed - hardware acceleration working!`);
          resolve(true);
        })
        .on('error', (err: any) => {
          logger.warn(`❌ ${codecName} test failed: ${err.message}`);
          
          // 🔍 Detailed hardware codec troubleshooting
          if (codecName.includes('vaapi')) {
            if (err.message.includes('No such file') || err.message.includes('Cannot load')) {
              logger.warn(`💡 VAAPI: Hardware device not accessible - check /dev/dri/renderD128 and 'render' group`);
            } else if (err.message.includes('Function not implemented')) {
              logger.warn(`💡 VAAPI: Driver doesn't support this codec - try updating graphics drivers`);
            } else {
              logger.warn(`💡 VAAPI: Hardware acceleration not available on this system`);
            }
          } else if (codecName.includes('nvenc')) {
            logger.warn(`💡 NVENC: NVIDIA GPU or drivers not available`);
          } else if (codecName.includes('qsv')) {
            if (err.message.includes('unsupported')) {
              logger.warn(`💡 Intel QSV: Hardware not supported or drivers missing`);
            } else {
              logger.warn(`💡 Intel QSV: QuickSync not available on this system`);
            }
          }
          
          logger.info(`ℹ️ Codec ${codecName} will fall back to software encoding`);;
          
          resolve(false);
        });

      // 🕐 Reasonable timeout for codec tests
      const timeout = codecName.includes('264') && !codecName.includes('lib') ? 5000 : 3000;
      const timeoutHandle = setTimeout(() => {
        try {
          command.kill('SIGKILL');
        } catch (e) {
          // Ignore kill errors
        }
        logger.warn(`⏰ ${codecName} test timeout after ${timeout/1000}s`);
        resolve(false);
      }, timeout);

      try {
        command.run();
      } catch (error) {
        clearTimeout(timeoutHandle);
        logger.warn(`❌ ${codecName} failed to start: ${error}`);
        resolve(false);
      }
    });
  }

  /**
   * 🔍 Probe input file to detect format, codecs, and compatibility issues
   * Uses ffprobe to analyze the file before encoding
   */
  private async probeInputFile(filePath: string): Promise<FileProbeResult> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          logger.error(`❌ Failed to probe file ${filePath}:`, err);
          return reject(err);
        }

        try {
          // Find video and audio streams
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
          const extraStreams = metadata.streams.filter(s => 
            s.codec_type !== 'video' && s.codec_type !== 'audio'
          );

          // Extract key information
          const container = metadata.format?.format_name?.split(',')[0] || 'unknown';
          const videoCodec = videoStream?.codec_name || 'unknown';
          const audioCodec = audioStream?.codec_name || 'unknown';
          const pixelFormat = videoStream?.pix_fmt || 'yuv420p';
          const bitDepth = this.getPixelFormatBitDepth(pixelFormat);
          const colorSpace = videoStream?.color_space;
          const colorTransfer = videoStream?.color_transfer;

          // 📱 ROTATION DETECTION: Check for iPhone/mobile rotation metadata
          let rotationDegrees = 0;
          
          // Check multiple sources for rotation information
          // 1. Stream-level rotation tag
          if (videoStream?.tags?.rotate) {
            rotationDegrees = parseInt(videoStream.tags.rotate);
          }
          
          // 2. Stream-level side_data (more reliable for MOV files)
          if (!rotationDegrees && (videoStream as any)?.side_data_list) {
            const rotationData = (videoStream as any).side_data_list.find((sd: any) => 
              sd.side_data_type === 'Display Matrix' || sd.rotation !== undefined
            );
            if (rotationData?.rotation !== undefined) {
              rotationDegrees = -rotationData.rotation; // FFmpeg uses negative rotation
            }
          }
          
          // 3. Format-level rotation (fallback)
          if (!rotationDegrees && metadata.format?.tags?.rotate) {
            rotationDegrees = parseInt(String(metadata.format.tags.rotate));
          }
          
          // Normalize rotation to 0, 90, 180, 270
          if (rotationDegrees) {
            rotationDegrees = ((rotationDegrees % 360) + 360) % 360;
            if (rotationDegrees % 90 !== 0) {
              logger.warn(`⚠️ Unusual rotation angle: ${rotationDegrees}°, will round to nearest 90°`);
              rotationDegrees = Math.round(rotationDegrees / 90) * 90;
            }
          }
          
          // Check for HDR metadata
          const hdrMetadata = colorTransfer === 'smpte2084' || 
                             colorTransfer === 'arib-std-b67' ||
                             (videoStream as any)?.side_data_list?.some((sd: any) => 
                               sd.side_data_type === 'Mastering display metadata' ||
                               sd.side_data_type === 'Content light level metadata'
                             );

          // Collect extra streams info
          const streamInfos: StreamInfo[] = extraStreams.map(s => {
            const info: StreamInfo = {
              index: s.index,
              type: s.codec_type || 'data'
            };
            if (s.codec_name) info.codec = s.codec_name;
            if (s.tags) info.tags = s.tags as Record<string, string>;
            return info;
          });

          // Detect issues
          const issues: ProbeIssue[] = [];
          
          // Issue: Extra metadata streams (iPhone MOV files)
          if (extraStreams.length > 0) {
            issues.push({
              severity: 'warning',
              type: 'extra_streams',
              message: `File contains ${extraStreams.length} non-media stream(s) (metadata, subtitles, etc.)`,
              suggestion: 'Will use -map 0:v:0 -map 0:a:0 to select only video and audio'
            });
          }

          // Issue: 10-bit or higher color depth
          if (bitDepth > 8) {
            issues.push({
              severity: 'warning',
              type: 'high_bit_depth',
              message: `Video uses ${bitDepth}-bit color depth (${pixelFormat})`,
              suggestion: 'Will convert to 8-bit yuv420p for web compatibility'
            });
          }

          // Issue: Video rotation (iPhone/mobile videos)
          if (rotationDegrees !== 0) {
            issues.push({
              severity: 'warning',
              type: 'video_rotation',
              message: `Video has ${rotationDegrees}° rotation metadata (likely iPhone/mobile)`,
              suggestion: 'Will auto-rotate video during encoding to fix sideways/upside-down display'
            });
          }

          // Issue: HDR metadata
          if (hdrMetadata) {
            issues.push({
              severity: 'info',
              type: 'hdr_metadata',
              message: `Video contains HDR metadata (${colorTransfer})`,
              suggestion: 'Will flatten to SDR for universal compatibility'
            });
          }

          // Issue: HEVC/H.265 codec (not HTML5-safe, requires transcoding)
          if (videoCodec === 'hevc' || videoCodec === 'h265' || videoCodec === 'hvc1') {
            issues.push({
              severity: 'warning',
              type: 'hevc_input',
              message: 'Video encoded with HEVC/H.265 - NOT HTML5-compatible',
              suggestion: 'Will transcode to H.264 for universal browser support'
            });
          }

          // Issue: VP9 codec (not universally supported)
          if (videoCodec === 'vp9') {
            issues.push({
              severity: 'warning',
              type: 'vp9_input',
              message: 'Video encoded with VP9 - limited browser support',
              suggestion: 'Will transcode to H.264 for universal compatibility'
            });
          }

          // Issue: AV1 codec (very new, limited support)
          if (videoCodec === 'av1') {
            issues.push({
              severity: 'warning',
              type: 'av1_input',
              message: 'Video encoded with AV1 - very limited browser support',
              suggestion: 'Will transcode to H.264 for universal compatibility'
            });
          }

          // Issue: HE-AAC audio (not HTML5-safe, requires AAC-LC)
          if (audioCodec && (audioCodec.includes('aac_he') || audioCodec === 'aac_latm' || audioCodec === 'aac_fixed')) {
            issues.push({
              severity: 'warning',
              type: 'he_aac_audio',
              message: `Audio codec ${audioCodec} is not HTML5-safe (HE-AAC variants)`,
              suggestion: 'Will transcode to AAC-LC for universal browser support'
            });
          }

          // Issue: Opus/Vorbis audio (not widely supported in MP4)
          if (audioCodec && (audioCodec === 'opus' || audioCodec === 'vorbis')) {
            issues.push({
              severity: 'warning',
              type: 'incompatible_audio',
              message: `Audio codec ${audioCodec} not compatible with HTML5/MP4`,
              suggestion: 'Will transcode to AAC-LC for universal compatibility'
            });
          }

          // Issue: Non-standard framerates
          const framerate = videoStream?.r_frame_rate ? this.parseFramerate(videoStream.r_frame_rate) : 30;
          if (framerate > 60) {
            issues.push({
              severity: 'warning',
              type: 'high_framerate',
              message: `High framerate detected: ${framerate}fps`,
              suggestion: 'Will normalize to 30fps for HLS streaming'
            });
          }

          // Issue: Ultra-low framerate (problematic for encoding)
          if (framerate < 15 && framerate > 0) {
            issues.push({
              severity: 'warning',
              type: 'low_framerate',
              message: `Very low framerate detected: ${framerate}fps`,
              suggestion: 'May cause slow encoding and player compatibility issues'
            });
          }

          // Issue: Extreme video duration (>2 hours)
          const durationHours = (metadata.format?.duration || 0) / 3600;
          if (durationHours > 2) {
            issues.push({
              severity: 'error',
              type: 'extreme_duration',
              message: `Extremely long video: ${durationHours.toFixed(1)} hours`,
              suggestion: 'Encoding will take very long time, consider splitting or increasing timeouts'
            });
          }

          // Issue: Tiny resolution (unusual/problematic)
          const width = videoStream?.width || 1920;
          const height = videoStream?.height || 1080;
          if (width < 480 || height < 360) {
            issues.push({
              severity: 'warning',
              type: 'tiny_resolution',
              message: `Very small resolution: ${width}x${height}`,
              suggestion: 'May cause upscaling artifacts when creating higher quality outputs'
            });
          }

          // Issue: Massive frame count (processing intensive)
          const frameCount = parseInt(videoStream?.nb_frames || '0');
          if (frameCount > 50000) {
            issues.push({
              severity: 'error',
              type: 'massive_frame_count',
              message: `Extremely high frame count: ${frameCount.toLocaleString()} frames`,
              suggestion: 'Will require extended processing time and may timeout'
            });
          }

          // Issue: Non-standard aspect ratio
          const aspectRatio = width / height;
          const isStandardAspect = Math.abs(aspectRatio - 16/9) < 0.1 || 
                                   Math.abs(aspectRatio - 4/3) < 0.1 || 
                                   Math.abs(aspectRatio - 1) < 0.1;
          if (!isStandardAspect) {
            issues.push({
              severity: 'info',
              type: 'unusual_aspect_ratio',
              message: `Non-standard aspect ratio: ${aspectRatio.toFixed(2)}:1 (${width}x${height})`,
              suggestion: 'May require letterboxing or pillarboxing for standard outputs'
            });
          }

          // 🚀 Issue: Ultra-compressed video (compressed to death!)
          const fileSizeBytes = metadata.format?.size || 0;
          const durationSeconds = metadata.format?.duration || 1;
          const bitsPerSecond = (fileSizeBytes * 8) / durationSeconds;
          const pixelsPerSecond = width * height * framerate;
          const bitsPerPixel = pixelsPerSecond > 0 ? bitsPerSecond / pixelsPerSecond : 0;
          
          // Detection: ultra-low bitrate OR very small file for duration
          const isUltraCompressed = bitsPerPixel < 0.1 || // <0.1 bits per pixel (extremely compressed)
                                   bitsPerSecond < 500000 || // <500kbps total bitrate
                                   (fileSizeBytes < 500 * 1024 * 1024 && durationSeconds > 1800); // <500MB for >30min video
          
          if (isUltraCompressed) {
            issues.push({
              severity: 'info',
              type: 'ultra_compressed',
              message: `Video is ultra-compressed: ${(bitsPerSecond/1000).toFixed(0)}kbps, ${bitsPerPixel.toFixed(3)} bits/pixel`,
              suggestion: 'Will use passthrough mode - just segment for HLS without re-encoding to avoid quality loss'
            });
          }

          const result: FileProbeResult = {
            container,
            videoCodec,
            audioCodec,
            pixelFormat,
            bitDepth,
            hdrMetadata,
            rotationDegrees,
            resolution: {
              width: videoStream?.width || 1920,
              height: videoStream?.height || 1080
            },
            framerate,
            duration: metadata.format?.duration || 0,
            videoStreamCount: metadata.streams.filter(s => s.codec_type === 'video').length,
            audioStreamCount: metadata.streams.filter(s => s.codec_type === 'audio').length,
            extraStreams: streamInfos,
            issues,
            rawMetadata: metadata
          };
          
          // Add optional properties only if they exist
          if (colorSpace) result.colorSpace = colorSpace;
          if (colorTransfer) result.colorTransfer = colorTransfer;
          if (metadata.format?.bit_rate) result.bitrate = parseInt(String(metadata.format.bit_rate));

          logger.info(`🔍 File probe complete: ${container}/${videoCodec}/${pixelFormat} ${result.resolution.width}x${result.resolution.height}@${framerate}fps`);
          if (issues.length > 0) {
            logger.info(`⚠️ Detected ${issues.length} compatibility issue(s):`);
            issues.forEach(issue => {
              logger.info(`   ${issue.severity.toUpperCase()}: ${issue.message}`);
            });
          }

          resolve(result);
        } catch (parseError) {
          logger.error(`❌ Failed to parse probe metadata:`, parseError);
          reject(parseError);
        }
      });
    });
  }

  /**
   * Get bit depth from pixel format string
   */
  private getPixelFormatBitDepth(pixelFormat: string): number {
    const bitDepthMap: Record<string, number> = {
      'yuv420p': 8,
      'yuvj420p': 8,
      'yuv422p': 8,
      'yuv444p': 8,
      'yuv420p10le': 10,
      'yuv420p10be': 10,
      'yuv422p10le': 10,
      'yuv422p10be': 10,
      'yuv444p10le': 10,
      'yuv444p10be': 10,
      'yuv420p12le': 12,
      'yuv420p12be': 12,
      'yuv422p12le': 12,
      'yuv422p12be': 12,
      'yuv444p12le': 12,
      'yuv444p12be': 12,
      'yuv420p16le': 16,
      'yuv420p16be': 16
    };
    return bitDepthMap[pixelFormat] || 8;
  }

  /**
   * Parse ffmpeg framerate fraction (e.g., "30000/1001" -> 29.97)
   */
  private parseFramerate(frameRateStr: string): number {
    const parts = frameRateStr.split('/');
    if (parts.length === 2) {
      return parseInt(parts[0]!) / parseInt(parts[1]!);
    }
    return parseFloat(frameRateStr);
  }

  /**
   * 🚨 Calculate adaptive timeout based on video characteristics and codec type
   * Returns timeout in milliseconds
   */
  private calculateAdaptiveTimeout(sourceFile: string, codec: any, strategy?: EncodingStrategy | null): number {
    // Base timeouts
    const isHardware = codec.type === 'hardware';
    const baseTimeout = isHardware ? 60000 : 1800000; // 1 min hardware, 30 min software
    
    // Get video duration from the source file if possible
    // For now, we'll use the strategy reason to detect extreme cases
    const strategyReason = strategy?.reason || '';
    
    // Multipliers for extreme cases
    let timeoutMultiplier = 1;
    
    // Ultra-long videos (2+ hours)
    if (strategyReason.includes('extreme duration')) {
      timeoutMultiplier = Math.max(timeoutMultiplier, 3); // 3x timeout
      logger.info(`🚨 Extreme duration detected - using 3x timeout multiplier`);
    }
    
    // Massive frame count
    if (strategyReason.includes('massive frame count')) {
      timeoutMultiplier = Math.max(timeoutMultiplier, 4); // 4x timeout
      logger.info(`🚨 Massive frame count detected - using 4x timeout multiplier`);
    }
    
    // Low framerate (needs frame duplication)
    if (strategyReason.includes('normalize') && strategyReason.includes('fps')) {
      timeoutMultiplier = Math.max(timeoutMultiplier, 2); // 2x timeout
      logger.info(`🚨 Low framerate normalization - using 2x timeout multiplier`);
    }
    
    // Hardware acceleration might be faster for extreme cases
    if (timeoutMultiplier > 2 && isHardware) {
      timeoutMultiplier *= 0.7; // 30% reduction for hardware on extreme cases
      logger.info(`⚡ Hardware acceleration - reducing timeout by 30% for extreme case`);
    }
    
    const finalTimeout = Math.floor(baseTimeout * timeoutMultiplier);
    const maxTimeout = 7200000; // 2 hours absolute maximum
    const clampedTimeout = Math.min(finalTimeout, maxTimeout);
    
    if (clampedTimeout !== baseTimeout) {
      logger.info(`⏱️ Adaptive timeout: ${(clampedTimeout/1000/60).toFixed(1)} minutes (base: ${(baseTimeout/1000/60).toFixed(1)}m, multiplier: ${timeoutMultiplier.toFixed(1)}x)`);
    }
    
    return clampedTimeout;
  }

  /**
   * 🎯 Determine encoding strategy based on probe results
   * Returns optimized ffmpeg options for the detected file format
   */
  private determineEncodingStrategy(probe: FileProbeResult): EncodingStrategy {
    const strategy: EncodingStrategy = {
      inputOptions: [],
      mapOptions: [],
      videoFilters: [],
      codecPriority: [],
      extraOptions: [],
      reason: ''
    };

    const reasons: string[] = [];

    // 0. CRITICAL: Check codec compatibility FIRST (before any bypass logic)
    // HEVC/H.265, VP9, AV1 are NOT compatible with HTML5/HLS in most browsers
    const isIncompatibleVideo = ['hevc', 'h265', 'hvc1', 'vp9', 'av1'].includes(probe.videoCodec);
    const isIncompatibleAudio = probe.audioCodec && ['aac_he', 'aac_latm', 'aac_fixed', 'opus', 'vorbis'].some(codec => 
      probe.audioCodec.includes(codec)
    );

    // 1. PRIORITY: Ultra-compressed content - use passthrough ONLY if codecs are compatible
    const ultraCompressedIssue = probe.issues.find(issue => issue.type === 'ultra_compressed');
    if (ultraCompressedIssue && !isIncompatibleVideo && !isIncompatibleAudio) {
      // Pure passthrough mode - no re-encoding, just segment for HLS
      // ✅ Safe because video already uses H.264/AAC (browser-compatible)
      strategy.codecPriority = ['copy']; // Use copy codec to avoid re-encoding
      strategy.extraOptions.push(
        '-c:v', 'copy',     // Copy video without re-encoding
        '-c:a', 'copy',     // Copy audio without re-encoding
        '-avoid_negative_ts', 'make_zero',  // Fix timestamp issues
        '-copyts'           // Preserve original timestamps
      );
      
      // Single quality output since we're not re-encoding
      strategy.reason = `passthrough mode for ultra-compressed H.264/AAC content (${ultraCompressedIssue.suggestion})`;
      
      logger.info(`🔄 Using passthrough encoding for ultra-compressed video: ${ultraCompressedIssue.suggestion}`);
      logger.info(`✅ Codec check passed: ${probe.videoCodec}/${probe.audioCodec} are browser-compatible`);
      
      return strategy; // Early return - skip all other processing
    }
    
    // 🚨 If ultra-compressed BUT incompatible codec → log warning and continue to transcode
    if (ultraCompressedIssue && (isIncompatibleVideo || isIncompatibleAudio)) {
      logger.warn(`⚠️  Ultra-compressed video detected, but codec is incompatible with browsers:`);
      logger.warn(`   Video: ${probe.videoCodec} ${isIncompatibleVideo ? '❌ (requires H.264)' : '✅'}`);
      logger.warn(`   Audio: ${probe.audioCodec} ${isIncompatibleAudio ? '❌ (requires AAC)' : '✅'}`);
      logger.warn(`   Will transcode to H.264/AAC for browser compatibility (output will be larger)`);
    }

    // 2. Handle extra metadata streams (iPhone .mov files)
    if (probe.extraStreams.length > 0) {
      strategy.mapOptions.push('-map', '0:v:0', '-map', '0:a:0');
      reasons.push(`exclude ${probe.extraStreams.length} metadata stream(s)`);
    }

    // 3. Handle high bit depth / HDR content
    if (probe.bitDepth > 8 || probe.hdrMetadata) {
      strategy.videoFilters.push('format=yuv420p');
      reasons.push(`convert ${probe.bitDepth}-bit to 8-bit yuv420p`);
    }

    // 4. Auto-rotate video based on metadata (iPhone/mobile videos)
    if (probe.rotationDegrees !== 0) {
      // Apply rotation using transpose filter for 90° increments
      switch (probe.rotationDegrees) {
        case 90:
          strategy.videoFilters.push('transpose=1'); // 90° clockwise
          reasons.push('auto-rotate 90° clockwise');
          break;
        case 180:
          strategy.videoFilters.push('transpose=2,transpose=2'); // 180° (two 90° rotations)
          reasons.push('auto-rotate 180°');
          break;
        case 270:
          strategy.videoFilters.push('transpose=2'); // 90° counter-clockwise
          reasons.push('auto-rotate 270° (90° counter-clockwise)');
          break;
        default:
          // For non-standard angles, use rotate filter
          const radians = (probe.rotationDegrees * Math.PI) / 180;
          strategy.videoFilters.push(`rotate=${radians}:fillcolor=black:ow=rotw(${radians}):oh=roth(${radians})`);
          reasons.push(`auto-rotate ${probe.rotationDegrees}°`);
          break;
      }
    }

    // 5. iPhone .mov specific handling
    if (probe.container === 'mov' && probe.extraStreams.length > 0) {
      strategy.extraOptions.push('-movflags', '+faststart');
      reasons.push('iPhone .mov file - add faststart flag');
    }

    // 6. 🚨 INCOMPATIBLE CODECS: Force H.264 + AAC-LC transcoding
    // (codec variables already defined at top of function)
    if (isIncompatibleVideo || isIncompatibleAudio) {
      const codecIssues: string[] = [];
      
      if (isIncompatibleVideo) {
        // Force video transcoding to H.264
        strategy.extraOptions.push('-c:v', 'libx264'); // Will be overridden by hardware if available
        strategy.extraOptions.push('-profile:v', 'high');
        strategy.extraOptions.push('-level', '4.0');
        strategy.extraOptions.push('-pix_fmt', 'yuv420p');
        codecIssues.push(`video: ${probe.videoCodec} → H.264`);
      }
      
      if (isIncompatibleAudio) {
        // Force audio transcoding to AAC-LC
        strategy.extraOptions.push('-c:a', 'aac');
        strategy.extraOptions.push('-b:a', '128k');
        strategy.extraOptions.push('-ac', '2');
        strategy.extraOptions.push('-ar', '48000');
        codecIssues.push(`audio: ${probe.audioCodec} → AAC-LC`);
      }
      
      reasons.push(`🚨 HTML5 COMPATIBILITY: force transcode (${codecIssues.join(', ')})`);
      
      logger.warn(`🚨 INCOMPATIBLE CODECS DETECTED - Forcing transcode to HTML5-safe formats`);
      logger.warn(`   Video: ${probe.videoCodec} ${isIncompatibleVideo ? '→ H.264 (required)' : '✓'}`);
      logger.warn(`   Audio: ${probe.audioCodec} ${isIncompatibleAudio ? '→ AAC-LC (required)' : '✓'}`);
      logger.warn(`   ⚠️  Output will be LARGER but universally playable in browsers`);
    }

    // 7. High framerate normalization
    if (probe.framerate > 60) {
      // FPS filter already applied in encoding, just note it
      reasons.push(`normalize ${probe.framerate}fps to 30fps`);
    }

    // 8. 🚨 EXTREME CASE HANDLING: Ultra-long videos
    const durationHours = probe.duration / 3600;
    if (durationHours > 2) {
      // Use faster encoding preset for extreme duration videos
      strategy.extraOptions.push('-preset', 'superfast');
      strategy.extraOptions.push('-crf', '28'); // Higher CRF for faster encoding
      reasons.push(`extreme duration (${durationHours.toFixed(1)}h) - use fast preset`);
    }

    // 9. 🚨 MASSIVE FRAME COUNT: Optimize for processing speed
    const hasIssue = probe.issues.find(i => i.type === 'massive_frame_count');
    if (hasIssue) {
      // Enable multi-threading and fast encoding options
      strategy.extraOptions.push('-threads', '0'); // Use all available CPU cores
      strategy.extraOptions.push('-preset', 'ultrafast'); // Fastest encoding preset
      strategy.extraOptions.push('-tune', 'fastdecode'); // Optimize for fast decoding
      reasons.push('massive frame count - optimize for speed');
    }

    // 8. 🚨 LOW FRAMERATE HANDLING: Duplicate frames to normalize
    if (probe.framerate < 15 && probe.framerate > 0) {
      // Use fps filter to normalize low framerates to 15fps minimum
      strategy.videoFilters.push(`fps=fps=15`);
      reasons.push(`normalize ${probe.framerate}fps to 15fps minimum`);
    }

    // 9. 🚨 TINY RESOLUTION: Prevent extreme upscaling issues
    if (probe.resolution.width < 480 || probe.resolution.height < 360) {
      // Add scaling strategy to handle tiny resolutions better
      strategy.extraOptions.push('-sws_flags', 'lanczos'); // Better upscaling algorithm
      reasons.push(`tiny resolution ${probe.resolution.width}x${probe.resolution.height} - use better upscaling`);
    }

    // 10. 🚨 CYRILLIC/UNICODE METADATA: Handle encoding issues
    const hasUnicodeMetadata = probe.rawMetadata?.format?.tags?.title && 
      /[^\x00-\x7F]/.test(probe.rawMetadata.format.tags.title);
    if (hasUnicodeMetadata) {
      // Strip problematic metadata that might cause encoding failures
      strategy.extraOptions.push('-map_metadata', '-1');
      reasons.push('unicode metadata detected - strip to prevent encoding issues');
    }

    strategy.reason = reasons.length > 0 ? reasons.join(', ') : 'standard processing';
    
    return strategy;
  }

  async processVideo(
    job: VideoJob,
    progressCallback?: (progress: EncodingProgress) => void,
    onPinFailed?: (hash: string, error: Error) => void
  ): Promise<EncodedOutput[]> {
    const jobId = job.id;
    const workDir = join(this.tempDir, jobId);
    const outputsDir = join(workDir, 'outputs'); // Separate directory for encoded outputs only
    
    // 📱 SHORT VIDEO MODE: 480p only, 60s max duration
    logger.info(`🔍 DEBUG: job.short = ${job.short}, type = ${typeof job.short}`);
    const isShortVideo = job.short === true;
    logger.info(`🔍 DEBUG: isShortVideo = ${isShortVideo}`);
    if (isShortVideo) {
      logger.info(`📱 SHORT VIDEO MODE: Will process 480p only, 60-second max duration`);
    } else {
      logger.info(`🎬 STANDARD MODE: Will process all qualities, full video length`);
    }
    
    try {
      // Create work and outputs directories
      await fs.mkdir(workDir, { recursive: true });
      await fs.mkdir(outputsDir, { recursive: true });
      
      // Download source video (temporary, will be deleted after encoding)
      const sourceFile = join(workDir, 'source.mp4');
      logger.info(`📥 Downloading source video for job ${jobId}`);
      await this.downloadVideo(job.input.uri, sourceFile);
      
      // 🔍 NEW: Probe input file to detect format and compatibility issues
      logger.info(`🔍 Probing input file for compatibility...`);
      let probeResult: FileProbeResult | null = null;
      let encodingStrategy: EncodingStrategy | null = null;
      
      try {
        probeResult = await this.probeInputFile(sourceFile);
        encodingStrategy = this.determineEncodingStrategy(probeResult);
        
        logger.info(`✅ Probe complete - Strategy: ${encodingStrategy.reason}`);
        
        if (probeResult.issues.length > 0) {
          logger.info(`🛠️ Will apply ${probeResult.issues.length} compatibility fix(es)`);
        }
      } catch (probeError) {
        logger.warn(`⚠️ File probe failed, will use standard encoding:`, probeError);
        // Continue with standard encoding if probe fails
      }
      
      // Process each quality profile OR use passthrough mode
      const outputs: EncodedOutput[] = [];
      
      // Check if we should use passthrough mode for ultra-compressed content
      const isPassthrough = encodingStrategy?.codecPriority.includes('copy') || false;
      
      if (isPassthrough) {
        // Passthrough mode: Single HLS output with copy codecs
        logger.info(`🔄 Processing with passthrough mode (no re-encoding)`);
        if (isShortVideo) {
          logger.info(`📱 Passthrough mode + SHORT VIDEO: Will trim to 60 seconds`);
        }
        
        const passthroughOutput = await this.createPassthroughHLS(
          sourceFile,
          outputsDir,
          (progress) => {
            if (progressCallback) {
              progressCallback({
                jobId,
                profile: 'passthrough',
                percent: progress.percent || 0,
                fps: progress.fps || 0,
                bitrate: `${progress.bitrate || 0}kbps`
              });
            }
          },
          isShortVideo // 📱 Pass short flag to passthrough mode
        );
        
        outputs.push(passthroughOutput);
      } else {
        // 📱 Short video mode: 480p only
        // 🎬 Standard mode: All qualities
        const profiles = isShortVideo 
          ? [{ name: '480p', height: 480 }]
          : [
              { name: '1080p', height: 1080 },
              { name: '720p', height: 720 },
              { name: '480p', height: 480 }
            ];

      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i]!;
        logger.info(`🎬 Processing ${profile.name} for job ${jobId}`);
        
        const output = await this.encodeProfile(
          sourceFile,
          profile,
          outputsDir, // Encode directly to outputs directory
          (progress) => {
            if (progressCallback) {
              const totalProgress = ((i / profiles.length) + (progress / 100 / profiles.length)) * 100;
              progressCallback({
                jobId,
                profile: profile.name,
                percent: totalProgress
              });
            }
          },
          encodingStrategy, // Pass the encoding strategy
          isShortVideo // 📱 Pass short video flag
        );
        
        outputs.push(output);
      }
      
      logger.info(`🎉 All profiles completed for job ${jobId}`);
      } // End of else block for standard encoding
      
      // 🗑️ Delete source file immediately after encoding (no longer needed)
      try {
        await fs.unlink(sourceFile);
        logger.info(`🗑️ Source file deleted: ${sourceFile}`);
      } catch (error) {
        logger.warn(`⚠️ Failed to delete source file:`, error);
      }
      
      // Create master playlist (manifest.m3u8) that references all profiles
      await this.createMasterPlaylist(outputs, outputsDir);
      
      // Upload ONLY the encoded outputs directory to IPFS (no source file!)
      logger.info(`📤 Uploading encoded outputs to IPFS for job ${jobId} (source file excluded)`);
      
      // Calculate actual directory stats before upload
      const fs = await import('fs/promises');
      const path = await import('path');
      let outputFileCount = 0;
      let outputTotalSize = 0;
      
      try {
        const allFiles = await this.getAllFilesRecursive(outputsDir);
        outputFileCount = allFiles.length;
        for (const file of allFiles) {
          const stats = await fs.stat(file);
          outputTotalSize += stats.size;
        }
      } catch (sizeError) {
        logger.warn(`⚠️ Could not calculate output directory size: ${sizeError}`);
      }
      
      const outputSizeMB = (outputTotalSize / 1024 / 1024).toFixed(1);
      
      // 🚨 PINATA-STYLE: Upload and get CID immediately, handle pinning in background
      const ipfsHash = await this.ipfsService.uploadDirectory(outputsDir, false, onPinFailed);
      
      // 🎯 MANUAL COMPLETION: Log CID prominently for manual job finishing
      logger.info(`🎉 ═══════════════════════════════════════════════════════════════`);
      logger.info(`🎯 JOB ${jobId}: IPFS CID READY FOR MANUAL COMPLETION`);
      logger.info(`📱 CID: ${ipfsHash}`);
      logger.info(`🔗 Gateway: https://ipfs.3speak.tv/ipfs/${ipfsHash}/manifest.m3u8`);
      logger.info(`✅ Content Size: ${outputSizeMB}MB | Files: ${outputFileCount} | Status: UPLOADED`);
      logger.info(`🛠️ MANUAL FINISH: Use this CID to complete job if encoder gets stuck`);
      logger.info(`🎉 ═══════════════════════════════════════════════════════════════`);
      
      // 🔄 LAZY PINNING: Queue for background pinning (non-blocking)
      if (onPinFailed) {
        // Trigger background pinning by calling the callback with no error
        setTimeout(() => {
          logger.info(`🔄 Triggering lazy pinning for ${ipfsHash}`);
          // This will queue it for background pinning
          onPinFailed(ipfsHash, new Error('lazy_pin_requested'));
        }, 100);
      }
      
      // Create final outputs with master playlist
      const masterPlaylistUri = `ipfs://${ipfsHash}/manifest.m3u8`;
      const uploadedOutputs: EncodedOutput[] = [{
        profile: 'master',
        path: join(outputsDir, 'manifest.m3u8'),
        size: 0, // Will be calculated
        duration: 0,
        segments: [],
        playlist: join(outputsDir, 'manifest.m3u8'),
        ipfsHash: ipfsHash,
        uri: masterPlaylistUri
      }];
      
      logger.info(`✅ Complete HLS structure uploaded to IPFS: ${ipfsHash}`);
      logger.info(`🎬 Master playlist available at: ${masterPlaylistUri}`);
      
      return uploadedOutputs;
      
    } catch (error) {
      logger.error(`❌ Video processing failed for job ${jobId}:`, cleanErrorForLogging(error));
      throw error;
    } finally {
      // Cleanup work directory
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch (cleanupError) {
        logger.warn(`⚠️ Failed to cleanup ${workDir}:`, cleanupError);
      }
    }
  }

  private async downloadVideo(uri: string, outputPath: string): Promise<void> {
    logger.info(`📥 Downloading video from: ${uri}`);
    
    // Extract IPFS hash if it's an IPFS URL
    const ipfsMatch = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
    const ipfsHash = ipfsMatch ? ipfsMatch[1] : null;
    
    if (ipfsHash) {
      // 🎯 SMART TWO-TIER FALLBACK for IPFS content
      
      // Tier 1: Try 3Speak gateway first (direct access to their infrastructure)
      try {
        logger.info('🎯 Trying 3Speak IPFS gateway (direct access)');
        await this.downloadFromGateway('https://ipfs.3speak.tv', ipfsHash, outputPath);
        logger.info('✅ Successfully downloaded via 3Speak gateway');
        return;
      } catch (error: any) {
        logger.warn(`⚠️ 3Speak gateway failed: ${error.message}`, cleanErrorForLogging(error));
        logger.info('🔍 Falling back to local IPFS daemon (P2P network)');
      }
      
      // Tier 2: Fallback to local IPFS daemon (P2P network discovery)
      try {
        await this.downloadFromLocalIPFS(ipfsHash, outputPath);
        logger.info('✅ Successfully downloaded via local IPFS daemon');
        return;
      } catch (error: any) {
        logger.error(`❌ Local IPFS daemon failed: ${error.message}`, cleanErrorForLogging(error));
        throw new Error(`Both 3Speak gateway and local IPFS failed. Gateway: ${error.message}`);
      }
      
    } else if (uri.startsWith('file://')) {
      // Handle local file:// URLs by copying the file directly
      await this.copyLocalFile(uri, outputPath);
    } else {
      // For regular HTTP/HTTPS URLs, use HTTP download
      await this.downloadFromHTTP(uri, outputPath);
    }
  }
  
  /**
   * Download from 3Speak IPFS gateway (Tier 1 - Direct Access)
   */
  private async downloadFromGateway(gateway: string, ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    const gatewayUrl = `${gateway}/ipfs/${ipfsHash}`;
    
    logger.info(`⏱️ Gateway timeout: 90 seconds (should be fast for direct access)`);
    
    const response = await axios.default.get(gatewayUrl, {
      responseType: 'stream',
      timeout: 90000, // 1.5 minutes - gateway should be fast
      maxRedirects: 5,
      headers: {
        'User-Agent': '3SpeakEncoder/1.0'
      }
    });
    
    await this.streamToFileWithProgress(response.data, outputPath, `gateway ${gateway}`, response.headers['content-length']);
  }
  
  /**
   * Download from local IPFS daemon (Tier 2 - P2P Network)
   */
  private async downloadFromLocalIPFS(ipfsHash: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    
    logger.info(`⏱️ Local IPFS timeout: 5 minutes (P2P discovery can take time)`);
    logger.info(`🔍 Starting P2P discovery and download for ${ipfsHash}...`);
    
    const response = await axios.default.post(
      `http://127.0.0.1:5001/api/v0/cat?arg=${ipfsHash}`,
      null,
      {
        responseType: 'stream',
        timeout: 300000, // 5 minutes - P2P discovery can take time
        maxRedirects: 0
      }
    );
    
    await this.streamToFileWithProgress(response.data, outputPath, 'local IPFS daemon (P2P)');
  }
  
  /**
   * Download from regular HTTP URL
   */
  private async downloadFromHTTP(uri: string, outputPath: string): Promise<void> {
    const axios = await import('axios');
    
    const response = await axios.default.get(uri, {
      responseType: 'stream',
      timeout: 120000, // 2 minutes for regular HTTP
      maxRedirects: 5,
      headers: {
        'User-Agent': '3SpeakEncoder/1.0'
      }
    });
    
    await this.streamToFileWithProgress(response.data, outputPath, `HTTP ${uri}`, response.headers['content-length']);
  }
  
  /**
   * Copy local file:// URL to output path
   */
  private async copyLocalFile(fileUri: string, outputPath: string): Promise<void> {
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');
    
    // Convert file:// URL to local path
    const localPath = fileUri.replace('file://', '');
    
    logger.info(`📁 Copying local file: ${localPath} -> ${outputPath}`);
    
    try {
      // Check if source file exists
      const stats = await fs.stat(localPath);
      const fileSizeMB = (stats.size / 1024 / 1024).toFixed(1);
      
      logger.info(`📊 Local file size: ${fileSizeMB}MB`);
      
      // Update dashboard - starting local file copy
      if (this.dashboard && this.currentJobId) {
        this.dashboard.updateJobProgress(this.currentJobId, 10, 'copying-local-file', {
          fileSizeMB: fileSizeMB,
          source: 'local file'
        });
      }
      
      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });
      
      // Copy the file
      await fs.copyFile(localPath, outputPath);
      
      logger.info(`✅ Successfully copied local file: ${fileSizeMB}MB`);
      
      // Update dashboard - local file copy complete
      if (this.dashboard && this.currentJobId) {
        this.dashboard.updateJobProgress(this.currentJobId, 25, 'local-file-copied', {
          fileSizeMB: fileSizeMB,
          source: 'local file'
        });
      }
      
    } catch (error: any) {
      logger.error(`❌ Failed to copy local file: ${error.message}`);
      throw new Error(`Failed to copy local file from ${localPath}: ${error.message}`);
    }
  }
  
  /**
   * 🚨 MEMORY SAFE: Stream data to file with progress tracking
   */
  private async streamToFileWithProgress(dataStream: any, outputPath: string, source: string, contentLength?: string): Promise<void> {
    const writer = createWriteStream(outputPath);
    dataStream.pipe(writer);
    
    let downloadedBytes = 0;
    const totalBytes = contentLength ? parseInt(contentLength) : null;
    let lastProgressTime = Date.now();
    
    // Progress tracking
    dataStream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      const now = Date.now();
      
      // Log progress every 10 seconds or every 25MB
      if (now - lastProgressTime > 10000 || downloadedBytes % (25 * 1024 * 1024) < chunk.length) {
        if (totalBytes) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          const mbDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          const mbTotal = (totalBytes / 1024 / 1024).toFixed(1);
          logger.info(`📥 Download progress: ${percent}% (${mbDownloaded}MB / ${mbTotal}MB) from ${source}`);
          
          // 📊 Update dashboard with download progress (5-25% range for download phase)
          if (this.dashboard && this.currentJobId) {
            const dashboardProgress = 5 + Math.round(percent * 0.2); // Scale to 5-25% of total job
            this.dashboard.updateJobProgress(this.currentJobId, dashboardProgress, `downloading-${source.includes('gateway') ? 'gateway' : source.includes('IPFS') ? 'ipfs' : 'http'}`, {
              downloadPercent: percent,
              downloadedMB: mbDownloaded,
              totalMB: mbTotal,
              source: source
            });
          }
        } else {
          const mbDownloaded = (downloadedBytes / 1024 / 1024).toFixed(1);
          logger.info(`📥 Downloaded: ${mbDownloaded}MB from ${source} (size unknown)`);
          
          // 📊 Update dashboard with unknown size progress
          if (this.dashboard && this.currentJobId) {
            const estimatedProgress = Math.min(25, 5 + Math.floor(downloadedBytes / (50 * 1024 * 1024))); // Rough estimate
            this.dashboard.updateJobProgress(this.currentJobId, estimatedProgress, `downloading-${source.includes('gateway') ? 'gateway' : source.includes('IPFS') ? 'ipfs' : 'http'}`, {
              downloadedMB: mbDownloaded,
              source: source
            });
          }
        }
        lastProgressTime = now;
      }
    });
    
    return new Promise<void>((resolve, reject) => {
      // 🚨 MEMORY SAFE: Ensure streams are destroyed on completion/error
      const cleanup = () => {
        try {
          if (!dataStream.destroyed) dataStream.destroy();
          if (!writer.destroyed) writer.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      };
      
      writer.on('finish', () => {
        const finalMB = (downloadedBytes / 1024 / 1024).toFixed(1);
        logger.info(`✅ Successfully downloaded ${finalMB}MB from ${source}`);
        
        // 📊 Update dashboard - download complete (25% of total job)
        if (this.dashboard && this.currentJobId) {
          this.dashboard.updateJobProgress(this.currentJobId, 25, 'download-complete', {
            downloadedMB: finalMB,
            source: source
          });
        }
        
        cleanup();
        resolve();
      });
      
      writer.on('error', (err: any) => {
        cleanup();
        reject(err);
      });
      
      dataStream.on('error', (err: any) => {
        cleanup();
        reject(err);
      });
      
      // 🚨 CRITICAL: Handle aborted streams explicitly
      dataStream.on('aborted', () => {
        cleanup();
        reject(new Error('Download stream was aborted'));
      });
    });
  }

  private async createPassthroughHLS(
    sourceFile: string,
    outputsDir: string,
    progressCallback: (progress: { percent?: number; fps?: number; speed?: number; bitrate?: number }) => void,
    isShortVideo?: boolean // 📱 Short video flag
  ): Promise<EncodedOutput> {
    const fs = await import('fs/promises');
    
    // Create proper directory structure like normal jobs
    const qualityDir = join(outputsDir, '480p'); // Use 480p as default for ultra-compressed
    await fs.mkdir(qualityDir, { recursive: true });
    
    const qualityPlaylist = join(qualityDir, 'index.m3u8');
    const masterManifest = join(outputsDir, 'manifest.m3u8');
    
    // Calculate adaptive segment duration to prevent IPFS disasters
    const segmentDuration = await this.calculateAdaptiveSegmentDuration(sourceFile);
    
    return new Promise((resolve, reject) => {
      let command = ffmpeg(sourceFile)
        .addOption('-c:v', 'copy')     // Copy video without re-encoding
        .addOption('-c:a', 'copy')     // Copy audio without re-encoding
        .addOption('-avoid_negative_ts', 'make_zero')
        .addOption('-copyts');
      
      // 📱 SHORT VIDEO MODE: Trim to 60 seconds in passthrough mode
      if (isShortVideo) {
        logger.info(`📱 Applying 60-second trim in passthrough mode`);
        command = command.addOption('-t', '60'); // Trim to first 60 seconds
      }
      
      command = command
        .addOption('-f', 'hls')        // HLS output format
        .addOption('-hls_time', segmentDuration.toString()) // Adaptive segment duration
        .addOption('-hls_list_size', '0')  // Keep all segments in playlist
        .addOption('-hls_segment_filename', join(qualityDir, '480p_%d.ts')) // Proper naming
        .output(qualityPlaylist);

      let lastPercent = 0;

      command.on('progress', (progress) => {
        const percent = Math.min(100, Math.max(0, progress.percent || 0));
        if (percent > lastPercent) {
          lastPercent = percent;
          progressCallback({
            percent,
            fps: progress.currentFps || 0,
            speed: parseFloat(String(progress.currentKbps || 0)) / 1000,
            bitrate: parseFloat(String(progress.currentKbps || 0))
          });
        }
      });

      command.on('error', (error) => {
        logger.error('❌ Passthrough HLS encoding failed:', error);
        reject(error);
      });

      command.on('end', async () => {
        try {
          // Get stats of the original file for metadata
          const stats = await fs.stat(sourceFile);
          
          // Collect generated HLS segments from quality directory
          const segmentFiles = await fs.readdir(qualityDir);
          const segments = segmentFiles
            .filter(file => file.startsWith('480p_') && file.endsWith('.ts'))
            .map(file => join(qualityDir, file));
          
          logger.info(`✅ Passthrough HLS complete: ${segments.length} segments generated`);
          
          // Generate master manifest that points to the single quality
          await this.generateMasterManifest(masterManifest, '480p');
          
          resolve({
            profile: '480p',
            path: masterManifest,
            size: stats.size, // Use original file size as reference
            duration: 0, // Will be detected by player
            segments: segments,
            playlist: masterManifest
          });
        } catch (error) {
          reject(error);
        }
      });

      command.run();
    });
  }

  /**
   * 🛡️ IPFS PROTECTION: Calculate adaptive segment duration to prevent upload disasters
   */
  private async calculateAdaptiveSegmentDuration(sourceFile: string): Promise<number> {
    try {
      const ffprobe = await import('fluent-ffmpeg');
      
      return new Promise((resolve, reject) => {
        ffprobe.default.ffprobe(sourceFile, (err, metadata) => {
          if (err) {
            logger.warn('⚠️ Could not probe for adaptive segments, using 6s default:', err);
            resolve(6);
            return;
          }
          
          const duration = metadata.format.duration || 0;
          const durationHours = duration / 3600;
          
          // 🛡️ ADAPTIVE SEGMENT PROTECTION: Prevent IPFS upload disasters
          let segmentDuration: number;
          let maxSegments: number;
          let reasoning: string;
          
          if (durationHours <= 1) {
            // Short videos: 6s segments (up to 600 segments for 1h)
            segmentDuration = 6;
            maxSegments = Math.ceil(duration / 6);
            reasoning = 'short video (<1h)';
          } else if (durationHours <= 4) {
            // Medium videos: 15s segments (up to 960 segments for 4h)
            segmentDuration = 15;
            maxSegments = Math.ceil(duration / 15);
            reasoning = 'medium video (1-4h)';
          } else if (durationHours <= 12) {
            // Long videos: 30s segments (up to 1440 segments for 12h)
            segmentDuration = 30;
            maxSegments = Math.ceil(duration / 30);
            reasoning = 'long video (4-12h)';
          } else {
            // Ultra-long videos: 60s segments (max 1440 segments for 24h)
            segmentDuration = 60;
            maxSegments = Math.ceil(duration / 60);
            reasoning = 'ultra-long video (>12h)';
          }
          
          // 🚨 HARD LIMIT: Never exceed 2000 segments (IPFS upload limit)
          const HARD_SEGMENT_LIMIT = 2000;
          if (maxSegments > HARD_SEGMENT_LIMIT) {
            segmentDuration = Math.ceil(duration / HARD_SEGMENT_LIMIT);
            maxSegments = HARD_SEGMENT_LIMIT;
            reasoning = `IPFS-limited (${segmentDuration}s segments to stay under ${HARD_SEGMENT_LIMIT} limit)`;
          }
          
          logger.info(`🛡️ Adaptive segments for ${durationHours.toFixed(1)}h video: ${segmentDuration}s segments (≈${maxSegments} total) - ${reasoning}`);
          
          // 🚨 WARNING for extreme cases
          if (maxSegments > 1500) {
            logger.warn(`⚠️ HIGH SEGMENT COUNT: ${maxSegments} segments may stress IPFS uploads`);
          }
          
          resolve(segmentDuration);
        });
      });
    } catch (error) {
      logger.warn('⚠️ Error calculating adaptive segments, using 6s default:', error);
      return 6;
    }
  }

  /**
   * Generate master manifest that points to single quality folder
   */
  private async generateMasterManifest(manifestPath: string, quality: string): Promise<void> {
    const fs = await import('fs/promises');
    
    // Create HLS master playlist that references the single quality
    const masterContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="avc1.42e01e,mp4a.40.2"
${quality}/index.m3u8
`;
    
    await fs.writeFile(manifestPath, masterContent);
    logger.info(`✅ Generated master manifest: ${manifestPath}`);
  }

  private async encodeProfile(
    sourceFile: string,
    profile: { name: string; height: number },
    workDir: string,
    progressCallback?: (progress: number) => void,
    strategy?: EncodingStrategy | null,
    isShortVideo?: boolean // 📱 Short video flag
  ): Promise<EncodedOutput> {
    const profileDir = join(workDir, profile.name);
    await fs.mkdir(profileDir, { recursive: true });
    
    const outputPath = join(profileDir, 'index.m3u8');
    
    // 🛡️ Calculate adaptive segment duration for IPFS protection
    const segmentDuration = await this.calculateAdaptiveSegmentDuration(sourceFile);
    
    // 🔄 CASCADING FALLBACK SYSTEM: Try codecs in order of preference
    // 1. Tested hardware codecs (highest priority)
    // 2. Untested hardware codecs (medium priority) 
    // 3. Software codecs (bulletproof fallback)
    
    const testedHardware = this.availableCodecs.filter(c => c.type === 'hardware' && c.tested);
    const untestedHardware = this.availableCodecs.filter(c => c.type === 'hardware' && !c.tested);
    const softwareCodecs = this.availableCodecs.filter(c => c.type === 'software');
    
    const fallbackChain = [...testedHardware, ...untestedHardware, ...softwareCodecs];
    
    if (fallbackChain.length === 0) {
      throw new Error('No codecs available for encoding - this should never happen');
    }
    
    let lastError: Error | null = null;
    
    // Try each codec in the fallback chain
    for (let i = 0; i < fallbackChain.length; i++) {
      const codec = fallbackChain[i];
      if (!codec) {
        logger.error(`❌ Codec at index ${i} is undefined - skipping`);
        continue;
      }
      
      const isLastAttempt = i === fallbackChain.length - 1;
      const isHardware = codec.type === 'hardware';
      
      try {
        logger.info(`🎯 Attempting ${profile.name} encoding with ${codec.name} (${codec.type})`);
        logger.info(`   📍 Fallback position ${i + 1}/${fallbackChain.length}`);
        
        // 🚨 ADAPTIVE TIMEOUT: Calculate timeout based on video characteristics
        const adaptiveTimeout = this.calculateAdaptiveTimeout(sourceFile, codec, strategy);
        
        const result = await this.attemptEncode(
          sourceFile,
          profile,
          profileDir,
          outputPath,
          codec,
          adaptiveTimeout,
          progressCallback,
          strategy, // Pass the encoding strategy
          segmentDuration, // Pass adaptive segment duration
          isShortVideo // 📱 Pass short video flag
        );
        
        logger.info(`✅ ${profile.name} encoding SUCCESS with ${codec.name}`);
        return result;
        
      } catch (error) {
        lastError = error as Error;
        const errorMsg = cleanErrorForLogging(error);
        
        if (isLastAttempt) {
          // Final fallback failed - this is catastrophic
          logger.error(`💥 FINAL FALLBACK FAILED: ${profile.name} encoding failed with ${codec.name}`);
          logger.error(`   🚨 All ${fallbackChain.length} codecs exhausted`);
          logger.error(`   ❌ Error: ${errorMsg}`);
          break;
        } else {
          // Log failure and continue to next codec
          logger.warn(`⚠️ ${codec.name} failed for ${profile.name}, falling back...`);
          logger.warn(`   📊 Failed codec: ${codec.name} (${codec.type})`);
          const nextCodec = fallbackChain[i + 1];
          if (nextCodec) {
            logger.warn(`   🔄 Next fallback: ${nextCodec.name} (${nextCodec.type})`);
          }
          logger.warn(`   ❌ Error: ${errorMsg}`);
        }
      }
    }
    
    // If we get here, all codecs failed
    throw new Error(`All encoding attempts failed for ${profile.name}. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  private async attemptEncode(
    sourceFile: string,
    profile: { name: string; height: number },
    profileDir: string,
    outputPath: string,
    codec: { name: string; type: string },
    timeoutMs: number,
    progressCallback?: (progress: number) => void,
    strategy?: EncodingStrategy | null,
    segmentDuration?: number,
    isShortVideo?: boolean // 📱 Short video flag
  ): Promise<EncodedOutput> {
    return new Promise((resolve, reject) => {
      // Get profile-specific settings matching Eddie's script
      const profileSettings = this.getProfileSettings(profile.name);
      
      // 🚀 Configure encoding based on codec type
      let command = ffmpeg(sourceFile);
      
      // 🎯 Apply input options from strategy (if available)
      if (strategy?.inputOptions && strategy.inputOptions.length > 0) {
        logger.debug(`🛠️ Applying strategy input options: ${strategy.inputOptions.join(' ')}`);
        strategy.inputOptions.forEach(opt => command = command.inputOptions(opt));
      }
      
      // 📱 SHORT VIDEO MODE: Limit to 60 seconds (must be output option, not input)
      if (isShortVideo) {
        logger.info(`📱 Applying 60-second trim for short video`);
        command = command.outputOptions('-t', '60'); // Trim to first 60 seconds
      }
      
      if (codec.name === 'h264_vaapi') {
        // AMD/Intel VAAPI - Full hardware pipeline
        command = command
          .addInputOptions('-hwaccel', 'vaapi')
          .addInputOptions('-vaapi_device', '/dev/dri/renderD128')  
          .addInputOptions('-hwaccel_output_format', 'vaapi')
          .videoCodec(codec.name)
          .addOption('-vf', `scale_vaapi=-2:${profile.height}:format=nv12`)
          .addOption('-qp', '19')
          .addOption('-bf', '2');
      } else if (codec.name === 'h264_nvenc') {
        // NVIDIA NVENC - Full hardware pipeline  
        command = command
          .addInputOptions('-hwaccel', 'cuda')
          .addInputOptions('-hwaccel_output_format', 'cuda')
          .videoCodec(codec.name)
          .addOption('-vf', `scale_cuda=-2:${profile.height}`)
          .addOption('-preset', 'medium')
          .addOption('-cq', '19')
          .addOption('-b:v', profileSettings.bitrate)
          .addOption('-maxrate', profileSettings.maxrate)
          .addOption('-bufsize', profileSettings.bufsize);
      } else if (codec.name === 'h264_qsv') {
        // Intel QuickSync - Full hardware pipeline
        command = command
          .addInputOptions('-hwaccel', 'qsv')
          .addInputOptions('-hwaccel_output_format', 'qsv')
          .videoCodec(codec.name)
          .addOption('-vf', `scale_qsv=-2:${profile.height}`)
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
          .addOption('-crf', '19')
          .addOption('-vf', `scale=-2:${profile.height},fps=30`)
          .addOption('-b:v', profileSettings.bitrate)
          .addOption('-maxrate', profileSettings.maxrate)
          .addOption('-bufsize', profileSettings.bufsize);
      }
      
      // 🎯 Apply video filters from strategy (pixel format conversion, etc.)
      if (strategy?.videoFilters && strategy.videoFilters.length > 0) {
        const existingFilters = codec.name === 'libx264' ? `scale=-2:${profile.height},fps=30` : '';
        const strategyFiltersStr = strategy.videoFilters.join(',');
        
        // Combine strategy filters with existing filters
        if (existingFilters && !existingFilters.includes(strategyFiltersStr)) {
          command = command.addOption('-vf', `${strategyFiltersStr},${existingFilters}`);
          logger.debug(`🛠️ Applied combined video filters: ${strategyFiltersStr},${existingFilters}`);
        } else if (!existingFilters) {
          command = command.addOption('-vf', strategyFiltersStr);
          logger.debug(`🛠️ Applied strategy video filters: ${strategyFiltersStr}`);
        }
      }
      
      // 🎯 Apply stream mapping from strategy (for iPhone .mov files with extra streams)
      if (strategy?.mapOptions && strategy.mapOptions.length > 0) {
        logger.debug(`🛠️ Applying stream mapping: ${strategy.mapOptions.join(' ')}`);
        strategy.mapOptions.forEach(opt => command = command.outputOptions(opt));
      }
      
      // 🎯 Apply extra options from strategy (e.g., -movflags +faststart)
      if (strategy?.extraOptions && strategy.extraOptions.length > 0) {
        logger.debug(`🛠️ Applying extra options: ${strategy.extraOptions.join(' ')}`);
        strategy.extraOptions.forEach(opt => command = command.outputOptions(opt));
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
          logger.debug(`🎬 FFmpeg command: ${commandLine}`);
        })
        .on('progress', (progress) => {
          if (progressCallback && progress.percent) {
            progressCallback(progress.percent);
          }
        })
        .on('end', async () => {
          try {
            clearTimeout(timeoutId);
            
            // Count segments and get file info
            const files = await fs.readdir(profileDir);
            const segmentFiles = files.filter(f => f.endsWith('.ts'));
            const stats = await fs.stat(outputPath);
            
            resolve({
              profile: profile.name,
              path: outputPath,
              size: stats.size,
              duration: 0, // TODO: Get actual duration
              segments: segmentFiles,
              playlist: outputPath
            });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          clearTimeout(timeoutId);
          // Kill FFmpeg process to prevent memory leak
          try {
            command.kill('SIGKILL');
          } catch (e) {
            // Ignore kill errors
          }
          reject(error);
        });

      // Set timeout based on codec type (shorter for hardware, longer for software)
      const timeoutId = setTimeout(() => {
        logger.warn(`⏰ ${codec.name} timeout (${timeoutMs/1000}s) for ${profile.name}, killing process...`);
        try {
          command.kill('SIGKILL');
        } catch (e) {
          // Ignore kill errors
        }
        reject(new Error(`${codec.name} encoding timeout for ${profile.name} (${timeoutMs/1000}s)`));
      }, timeoutMs);

      // Start encoding
      command.run();
    });
  }

  getBestCodec(): string {
    return this.availableCodecs[0]?.name || 'libx264';
  }

  private getProfileSettings(profileName: string) {
    // Eddie's exact settings for each profile
    const settings = {
      '1080p': {
        profile: 'high',
        level: '4.1',
        bitrate: '5000k',
        maxrate: '5350k',
        bufsize: '7500k',
        audioBitrate: '128k'
      },
      '720p': {
        profile: 'high', 
        level: '4.0',
        bitrate: '2800k',
        maxrate: '2996k',
        bufsize: '4200k',
        audioBitrate: '128k'
      },
      '480p': {
        profile: 'main',
        level: '3.1', 
        bitrate: '1400k',
        maxrate: '1498k',
        bufsize: '2100k',
        audioBitrate: '96k'
      }
    };
    
    return settings[profileName as keyof typeof settings] || settings['480p'];
  }

  getAvailableCodecs(): CodecCapability[] {
    return [...this.availableCodecs];
  }

  private async createMasterPlaylist(outputs: EncodedOutput[], workDir: string): Promise<void> {
    logger.info('📝 Creating master playlist (manifest.m3u8)');
    
    // Define profile specifications matching Eddie's script
    const profileSpecs = [
      { name: '1080p', bandwidth: 6500000, resolution: '1920x1080', codecs: 'avc1.640028,mp4a.40.2' },
      { name: '720p', bandwidth: 3500000, resolution: '1280x720', codecs: 'avc1.64001F,mp4a.40.2' },
      { name: '480p', bandwidth: 1800000, resolution: '854x480', codecs: 'avc1.4D401F,mp4a.40.2' }
    ];
    
    let masterPlaylist = '#EXTM3U\n';
    masterPlaylist += '#EXT-X-VERSION:3\n';
    
    // Add each profile to master playlist
    for (const spec of profileSpecs) {
      const output = outputs.find(o => o.profile === spec.name);
      if (output) {
        masterPlaylist += `#EXT-X-STREAM-INF:BANDWIDTH=${spec.bandwidth},RESOLUTION=${spec.resolution},CODECS="${spec.codecs}"\n`;
        masterPlaylist += `${spec.name}/index.m3u8\n`;
      }
    }
    
    // Write master playlist to work directory
    const masterPlaylistPath = join(workDir, 'manifest.m3u8');
    await fs.writeFile(masterPlaylistPath, masterPlaylist);
    
    logger.info(`✅ Master playlist created: manifest.m3u8`);
  }


}