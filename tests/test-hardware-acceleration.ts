/**
 * Hardware Acceleration Detection Test
 * 
 * This tool scans the system for available hardware acceleration capabilities
 * and provides the option to save the results to a configuration file.
 * 
 * Purpose: Run once during installation/setup instead of scanning on every job
 * 
 * Supported Hardware:
 * - Linux: NVIDIA NVENC, Intel QSV, AMD/Intel VAAPI
 * - Windows: NVIDIA NVENC, Intel QSV, AMD AMF
 * - macOS: VideoToolbox (Apple Silicon/Intel)
 */

import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform, tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as readline from 'readline';

const execAsync = promisify(exec);

interface HardwareCapability {
  name: string;
  type: 'hardware' | 'software';
  available: boolean;
  tested: boolean;
  priority: number;
  platform: string[];
  systemDetected?: boolean;
  testResult?: string;
}

interface HardwareConfig {
  platform: string;
  detectionDate: string;
  capabilities: HardwareCapability[];
  recommendedCodec: string;
  fallbackCodec: string;
}

class HardwareAccelerationTest {
  private tempDir: string;
  private capabilities: HardwareCapability[] = [];
  private isWindows: boolean;
  private isLinux: boolean;
  private isMacOS: boolean;

  constructor() {
    this.tempDir = join(tmpdir(), '3speak-hw-test-' + randomUUID());
    const currentPlatform = platform();
    this.isWindows = currentPlatform === 'win32';
    this.isLinux = currentPlatform === 'linux';
    this.isMacOS = currentPlatform === 'darwin';
  }

  async run(): Promise<void> {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║     3SPEAK ENCODER - HARDWARE ACCELERATION SCANNER         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`🖥️  Platform: ${this.getPlatformName()}`);
    console.log(`📁 Temp Directory: ${this.tempDir}\n`);

    try {
      // Create temp directory
      await fs.mkdir(this.tempDir, { recursive: true });

      // Step 1: Test FFmpeg availability
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📦 STEP 1: Testing FFmpeg Availability');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await this.testFFmpeg();

      // Step 2: Detect system hardware
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔍 STEP 2: Scanning System Hardware');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await this.detectSystemHardware();

      // Step 3: Check FFmpeg codec support
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📋 STEP 3: Checking FFmpeg Codec Support');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await this.detectFFmpegCodecs();

      // Step 4: Test hardware codecs
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🧪 STEP 4: Testing Hardware Codec Functionality');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      await this.testHardwareCodecs();

      // Display results
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📊 DETECTION RESULTS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      this.displayResults();

      // Offer to save configuration
      await this.offerSaveConfig();

    } catch (error) {
      console.error('❌ Test failed:', error);
      throw error;
    } finally {
      // Cleanup
      try {
        await fs.rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  private getPlatformName(): string {
    if (this.isWindows) return 'Windows';
    if (this.isLinux) return 'Linux';
    if (this.isMacOS) return 'macOS';
    return platform();
  }

  private async testFFmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg.getAvailableFormats((err, formats) => {
        if (err) {
          console.error('❌ FFmpeg not available:', err.message);
          reject(new Error('FFmpeg is not installed or not in PATH'));
        } else {
          console.log('✅ FFmpeg is available and working');
          console.log(`   Found ${Object.keys(formats).length} supported formats`);
          resolve();
        }
      });
    });
  }

  private async detectSystemHardware(): Promise<void> {
    if (this.isLinux) {
      await this.detectLinuxHardware();
    } else if (this.isWindows) {
      await this.detectWindowsHardware();
    } else if (this.isMacOS) {
      await this.detectMacOSHardware();
    }
  }

  private async detectLinuxHardware(): Promise<void> {
    console.log('🐧 Linux system detected\n');

    // Check for VAAPI devices
    try {
      await fs.access('/dev/dri/renderD128');
      console.log('✅ VAAPI device found: /dev/dri/renderD128');
      this.markSystemDetected('h264_vaapi');
    } catch {
      console.log('❌ VAAPI device not found (/dev/dri/renderD128)');
    }

    // Check for NVIDIA GPU
    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=name --format=csv,noheader');
      console.log(`✅ NVIDIA GPU detected: ${stdout.trim()}`);
      this.markSystemDetected('h264_nvenc');
    } catch {
      console.log('❌ NVIDIA GPU not detected (nvidia-smi not available)');
    }

    // Check Intel GPU
    try {
      const { stdout } = await execAsync('lspci | grep -i vga');
      if (stdout.toLowerCase().includes('intel')) {
        console.log('✅ Intel GPU detected');
        this.markSystemDetected('h264_qsv');
      }
    } catch {
      console.log('ℹ️  Could not detect Intel GPU');
    }

    // Check user groups
    try {
      const { stdout } = await execAsync('groups');
      const groups = stdout.trim();
      console.log(`\n👤 User groups: ${groups}`);
      
      if (groups.includes('render')) {
        console.log('✅ User is in "render" group - VAAPI should work');
      } else {
        console.log('⚠️  User not in "render" group - VAAPI may not work');
        console.log('   💡 Fix: sudo usermod -a -G render $USER (then logout/login)');
      }
      
      if (groups.includes('video')) {
        console.log('✅ User is in "video" group - hardware access available');
      }
    } catch {
      console.log('⚠️  Could not check user groups');
    }
  }

  private async detectWindowsHardware(): Promise<void> {
    console.log('🪟 Windows system detected\n');

    // Check for NVIDIA GPU using wmic
    try {
      const { stdout } = await execAsync('wmic path win32_VideoController get name');
      if (stdout.toLowerCase().includes('nvidia')) {
        console.log('✅ NVIDIA GPU detected');
        this.markSystemDetected('h264_nvenc');
      }
      if (stdout.toLowerCase().includes('intel')) {
        console.log('✅ Intel GPU detected');
        this.markSystemDetected('h264_qsv');
      }
      if (stdout.toLowerCase().includes('amd') || stdout.toLowerCase().includes('radeon')) {
        console.log('✅ AMD GPU detected');
        this.markSystemDetected('h264_amf');
      }
    } catch {
      // Try alternative method with PowerShell
      try {
        const { stdout } = await execAsync('powershell "Get-WmiObject Win32_VideoController | Select-Object Name"');
        console.log('🎮 Detected GPU(s):');
        console.log(stdout);
        
        const lowerOutput = stdout.toLowerCase();
        if (lowerOutput.includes('nvidia')) this.markSystemDetected('h264_nvenc');
        if (lowerOutput.includes('intel')) this.markSystemDetected('h264_qsv');
        if (lowerOutput.includes('amd') || lowerOutput.includes('radeon')) this.markSystemDetected('h264_amf');
      } catch {
        console.log('⚠️  Could not detect GPU information');
      }
    }
  }

  private async detectMacOSHardware(): Promise<void> {
    console.log('🍎 macOS system detected\n');

    try {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType');
      console.log('🎮 Graphics Information:');
      console.log(stdout.substring(0, 500)); // Show first 500 chars
      
      // VideoToolbox is available on all modern Macs
      console.log('\n✅ VideoToolbox should be available (native macOS acceleration)');
      this.markSystemDetected('h264_videotoolbox');
    } catch {
      console.log('⚠️  Could not detect GPU information');
    }
  }

  private markSystemDetected(codecName: string): void {
    const capability = this.capabilities.find(c => c.name === codecName);
    if (capability) {
      capability.systemDetected = true;
    }
  }

  private async detectFFmpegCodecs(): Promise<void> {
    // Define all possible codecs for each platform
    const codecDefinitions: HardwareCapability[] = [
      // Software (all platforms)
      { name: 'libx264', type: 'software', available: false, tested: false, priority: 10, platform: ['linux', 'win32', 'darwin'] },
      
      // Linux hardware
      { name: 'h264_vaapi', type: 'hardware', available: false, tested: false, priority: 3, platform: ['linux'] },
      { name: 'h264_nvenc', type: 'hardware', available: false, tested: false, priority: 1, platform: ['linux', 'win32'] },
      { name: 'h264_qsv', type: 'hardware', available: false, tested: false, priority: 2, platform: ['linux', 'win32'] },
      
      // Windows hardware
      { name: 'h264_amf', type: 'hardware', available: false, tested: false, priority: 2, platform: ['win32'] },
      
      // macOS hardware
      { name: 'h264_videotoolbox', type: 'hardware', available: false, tested: false, priority: 1, platform: ['darwin'] },
    ];

    // Filter codecs for current platform
    const currentPlatform = platform();
    this.capabilities = codecDefinitions.filter(c => c.platform.includes(currentPlatform));

    // Get available encoders from FFmpeg
    const availableEncoders = await new Promise<any>((resolve, reject) => {
      ffmpeg.getAvailableEncoders((err, encoders) => {
        if (err) reject(err);
        else resolve(encoders);
      });
    });

    console.log(`Found ${Object.keys(availableEncoders).length} total encoders in FFmpeg\n`);

    // Check which codecs are available
    for (const codec of this.capabilities) {
      if (availableEncoders[codec.name]) {
        codec.available = true;
        const systemMatch = codec.systemDetected ? ' (✅ System hardware detected)' : '';
        console.log(`✅ ${codec.name} - Available in FFmpeg${systemMatch}`);
      } else {
        console.log(`❌ ${codec.name} - Not available in FFmpeg build`);
      }
    }
  }

  private async testHardwareCodecs(): Promise<void> {
    const hardwareCodecs = this.capabilities.filter(c => c.available && c.type === 'hardware');
    
    if (hardwareCodecs.length === 0) {
      console.log('⚠️  No hardware codecs available to test');
      return;
    }

    console.log(`Testing ${hardwareCodecs.length} hardware codec(s)...\n`);

    for (const codec of hardwareCodecs) {
      console.log(`🧪 Testing ${codec.name}...`);
      const result = await this.testCodec(codec.name);
      codec.tested = result.success;
      codec.testResult = result.message;
      
      if (result.success) {
        console.log(`   ✅ ${codec.name} works! ${result.message}`);
      } else {
        console.log(`   ❌ ${codec.name} failed: ${result.message}`);
      }
    }

    // Always test software fallback
    const softwareCodec = this.capabilities.find(c => c.name === 'libx264');
    if (softwareCodec && softwareCodec.available) {
      console.log(`\n🧪 Testing ${softwareCodec.name} (software fallback)...`);
      const result = await this.testCodec(softwareCodec.name);
      softwareCodec.tested = result.success;
      softwareCodec.testResult = result.message;
      
      if (result.success) {
        console.log(`   ✅ ${softwareCodec.name} works! ${result.message}`);
      } else {
        console.log(`   ❌ ${softwareCodec.name} failed: ${result.message}`);
      }
    }
  }

  private async testCodec(codecName: string): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
      const testFile = join(this.tempDir, `test-${codecName}-${randomUUID()}.mp4`);
      const startTime = Date.now();
      
      let command: any;
      
      // Platform-specific test setup
      if (this.isWindows) {
        // Windows: use lavfi null source (cross-platform)
        command = ffmpeg()
          .input('nullsrc=s=64x64:d=0.1')
          .inputFormat('lavfi')
          .videoCodec(codecName);
      } else {
        // Linux/macOS: use /dev/zero with rawvideo
        command = ffmpeg()
          .input('/dev/zero')
          .inputFormat('rawvideo')
          .inputOptions(['-pix_fmt', 'yuv420p', '-s', '64x64', '-r', '1']);
      }

      // Codec-specific options
      if (codecName === 'h264_vaapi') {
        command
          .videoCodec(codecName)
          .addOption('-vaapi_device', '/dev/dri/renderD128')
          .addOption('-vf', 'format=nv12,hwupload')
          .addOption('-b:v', '100k');
      } else if (codecName === 'h264_nvenc') {
        command
          .videoCodec(codecName)
          .addOption('-preset', 'fast');
      } else if (codecName === 'h264_qsv') {
        command
          .videoCodec(codecName)
          .addOption('-preset', 'medium');
      } else if (codecName === 'h264_amf') {
        command
          .videoCodec(codecName)
          .addOption('-quality', 'speed');
      } else if (codecName === 'h264_videotoolbox') {
        command
          .videoCodec(codecName)
          .addOption('-profile:v', 'main');
      } else {
        command.videoCodec(codecName);
      }

      command
        .addOption('-frames:v', '1')
        .addOption('-f', 'mp4')
        .output(testFile)
        .on('end', async () => {
          const duration = Date.now() - startTime;
          try {
            await fs.unlink(testFile);
          } catch { }
          resolve({ success: true, message: `Encoded in ${duration}ms` });
        })
        .on('error', (err: Error) => {
          resolve({ success: false, message: err.message });
        });

      // Set a timeout
      setTimeout(() => {
        try {
          command.kill('SIGKILL');
        } catch { }
        resolve({ success: false, message: 'Test timeout (10s)' });
      }, 10000);

      command.run();
    });
  }

  private displayResults(): void {
    const working = this.capabilities.filter(c => c.available && c.tested);
    const available = this.capabilities.filter(c => c.available && !c.tested);
    const unavailable = this.capabilities.filter(c => !c.available);

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                    FINAL SUMMARY                           ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    if (working.length > 0) {
      console.log('🚀 WORKING CODECS (Recommended):');
      working.sort((a, b) => a.priority - b.priority).forEach(c => {
        const badge = c.type === 'hardware' ? '⚡' : '💻';
        console.log(`   ${badge} ${c.name} - Priority ${c.priority} ${c.testResult ? `(${c.testResult})` : ''}`);
      });
      console.log('');
    }

    if (available.length > 0) {
      console.log('🔄 AVAILABLE BUT UNTESTED:');
      available.forEach(c => {
        console.log(`   ⚠️  ${c.name} - Available in FFmpeg but not tested`);
      });
      console.log('');
    }

    if (unavailable.length > 0) {
      console.log('❌ UNAVAILABLE:');
      unavailable.forEach(c => {
        console.log(`   ❌ ${c.name} - Not in FFmpeg build`);
      });
      console.log('');
    }

    // Recommendation
    const recommended = working.length > 0 ? working[0] : available[0];
    if (recommended) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🎯 RECOMMENDATION:');
      console.log(`   Primary: ${recommended.name} (${recommended.type})`);
      
      const fallback = this.capabilities.find(c => c.name === 'libx264');
      if (fallback && fallback.tested) {
        console.log(`   Fallback: libx264 (software - always reliable)`);
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    } else {
      console.log('⚠️  WARNING: No working codecs found!\n');
    }
  }

  private async offerSaveConfig(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('💾 Save results to hardware-acceleration.config? (y/n): ', async (answer) => {
        rl.close();

        if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          await this.saveConfig();
          console.log('✅ Configuration saved!\n');
        } else {
          console.log('❌ Configuration not saved\n');
        }

        resolve();
      });
    });
  }

  private async saveConfig(): Promise<void> {
    const working = this.capabilities.filter(c => c.available && c.tested);
    const recommended = working.length > 0 ? working.sort((a, b) => a.priority - b.priority)[0] : null;
    const fallback = this.capabilities.find(c => c.name === 'libx264' && c.tested);

    const config: HardwareConfig = {
      platform: platform(),
      detectionDate: new Date().toISOString(),
      capabilities: this.capabilities,
      recommendedCodec: recommended?.name || 'libx264',
      fallbackCodec: fallback?.name || 'libx264'
    };

    const configPath = join(process.cwd(), 'hardware-acceleration.config');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    console.log(`📄 Config saved to: ${configPath}`);
  }
}

// Run the test
(async () => {
  try {
    const test = new HardwareAccelerationTest();
    await test.run();
    console.log('✅ Test completed successfully!\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
})();
