/**
 * 🔧 Hardware Detection & Caching Service
 * 
 * Detects available hardware acceleration capabilities and caches results
 * to avoid expensive re-detection on every startup.
 * 
 * Features:
 * - One-time hardware detection (cached to disk)
 * - VAAPI, NVENC, QSV support detection
 * - Codec availability testing
 * - Smart cache invalidation (FFmpeg version changes)
 * - Manual re-detection via force flag
 */

import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from './Logger.js';
import { CodecCapability } from '../types/index.js';
import { randomUUID } from 'crypto';

interface HardwareCapabilities {
  vaapi: boolean;
  nvenc: boolean;
  qsv: boolean;
  renderGroup: boolean;
  videoGroup: boolean;
}

interface CachedHardwareConfig {
  version: string;           // Cache format version
  ffmpegVersion: string;      // FFmpeg version used for detection
  timestamp: number;          // When detection was performed
  capabilities: HardwareCapabilities;
  codecs: CodecCapability[];
}

const CACHE_VERSION = '1.0.0';
const CACHE_FILENAME = '.hardware-cache.json';

export class HardwareDetector {
  private tempDir: string;
  private cacheFilePath: string;
  private ffmpegVersion: string = 'unknown';

  constructor(tempDir: string) {
    this.tempDir = tempDir;
    this.cacheFilePath = join(tempDir, CACHE_FILENAME);
  }

  /**
   * Get hardware configuration (from cache or fresh detection)
   */
  async getHardwareConfig(forceDetection: boolean = false): Promise<CachedHardwareConfig> {
    // Try to load from cache first (unless forced)
    if (!forceDetection) {
      const cached = await this.loadCache();
      if (cached && this.isCacheValid(cached)) {
        logger.info('✅ Using cached hardware configuration');
        logger.info(`   Detected: ${new Date(cached.timestamp).toLocaleString()}`);
        logger.info(`   FFmpeg: ${cached.ffmpegVersion}`);
        logger.info(`   Codecs: ${cached.codecs.filter(c => c.available && c.tested).length} available`);
        return cached;
      } else if (cached) {
        logger.info('🔄 Hardware cache invalid or outdated, re-detecting...');
      }
    } else {
      logger.info('🔄 Force detection requested, ignoring cache...');
    }

    // Perform fresh detection
    logger.info('🔍 Detecting hardware capabilities...');
    const config = await this.detectHardware();
    
    // Save to cache
    await this.saveCache(config);
    logger.info('💾 Hardware configuration cached');

    return config;
  }

  /**
   * Check if cached config is still valid
   */
  private isCacheValid(cached: CachedHardwareConfig): boolean {
    // Check version compatibility
    if (cached.version !== CACHE_VERSION) {
      logger.debug('Cache version mismatch');
      return false;
    }

    // Check if FFmpeg version changed (would invalidate codec availability)
    if (this.ffmpegVersion !== 'unknown' && cached.ffmpegVersion !== this.ffmpegVersion) {
      logger.debug('FFmpeg version changed');
      return false;
    }

    // Cache is valid for 30 days
    const age = Date.now() - cached.timestamp;
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
    if (age > maxAge) {
      logger.debug('Cache expired (> 30 days)');
      return false;
    }

    return true;
  }

  /**
   * Load cached hardware configuration
   */
  private async loadCache(): Promise<CachedHardwareConfig | null> {
    try {
      const data = await fs.readFile(this.cacheFilePath, 'utf8');
      const config = JSON.parse(data) as CachedHardwareConfig;
      
      // Validate cache structure
      if (!config.version || !config.ffmpegVersion || !config.timestamp) {
        logger.warn('Invalid cache structure (missing required fields), will re-detect');
        return null;
      }
      
      if (!config.capabilities || typeof config.capabilities !== 'object') {
        logger.warn('Invalid cache structure (missing capabilities), will re-detect');
        return null;
      }
      
      if (!Array.isArray(config.codecs)) {
        logger.warn('Invalid cache structure (codecs not an array), will re-detect');
        return null;
      }
      
      return config;
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.debug('Failed to load hardware cache:', error);
      }
      return null;
    }
  }

  /**
   * Save hardware configuration to cache
   */
  private async saveCache(config: CachedHardwareConfig): Promise<void> {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
      await fs.writeFile(
        this.cacheFilePath,
        JSON.stringify(config, null, 2),
        'utf8'
      );
    } catch (error) {
      logger.warn('Failed to save hardware cache:', error);
    }
  }

  /**
   * Invalidate cache (force re-detection on next run)
   */
  async invalidateCache(): Promise<void> {
    try {
      await fs.unlink(this.cacheFilePath);
      logger.info('🗑️ Hardware cache invalidated');
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        logger.warn('Failed to delete hardware cache:', error);
      }
    }
  }

  /**
   * Perform complete hardware detection
   */
  private async detectHardware(): Promise<CachedHardwareConfig> {
    // Get FFmpeg version first
    this.ffmpegVersion = await this.getFFmpegVersion();

    // Detect system capabilities
    const capabilities = await this.checkSystemCapabilities();

    // Detect available codecs
    const codecs = await this.detectCodecs(capabilities);

    return {
      version: CACHE_VERSION,
      ffmpegVersion: this.ffmpegVersion,
      timestamp: Date.now(),
      capabilities,
      codecs
    };
  }

  /**
   * Get FFmpeg version for cache validation
   */
  private async getFFmpegVersion(): Promise<string> {
    return new Promise((resolve) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          logger.warn('Could not determine FFmpeg version');
          resolve('unknown');
        } else {
          // Try to get version from ffmpeg command
          ffmpeg()
            .on('stderr', (line) => {
              const match = line.match(/ffmpeg version (\S+)/);
              if (match && match[1]) {
                resolve(match[1]);
              }
            })
            .on('error', () => resolve('unknown'))
            .on('end', () => resolve('unknown'))
            .input('dummy')
            .inputOptions(['-t', '0'])
            .output('/dev/null')
            .run();
        }
      });
    });
  }

  /**
   * Check system hardware capabilities
   */
  private async checkSystemCapabilities(): Promise<HardwareCapabilities> {
    const capabilities: HardwareCapabilities = {
      vaapi: false,
      nvenc: false,
      qsv: false,
      renderGroup: false,
      videoGroup: false
    };

    // Check for VAAPI support (AMD/Intel integrated graphics)
    try {
      await fs.access('/dev/dri/renderD128');
      capabilities.vaapi = true;
      logger.info('✅ VAAPI device found: /dev/dri/renderD128');
    } catch {
      logger.debug('ℹ️ VAAPI device not found');
    }

    // Check for NVIDIA GPU
    try {
      const { exec } = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        exec('nvidia-smi', (error) => {
          if (error) {
            reject();
          } else {
            capabilities.nvenc = true;
            logger.info('✅ NVIDIA GPU detected (nvidia-smi)');
            resolve();
          }
        });
      });
    } catch {
      logger.debug('ℹ️ NVIDIA GPU not detected');
    }

    // Check Intel QSV (usually present with VAAPI on Intel systems)
    // QSV detection is done via codec testing since it requires libmfx
    
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
        capabilities.renderGroup = true;
        logger.info('✅ User in "render" group - VAAPI access enabled');
      } else if (capabilities.vaapi) {
        logger.warn('⚠️ VAAPI device found but user not in "render" group');
        logger.warn('💡 Fix: sudo usermod -a -G render $USER (then logout/login)');
      }

      if (groups.includes('video')) {
        capabilities.videoGroup = true;
        logger.info('✅ User in "video" group - hardware access available');
      }
    } catch (error) {
      logger.debug('Could not check user groups:', error);
    }

    return capabilities;
  }

  /**
   * Detect available codecs and test hardware ones
   */
  private async detectCodecs(capabilities: HardwareCapabilities): Promise<CodecCapability[]> {
    const codecs: CodecCapability[] = [
      { name: 'libx264', type: 'software', available: false, tested: false, priority: 10 },
      { name: 'h264_qsv', type: 'hardware', available: false, tested: false, priority: 1 },
      { name: 'h264_nvenc', type: 'hardware', available: false, tested: false, priority: 2 },
      { name: 'h264_vaapi', type: 'hardware', available: false, tested: false, priority: 3 }
    ];

    // Get available encoders from FFmpeg
    const availableEncoders = await new Promise<any>((resolve, reject) => {
      ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) reject(err);
        else resolve(encoders);
      });
    });

    logger.info('🔍 Testing codec availability...');

    for (const codec of codecs) {
      if (availableEncoders[codec.name]) {
        codec.available = true;
        logger.info(`📋 ${codec.name} available in FFmpeg`);

        // Test hardware codecs to ensure they work
        if (codec.type === 'hardware') {
          // Skip testing if we know hardware isn't available
          if (codec.name === 'h264_nvenc' && !capabilities.nvenc) {
            logger.info(`⏭️ Skipping ${codec.name} test (no NVIDIA GPU)`);
            continue;
          }
          if (codec.name === 'h264_vaapi' && !capabilities.vaapi) {
            logger.info(`⏭️ Skipping ${codec.name} test (no VAAPI device)`);
            continue;
          }

          logger.info(`🧪 Testing ${codec.name}...`);
          codec.tested = await this.testCodec(codec.name);
        } else {
          codec.tested = true; // Software codecs assumed to work
        }
      } else {
        logger.debug(`❌ ${codec.name} not in FFmpeg build`);
      }
    }

    return codecs;
  }

  /**
   * Test if a codec actually works (not just available)
   */
  private async testCodec(codecName: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      const testFile = join(this.tempDir, `test-${codecName}-${randomUUID()}.mp4`);

      let command: any;

      // Use /dev/zero for fast, system-independent testing
      if (codecName === 'h264_vaapi') {
        // VAAPI requires hwaccel input options for proper GPU upload
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions([
            '-pix_fmt', 'yuv420p',
            '-s', '64x64',
            '-r', '1',
            '-hwaccel', 'vaapi',
            '-hwaccel_device', '/dev/dri/renderD128',
            '-hwaccel_output_format', 'vaapi'
          ])
          .videoCodec(codecName)
          .addOption('-b:v', '100k')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_nvenc') {
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'fast')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else if (codecName === 'h264_qsv') {
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1'])
          .videoCodec(codecName)
          .addOption('-preset', 'medium')
          .addOption('-frames:v', '1')
          .addOption('-f', 'mp4');
      } else {
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
        .on('end', async () => {
          try {
            await fs.unlink(testFile);
          } catch {
            // Ignore cleanup errors
          }
          logger.info(`✅ ${codecName} test passed`);
          resolve(true);
        })
        .on('error', (err: any) => {
          logger.warn(`❌ ${codecName} test failed: ${err.message}`);
          
          // Helpful troubleshooting hints
          if (codecName.includes('vaapi')) {
            logger.warn(`💡 Check: /dev/dri/renderD128 access and 'render' group`);
          } else if (codecName.includes('nvenc')) {
            logger.warn(`💡 Check: NVIDIA drivers and GPU availability`);
          } else if (codecName.includes('qsv')) {
            logger.warn(`💡 Check: Intel QSV drivers (libmfx)`);
          }

          resolve(false);
        });

      // Timeout for stuck tests
      const timeout = setTimeout(() => {
        try {
          command.kill('SIGKILL');
        } catch {
          // Ignore kill errors
        }
        logger.warn(`⏰ ${codecName} test timeout`);
        resolve(false);
      }, 5000);

      try {
        command.run();
      } catch (error) {
        clearTimeout(timeout);
        logger.warn(`❌ ${codecName} failed to start:`, error);
        resolve(false);
      }
    });
  }

  /**
   * Get available codecs in priority order
   */
  static buildCodecFallbackChain(config: CachedHardwareConfig): CodecCapability[] {
    const { codecs } = config;

    // Primary: tested and working codecs
    const testedCodecs = codecs
      .filter(c => c.available && c.tested)
      .sort((a, b) => a.priority - b.priority);

    // Fallback: available but untested hardware codecs
    const fallbackCodecs = codecs
      .filter(c => c.available && !c.tested && c.type === 'hardware')
      .sort((a, b) => a.priority - b.priority);

    // Final fallback: software codec
    const softwareFallback = codecs.find(c => c.name === 'libx264' && c.available);

    const chain = [...testedCodecs, ...fallbackCodecs];
    if (softwareFallback && !chain.find(c => c.name === 'libx264')) {
      chain.push(softwareFallback);
    }

    return chain;
  }

  /**
   * Log hardware configuration summary
   */
  static logConfigSummary(config: CachedHardwareConfig): void {
    const codecs = HardwareDetector.buildCodecFallbackChain(config);
    
    logger.info('🔍 Hardware Configuration Summary:');
    logger.info('═══════════════════════════════════════');

    // Capabilities
    logger.info('🖥️ System Capabilities:');
    logger.info(`  VAAPI: ${config.capabilities.vaapi ? '✅' : '❌'}`);
    logger.info(`  NVENC: ${config.capabilities.nvenc ? '✅' : '❌'}`);
    logger.info(`  Groups: ${[
      config.capabilities.renderGroup ? 'render' : null,
      config.capabilities.videoGroup ? 'video' : null
    ].filter(Boolean).join(', ') || 'none'}`);

    // Codec chain
    const testedHW = codecs.filter(c => c.type === 'hardware' && c.tested);
    const untestedHW = codecs.filter(c => c.type === 'hardware' && !c.tested);
    const software = codecs.filter(c => c.type === 'software');

    if (testedHW.length > 0) {
      logger.info('🚀 Primary Codecs (Hardware):');
      testedHW.forEach(c => logger.info(`  ✅ ${c.name} (priority ${c.priority})`));
    }

    if (untestedHW.length > 0) {
      logger.info('🔄 Fallback Codecs (Untested HW):');
      untestedHW.forEach(c => logger.info(`  🧪 ${c.name} (priority ${c.priority})`));
    }

    if (software.length > 0) {
      logger.info('🔄️ Final Fallback (Software):');
      software.forEach(c => logger.info(`  💻 ${c.name}`));
    }

    logger.info('═══════════════════════════════════════');

    const bestCodec = codecs[0];
    if (bestCodec) {
      if (bestCodec.type === 'hardware') {
        logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Hardware 🚀)`);
      } else {
        logger.info(`🎯 BEST CODEC: ${bestCodec.name} (Software)`);
      }
    }
  }
}
