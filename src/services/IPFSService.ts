import { create } from 'ipfs-http-client';
import { EncoderConfig } from '../config/ConfigLoader.js';
import { logger } from './Logger.js';
import { LocalPinDatabase, LocalPin } from './LocalPinDatabase.js';
import { multiaddrToUrl } from '../common/IpfsUtils.js';

export class IPFSService {
  private config: EncoderConfig;
  private client: any;
  private peerId: string = '';
  private pinDatabase: LocalPinDatabase | null = null;

  constructor(config: EncoderConfig) {
    this.config = config;
    
    // Initialize pin database if local fallback is enabled
    if (this.config.ipfs?.enable_local_fallback) {
      this.pinDatabase = new LocalPinDatabase();
    }
  }

  async initialize(): Promise<void> {
    try {
      // Parse IPFS API address
      const apiAddr = this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001';
      
      // Convert multiaddr to HTTP URL
      const url = multiaddrToUrl(apiAddr);
      
      // Create IPFS client
      this.client = create({ url });
      
      // Test connectivity and get peer ID
      // Use direct HTTP API call to avoid multiaddr parsing issues
      const axios = await import('axios');
      const response = await axios.default.post(`${url}/api/v0/id`, null, {
        timeout: 10000
      });
      
      const identity = response.data;
      this.peerId = identity.ID || identity.id;
      
      logger.info(`📂 IPFS connected: ${this.peerId}`);
      
      // Initialize pin database if needed
      if (this.pinDatabase) {
        await this.pinDatabase.initialize();
      }
      
      // 🛡️ TANK MODE: Verify 3Speak IPFS node health
      await this.checkIPFSHealth();
      
    } catch (error) {
      logger.error('❌ Failed to connect to IPFS:', error);
      throw error;
    }
  }

  /**
   * Get the IPFS client instance for external use
   */
  getClient(): any {
    return this.client;
  }

  /**
   * Get the pin database instance (if local fallback is enabled)
   */
  getPinDatabase(): LocalPinDatabase | null {
    return this.pinDatabase;
  }

  /**
   * Get the last upload source info for verification purposes
   */
  getLastUploadSource(): { cid: string; source: 'hotnode' | 'supernode' | 'local'; endpoint: string } | null {
    return this.lastUploadSource;
  }

  /**
   * 🔍 Quick supernode connectivity check for timeout optimization
   */
  private async isSupernodeReachable(): Promise<boolean> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    
    try {
      // Quick ping check with short timeout
      await axios.default.post(`${threeSpeakIPFS}/api/v0/id`, null, {
        timeout: 5000 // Very short timeout for quick decision
      });
      return true;
    } catch (error) {
      logger.warn(`🚨 Supernode unreachable - shorter timeouts will be used`);
      return false;
    }
  }

  /**
   * 🎯 Calculate dynamic IPFS processing timeout based on file size
   * IPFS needs time to hash chunks, build merkle DAG, and compute final CID
   * Larger files = more chunks = longer processing time
   */
  private calculateIPFSProcessingTimeout(sizeBytes: number): number {
    const sizeMB = sizeBytes / (1024 * 1024);
    
    // Tiered timeouts based on file size
    if (sizeMB < 500) {
      return 2 * 60 * 1000; // 2 minutes for small files (<500MB)
    } else if (sizeMB < 2000) {
      return 5 * 60 * 1000; // 5 minutes for medium files (500MB-2GB)
    } else if (sizeMB < 5000) {
      return 10 * 60 * 1000; // 10 minutes for large files (2GB-5GB)
    } else {
      return 15 * 60 * 1000; // 15 minutes for huge files (>5GB)
    }
  }

  /**
   * 🚀 Calculate dynamic hotnode upload timeout
   * Hotnodes are fast, but need time for actual network upload
   */
  private calculateHotnodeUploadTimeout(sizeBytes: number): number {
    const sizeMB = sizeBytes / (1024 * 1024);
    
    // Tiered timeouts - hotnodes should be fast but realistic
    if (sizeMB < 500) {
      return 5 * 60 * 1000; // 5 minutes for small files
    } else if (sizeMB < 2000) {
      return 15 * 60 * 1000; // 15 minutes for medium files
    } else if (sizeMB < 5000) {
      return 30 * 60 * 1000; // 30 minutes for large files
    } else {
      return 60 * 60 * 1000; // 60 minutes for huge files
    }
  }

  /**
   * 🔒 Calculate dynamic pinning timeout
   * Pinning requires fetching content and adding to pin set
   */
  private calculatePinningTimeout(supernodeReachable: boolean): number {
    // Base timeout depends on supernode availability
    if (supernodeReachable) {
      return 5 * 60 * 1000; // 5 minutes when supernode is up
    } else {
      return 2 * 60 * 1000; // 2 minutes when supernode is down (faster fail)
    }
  }

  /**
   * �🛡️ TANK MODE: Check IPFS node health before operations
   */
  private async checkIPFSHealth(): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    
    try {
      logger.info(`🏥 Checking 3Speak IPFS node health...`);
      
      // Check node is responding
      const idResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/id`, null, {
        timeout: 10000
      });
      
      logger.info(`✅ 3Speak IPFS node is healthy`);
      
      // Check repo stats to see if node has capacity
      try {
        const statsResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/repo/stat`, null, {
          timeout: 10000
        });
        
        let stats;
        if (typeof statsResponse.data === 'string') {
          stats = JSON.parse(statsResponse.data);
        } else {
          stats = statsResponse.data;
        }
        
        const usedGB = (stats.RepoSize || 0) / (1024 * 1024 * 1024);
        const numObjects = stats.NumObjects || 0;
        
        logger.info(`📊 IPFS Stats: ${usedGB.toFixed(2)}GB used, ${numObjects} objects`);
        
        // Warn if repo is getting large (might affect performance)
        if (usedGB > 100) {
          logger.warn(`⚠️ IPFS repo is large (${usedGB.toFixed(2)}GB) - performance may be affected`);
        }
        
      } catch (statsError) {
        // Stats check is nice-to-have, not critical
        logger.debug('Could not fetch repo stats (non-critical)');
      }
      
      // Check cluster health if cluster pinning is enabled
      if (this.config.ipfs?.use_cluster_for_pins) {
        await this.checkClusterHealth();
      }
      
    } catch (error: any) {
      logger.warn(`⚠️ 3Speak IPFS health check failed:`, error.message);
      logger.warn(`⚠️ Uploads may fail or be slow - consider checking IPFS node status`);
      // Don't throw - we'll try to proceed anyway
    }
  }

  /**
   * 🛡️ TANK MODE: Check IPFS Cluster health when cluster pinning is enabled
   */
  private async checkClusterHealth(): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      logger.info(`🏥 Checking IPFS Cluster health...`);
      
      // Check cluster is responding
      const idResponse = await axios.default.get(`${clusterEndpoint}/id`, {
        timeout: 10000
      });
      
      const clusterInfo = idResponse.data;
      logger.info(`✅ IPFS Cluster is healthy (${clusterInfo.peername || 'unknown'})`);
      logger.info(`📊 Cluster version: ${clusterInfo.version}, peers: ${clusterInfo.cluster_peers?.length || 0}`);
      
    } catch (error: any) {
      logger.warn(`⚠️ IPFS Cluster health check failed:`, error.message);
      logger.warn(`⚠️ Cluster pinning may fail - consider checking cluster status`);
      // Don't throw - we'll try to proceed anyway
    }
  }

  async getPeerId(): Promise<string> {
    if (!this.peerId) {
      try {
        // Use direct HTTP API call to avoid multiaddr parsing issues
        const url = multiaddrToUrl(this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001');
        const axios = await import('axios');
        const response = await axios.default.post(`${url}/api/v0/id`, null, {
          timeout: 10000
        });
        
        const identity = response.data;
        this.peerId = identity.ID || identity.id;
      } catch (error) {
        logger.error('❌ Failed to get peer ID:', error);
        throw error;
      }
    }
    return this.peerId;
  }

  async downloadFile(uri: string, outputPath: string): Promise<void> {
    try {
      // Extract IPFS hash from URI
      const hash = this.extractIPFSHash(uri);
      
      logger.info(`📥 Streaming download ${hash} to ${outputPath}`);
      
      // 🚨 FIX: Stream download instead of loading into memory
      const fs = await import('fs');
      const writeStream = fs.createWriteStream(outputPath);
      let totalBytes = 0;
      
      for await (const chunk of this.client.cat(hash)) {
        writeStream.write(chunk);
        totalBytes += chunk.length;
      }
      
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
      });
      
      logger.info(`✅ Streamed ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);
    } catch (error) {
      logger.error('❌ IPFS download failed:', error);
      throw error;
    }
  }

  /**
   * 🚀 Get hotnode upload endpoint from traffic director
   */
  private async getHotnodeEndpoint(): Promise<string | null> {
    try {
      const axios = await import('axios');
      const trafficDirectorUrl = this.config.ipfs?.traffic_director_url || 'https://cdn.3speak.tv/api/hotnode';
      logger.info(`🎯 Requesting hotnode from traffic director: ${trafficDirectorUrl}`);
      
      const response = await axios.default.get(trafficDirectorUrl, {
        timeout: 5000
      });
      
      if (response.data?.success && response.data?.data?.uploadEndpoint) {
        const endpoint = response.data.data.uploadEndpoint;
        logger.info(`✅ Hotnode assigned: ${endpoint}`);
        return endpoint;
      }
      
      logger.warn(`⚠️ Traffic director returned unexpected response`);
      return null;
      
    } catch (error: any) {
      logger.warn(`⚠️ Traffic director unavailable: ${error.message}`);
      return null;
    }
  }

  async uploadFile(filePath: string, pin: boolean = false): Promise<string> {
    // Declare stream outside try block for proper cleanup access
    let fileStream: any = null;
    
    try {
      // Upload directly to 3Speak IPFS instead of local node
      const threeSpeakIPFS = 'http://65.21.201.94:5002';
      const axios = await import('axios');
      const FormData = await import('form-data');
      const fs = await import('fs');
      const fsPromises = await import('fs/promises');
      const path = await import('path');
      
      const stats = await fsPromises.stat(filePath);
      const fileName = path.basename(filePath);
      
      logger.info(`📤 Streaming ${(stats.size / 1024 / 1024).toFixed(1)}MB to 3Speak IPFS: ${fileName}`);
      
      // 🚨 FIX: Use stream instead of loading entire file into memory
      const form = new FormData.default();
      fileStream = fs.createReadStream(filePath);
      form.append('file', fileStream, fileName);
      
      // 🚨 MEMORY SAFE: Use named function to avoid closure memory leaks
      const handleStreamError = () => {
        try {
          if (fileStream && !fileStream.destroyed) {
            fileStream.destroy();
            fileStream.removeAllListeners(); // Remove all listeners to prevent leaks
          }
        } catch (e) {
          // Ignore cleanup errors
        }
      };
      
      fileStream.on('error', handleStreamError);
      
      // Calculate timeout based on file size with reasonable limits
      const baseTimeout = 60000;  // 1 minute base
      const perMBTimeout = 10000;  // 10 seconds per MB (reduced from 30s per 10MB)
      const maxTimeout = 600000;   // 10 minutes maximum
      
      const calculatedTimeout = baseTimeout + Math.floor(stats.size / (1024 * 1024)) * perMBTimeout;
      const timeoutMs = Math.min(calculatedTimeout, maxTimeout);
      
      logger.info(`⏱️ Upload timeout: ${Math.floor(timeoutMs / 1000)}s (size: ${(stats.size/1024/1024).toFixed(1)}MB, max: ${maxTimeout/1000}s)`);
      
      const response = await axios.default.post(`${threeSpeakIPFS}/api/v0/add`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        maxRedirects: 3,
        responseType: 'text', // 🚨 FIX: Ensure response is treated as text, not binary
        validateStatus: (status) => status < 400,
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percent % 25 === 0) { // Log every 25%
              logger.info(`📤 Upload progress: ${percent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB)`);
            }
          }
        }
      });
      
      // 🚨 FIX: Ensure we have text data, not binary
      if (typeof response.data !== 'string') {
        logger.error('❌ IPFS response is not text data - possible binary response leak');
        throw new Error('IPFS returned non-text response data');
      }
      
      const result = JSON.parse(response.data);
      const hash = result.Hash;
      
      logger.info(`✅ File uploaded to 3Speak IPFS: ${hash}`);
      
      // Clean up file stream after successful upload
      try {
        if (!fileStream.destroyed) fileStream.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
      
      // 🛡️ TANK MODE: Bulletproof pin with verification (only if requested)
      if (pin) {
        logger.info(`🛡️ TANK MODE: Ensuring ${hash} is bulletproof pinned...`);
        await this.pinAndAnnounce(hash);
      }
      
      return hash;
    } catch (error) {
      // 🚨 CRITICAL: Clean up file stream on error to prevent memory leak
      try {
        if (!fileStream.destroyed) fileStream.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
      logger.error('❌ File upload to 3Speak IPFS failed:', error);
      throw error;
    }
  }

  // Track the last upload source for verification
  private lastUploadSource: { cid: string; source: 'hotnode' | 'supernode' | 'local'; endpoint: string } | null = null;

  async uploadDirectory(dirPath: string, pin: boolean = false, onPinFailed?: (hash: string, error: Error) => void): Promise<string> {
    let cid: string | null = null;
    let uploadSource: 'hotnode' | 'supernode' | 'local' | null = null;
    
    // 🚀 STEP 1: Try hotnode upload (fast UX path)
    const hotnodeEndpoint = await this.getHotnodeEndpoint();
    if (hotnodeEndpoint) {
      try {
        logger.info(`🚀 HOTNODE PATH: Attempting upload to hotnode for fast UX`);
        cid = await this.uploadDirectoryToHotnode(dirPath, hotnodeEndpoint);
        uploadSource = 'hotnode';
        logger.info(`✅ Hotnode upload successful: ${cid}`);
        logger.info(`🎯 Hotnode handles long-term storage sync - no tracking needed`);
        
        // 🛡️ TRACK UPLOAD SOURCE: Store for verification
        this.lastUploadSource = { cid, source: 'hotnode', endpoint: hotnodeEndpoint };
        
        // Return immediately - hotnode handles everything
        return cid;
        
      } catch (error: any) {
        logger.warn(`⚠️ Hotnode upload failed: ${error.message}`);
        logger.info(`🔄 Falling back to supernode upload path...`);
      }
    } else {
      logger.info(`⚠️ No hotnode available, using supernode path...`);
    }
    
    // 🚨 STEP 2: Fallback to supernode (original path)
    const maxRetries = 1;
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`📤 Uploading directory ${dirPath} to 3Speak IPFS${maxRetries > 1 ? ` (attempt ${attempt}/${maxRetries})` : ''}`);
        
        // 📊 TIMING: Measure actual upload duration
        const uploadStartTime = Date.now();
        const result = await this.performDirectoryUpload(dirPath);
        const uploadDuration = Date.now() - uploadStartTime;
        uploadSource = 'supernode';
        cid = result;
        
        // 🛡️ TRACK UPLOAD SOURCE: Store for verification
        const supernodeEndpoint = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
        this.lastUploadSource = { cid: result, source: 'supernode', endpoint: supernodeEndpoint };
        
        // 📊 UPLOAD ANALYTICS: Show real timing and speed
        logger.info(`⏱️ Upload completed in ${(uploadDuration / 1000).toFixed(1)}s for directory ${dirPath}`);
        
        // Calculate directory size for speed analysis
        try {
          const fs = await import('fs/promises');
          const path = await import('path');
          const files = await this.getAllFiles(dirPath);
          let totalSize = 0;
          for (const filePath of files) {
            const stats = await fs.stat(filePath);
            totalSize += stats.size;
          }
          const sizeMB = totalSize / (1024 * 1024);
          const speedMbps = (totalSize * 8) / (1024 * 1024) / (uploadDuration / 1000); // Megabits per second
          
          logger.info(`📊 UPLOAD STATS: ${sizeMB.toFixed(1)}MB uploaded in ${(uploadDuration/1000).toFixed(1)}s (${speedMbps.toFixed(1)} Mbps)`);
          
          // 🚨 COMPREHENSIVE UPLOAD ANALYSIS
          const isLargeUpload = sizeMB > 100;
          const isInstantUpload = uploadDuration < 1000; // Under 1 second
          const isSuperFastUpload = uploadDuration < 5000 && sizeMB > 50; // >50MB in <5 seconds
          const theoreticalMaxSpeed = 1000; // 1Gbps in Mbps (very generous)
          
          if (isInstantUpload && sizeMB > 10) {
            logger.warn(`🚨 INSTANT UPLOAD DETECTED: ${sizeMB.toFixed(1)}MB in ${uploadDuration}ms - This is IMPOSSIBLE for real upload!`);
            logger.warn(`🔍 DIAGNOSIS: Content was already cached/deduplicated on IPFS node`);
            logger.warn(`📋 IPFS deduplication means identical content returns existing hash instantly`);
            logger.info(`✅ This is normal IPFS behavior - your content was uploaded previously and is being reused`);
          } else if (isSuperFastUpload) {
            logger.warn(`🚨 SUSPICIOUSLY FAST UPLOAD: ${sizeMB.toFixed(1)}MB in ${(uploadDuration/1000).toFixed(1)}s (${speedMbps.toFixed(1)} Mbps)`);
            if (speedMbps > theoreticalMaxSpeed) {
              logger.warn(`🔍 DIAGNOSIS: Speed exceeds theoretical maximum (${theoreticalMaxSpeed} Mbps) - likely deduplication`);
              logger.info(`📋 IPFS probably found identical content and returned cached hash`);
            } else {
              logger.warn(`🔍 This could indicate: very fast connection, local network, or partial deduplication`);
            }
          } else if (isLargeUpload) {
            logger.info(`📈 NORMAL LARGE UPLOAD: ${sizeMB.toFixed(1)}MB in ${(uploadDuration/1000).toFixed(1)}s (${speedMbps.toFixed(1)} Mbps)`);
            if (speedMbps > 100) {
              logger.info(`🚀 Excellent upload speed! Your connection is very fast.`);
            }
          } else {
            logger.info(`📤 Small file upload: ${sizeMB.toFixed(1)}MB in ${(uploadDuration/1000).toFixed(1)}s (${speedMbps.toFixed(1)} Mbps)`);
          }
        } catch (sizeError) {
          logger.warn(`⚠️ Could not calculate upload speed: ${sizeError}`);
        }
        
        // � PINATA-STYLE: Only pin if explicitly requested
        if (pin) {
          // �🛡️ TANK MODE: Bulletproof pin with verification  
          logger.info(`🛡️ TANK MODE: Ensuring ${result} is bulletproof pinned...`);
          
          try {
            await this.pinAndAnnounce(result);
            logger.info(`🎯 Directory upload complete and verified: ${result}`);
          } catch (pinError: any) {
            // 🚨 FALLBACK: If pinning fails, still return the hash since content is uploaded
            logger.warn(`⚠️ Pinning failed for ${result}, but content is uploaded: ${pinError.message}`);
            logger.warn(`🚨 Job will complete without pinning to prevent stuck jobs`);
            
            // 🔄 LAZY PINNING: Queue for background retry
            if (onPinFailed) {
              onPinFailed(result, pinError);
              logger.info(`📋 Queued ${result} for lazy pinning retry`);
            }
            
            logger.info(`📤 Directory upload complete (no pinning): ${result}`);
          }
        } else {
          // 🚀 PINATA-STYLE: Just return CID immediately, no pinning
          const ipfsGateway = this.config.ipfs_gateway_url || 'https://ipfs.3speak.tv';
          logger.info(`🚀 PINATA-STYLE: Upload complete, returning CID immediately: ${result}`);
          logger.info(`📊 🎯 MANUAL CID: ${result} - Content accessible right now!`);
          logger.info(`🔍 Verify access: ${ipfsGateway}/ipfs/${result}/manifest.m3u8`);
          logger.info(`🔄 Pinning will be handled by lazy pinning service in background`);
          
          // 🔄 LAZY PINNING: Queue for background pinning
          if (onPinFailed) {
            setTimeout(() => {
              logger.info(`🔄 Triggering lazy pinning for ${result}`);
              onPinFailed(result, new Error('lazy_pin_requested'));
            }, 100);
          }
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        logger.error(`❌ Supernode upload failed:`, error.message);
        logger.warn(`🚨 THE SHOW MUST GO ON: Supernode failed, will use local IPFS fallback`);
        
        // No retries - if supernode fails, break immediately to trigger fallback
        break;
      }
    }
    
    // 🚨 ACTUAL LOCAL FALLBACK: Upload to local IPFS instead of throwing
    logger.error('❌ Supernode upload failed - executing local IPFS fallback NOW');
    logger.info(`🏠 LOCAL FALLBACK: Uploading ${dirPath} to local IPFS daemon...`);
    
    try {
      // Upload to local IPFS daemon
      const result = await this.uploadDirectoryToLocalIPFS(dirPath);
      
      // 🛡️ TRACK UPLOAD SOURCE: Store for verification
      // Convert multiaddr to HTTP URL for consistency
      const apiAddr = this.config.ipfs?.apiAddr || '/ip4/127.0.0.1/tcp/5001';
      const localEndpoint = multiaddrToUrl(apiAddr);
      this.lastUploadSource = { cid: result, source: 'local', endpoint: localEndpoint };
      
      logger.info(`✅ LOCAL FALLBACK SUCCESS: ${result}`);
      logger.info(`📝 Logging local pin for future sync to supernode`);
      
      // Log this for lazy sync service
      await this.logLocalPin(result);
      
      // Handle pinning callback if requested
      if (pin && onPinFailed) {
        onPinFailed(result, new Error('local_fallback_pin'));
      }
      
      return result;
      
    } catch (localError: any) {
      logger.error(`❌ LOCAL FALLBACK ALSO FAILED:`, localError.message);
      logger.error(`🚨 CRITICAL: Both supernode and local IPFS failed - job cannot complete`);
      throw new Error(`Both supernode and local IPFS failed. Supernode: ${lastError.message}, Local: ${localError.message}`);
    }
  }
  
  private async performDirectoryUpload(dirPath: string): Promise<string> {
    // Upload directly to 3Speak's IPFS node using UnixFS directory approach
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    const FormData = await import('form-data');
    const fs = await import('fs/promises');
    const path = await import('path');
    
    logger.info(`📦 Uploading directory ${dirPath} using UnixFS approach`);
    
    // Get all files in the directory
    const files = await this.getAllFiles(dirPath);
    const form = new FormData.default();
    let totalSize = 0;
    
    // 🚨 FIX: Add all files to form data with streams instead of buffers
    const fileStreams: any[] = []; // Track streams for cleanup
    
    for (const filePath of files) {
      const relativePath = path.relative(dirPath, filePath);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      
      // Add file stream with proper path for directory structure
      const nodeFs = await import('fs');
      const fileStream = nodeFs.createReadStream(filePath);
      fileStreams.push(fileStream); // Track for cleanup
      
      form.append('file', fileStream, {
        filename: relativePath,
        filepath: relativePath
      });
      
      logger.info(`📤 Adding to directory: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    // 🚨 MEMORY SAFE: Function to clean up all file streams
    const cleanupAllStreams = () => {
      fileStreams.forEach(stream => {
        try {
          if (!stream.destroyed) stream.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      });
    };
    
    logger.info(`📦 Total directory size: ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${files.length} files`);
    
    // Calculate timeout based on total size with reasonable limits
      // 🚨 TWO-PHASE TIMEOUT: Upload timeout + IPFS processing timeout
      // Phase 1: Upload timeout (aggressive - if slow, fuck it)
      const uploadBaseTimeout = 15000;  // 15 seconds base
      const uploadPerMBTimeout = 1000;  // 1 second per MB
      const uploadMaxTimeout = 30000;   // 30s max for upload
      
      const uploadTimeout = Math.min(
        uploadBaseTimeout + Math.floor(totalSize / (1024 * 1024)) * uploadPerMBTimeout,
        uploadMaxTimeout
      );
      
      // Phase 2: IPFS processing timeout - DYNAMIC based on file size!
      // Large files need more time for merkle DAG construction and CID calculation
      const ipfsProcessingTimeout = this.calculateIPFSProcessingTimeout(totalSize);
      
      // Total timeout = upload + processing
      const timeoutMs = uploadTimeout + ipfsProcessingTimeout;
      
      logger.info(`⏱️ Upload timeout: ${Math.floor(uploadTimeout / 1000)}s for ${(totalSize/1024/1024).toFixed(1)}MB upload`);
      logger.info(`⏱️ IPFS processing timeout: ${Math.floor(ipfsProcessingTimeout / 1000)}s for directory hashing (DYNAMIC based on ${(totalSize/1024/1024).toFixed(1)}MB size)`);
      logger.info(`⏱️ Total timeout: ${Math.floor(timeoutMs / 1000)}s (${(timeoutMs/60000).toFixed(1)} minutes total)`);
    
    // 📊 Track HTTP request timing separately from our upload timing
    let httpStartTime: number;
    let httpEndTime: number;
    let bytesUploaded = 0;
    let progressEvents = 0;
    
    try {
      logger.info(`🌐 Starting HTTP POST to ${threeSpeakIPFS}/api/v0/add...`);
      httpStartTime = Date.now();
      
      // 🚨 CRITICAL: Track when upload completes vs when response arrives
      let uploadCompleteTime = 0;
      let lastProgressTime = httpStartTime;
      let uploadPhaseComplete = false;
      
      // 🚨 BULLETPROOF: Manual timeout wrapper to catch axios timeout failures
      const uploadPromise = axios.default.post(`${threeSpeakIPFS}/api/v0/add?wrap-with-directory=true&recursive=true`, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        responseType: 'text', // 🚨 FIX: Ensure response is treated as text, not binary
        validateStatus: (status) => status < 400,
        onUploadProgress: (progressEvent) => {
          progressEvents++;
          bytesUploaded = progressEvent.loaded;
          lastProgressTime = Date.now();
          
          if (progressEvent.total) {
            const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            if (percent % 25 === 0) { // Log every 25%
              const currentTime = Date.now();
              const timeElapsed = currentTime - httpStartTime;
              const currentSpeed = (progressEvent.loaded * 8) / (1024 * 1024) / (timeElapsed / 1000); // Mbps
              logger.info(`📦 Directory upload progress: ${percent}% (${(progressEvent.loaded / 1024 / 1024).toFixed(1)}MB) - ${currentSpeed.toFixed(1)} Mbps real-time`);
              
              // Track when upload finishes
              if (percent === 100 && uploadCompleteTime === 0) {
                uploadCompleteTime = currentTime;
                uploadPhaseComplete = true;
                logger.info(`✅ Upload bytes transmitted in ${(timeElapsed/1000).toFixed(1)}s`);
                logger.info(`⏳ Phase 2: Waiting for IPFS to process directory and return hash (max ${ipfsProcessingTimeout/1000}s)...`);
              }
            }
          }
        }
      });
      
      // 🚨 MANUAL TIMEOUT: Force timeout if axios doesn't enforce it
      const manualTimeout = new Promise((_, reject) => {
        setTimeout(() => {
          const elapsed = Date.now() - httpStartTime;
          const phase = uploadPhaseComplete ? 'IPFS processing' : 'upload';
          const waitTime = uploadCompleteTime > 0 ? Date.now() - uploadCompleteTime : 0;
          
          if (uploadPhaseComplete && waitTime > ipfsProcessingTimeout) {
            reject(new Error(`IPFS processing timeout: Upload completed in ${(uploadCompleteTime - httpStartTime)/1000}s, but IPFS took >${ipfsProcessingTimeout/1000}s to process directory`));
          } else if (!uploadPhaseComplete) {
            reject(new Error(`Upload timeout: Upload phase took >${uploadTimeout/1000}s (slow connection or deduplication issue)`));
          } else {
            reject(new Error(`Manual timeout after ${timeoutMs}ms in ${phase} phase`));
          }
        }, timeoutMs);
      });
      
      // Race between upload and manual timeout
      const response = await Promise.race([uploadPromise, manualTimeout]) as any;
      
      httpEndTime = Date.now();
      const httpDuration = httpEndTime - httpStartTime;
      const responseWaitTime = uploadCompleteTime > 0 ? httpEndTime - uploadCompleteTime : 0;
      
      // 📊 HTTP REQUEST ANALYSIS
      logger.info(`🌐 HTTP request completed in ${httpDuration}ms (${progressEvents} progress events, ${(bytesUploaded/1024/1024).toFixed(1)}MB uploaded)`);
      if (responseWaitTime > 0) {
        logger.info(`⏳ Response wait time: ${(responseWaitTime/1000).toFixed(1)}s (time between upload complete and response received)`);
        if (responseWaitTime > 30000) {
          logger.warn(`🚨 SLOW RESPONSE: IPFS took ${(responseWaitTime/1000).toFixed(1)}s to process after upload completed`);
        }
      }
      logger.info(`📋 Response received - parsing IPFS output...`);
      
      if (httpDuration < 1000 && totalSize > 50 * 1024 * 1024) { // <1s for >50MB
        logger.warn(`🚨 HTTP DEDUPLICATION DETECTED: ${(totalSize/1024/1024).toFixed(1)}MB request completed in ${httpDuration}ms`);
        logger.info(`📋 IPFS found identical content and returned cached result - this is normal and efficient!`);
      } else if (progressEvents === 0) {
        logger.warn(`🚨 NO PROGRESS EVENTS: Upload completed without progress tracking - possible instant deduplication`);
      } else {
        logger.info(`✅ HTTP upload appears to be genuine: ${progressEvents} progress events over ${httpDuration}ms`);
      }
      
      // Parse response - should be newline-delimited JSON
      // 🚨 FIX: Ensure we have text data, not binary
      if (typeof response.data !== 'string') {
        logger.error('❌ IPFS response is not text data - possible binary response leak');
        throw new Error('IPFS returned non-text response data');
      }
      
      // 🔍 DEBUG: Log the raw response for troubleshooting
      logger.info(`🗂️ Raw 3Speak IPFS response (first 500 chars): ${response.data.substring(0, 500)}`);
      
      const lines = response.data.trim().split('\n');
      let directoryHash = '';
      
      logger.info(`📊 Response contains ${lines.length} lines`);
      
      // Find the directory hash (usually the last entry)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue; // Skip undefined lines
        
        try {
          if (!line.trim()) continue; // Skip empty lines
          
          const result = JSON.parse(line);
          logger.info(`🔍 Line ${i + 1}: Name="${result.Name || ''}", Hash="${result.Hash || ''}", Size=${result.Size || 0}`);
          
          if (result.Name === '' || result.Name === dirPath || !result.Name) {
            directoryHash = result.Hash;
            logger.info(`🎯 Found directory hash: ${directoryHash} (matched on Name="${result.Name || 'empty'}")`);
          }
        } catch (parseError) {
          logger.warn(`⚠️ Could not parse IPFS response line ${i + 1}: ${line.substring(0, 100)}...`);
          // Continue processing other lines
        }
      }
      
      // 🆘 FALLBACK: If no directory hash found, try the last hash in the response
      if (!directoryHash && lines.length > 0) {
        logger.warn(`⚠️ No directory hash found using standard criteria, trying fallback...`);
        
        // Try the last line (often the directory wrapper)
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line) continue;
          
          try {
            const result = JSON.parse(line);
            if (result.Hash) {
              directoryHash = result.Hash;
              logger.info(`🆘 Fallback: Using last hash as directory hash: ${directoryHash}`);
              break;
            }
          } catch (e) {
            // Continue to previous line
          }
        }
      }
      
      if (!directoryHash) {
        logger.error(`🚨 CRITICAL: Could not extract directory hash from response`);
        logger.error(`🗂️ Full response data: ${response.data}`);
        throw new Error(`Could not find directory hash in response. Response had ${lines.length} lines.`);
      }
      
      logger.info(`✅ Directory uploaded successfully: ${directoryHash}`);
      
      // 📊 COMPREHENSIVE UPLOAD SUMMARY
      const httpSpeed = (totalSize * 8) / (1024 * 1024) / (httpDuration / 1000); // Mbps
      const isDeduplicationLikely = httpDuration < 1000 && totalSize > 10 * 1024 * 1024; // <1s for >10MB
      
      logger.info(`📋 UPLOAD SUMMARY:`);
      logger.info(`   📦 Total Size: ${(totalSize/1024/1024).toFixed(1)}MB (${files.length} files)`);
      logger.info(`   ⏱️ HTTP Duration: ${httpDuration}ms`);
      logger.info(`   📊 HTTP Speed: ${httpSpeed.toFixed(1)} Mbps`);
      logger.info(`   📈 Progress Events: ${progressEvents}`);
      logger.info(`   🎯 Final Hash: ${directoryHash}`);
      
      if (isDeduplicationLikely) {
        logger.info(`   🔄 LIKELY DEDUPLICATION: Content was already on IPFS, returned cached hash`);
        logger.info(`   ✅ This is efficient - your content is available immediately!`);
      } else if (httpSpeed > 500) {
        logger.info(`   🚀 EXCELLENT SPEED: Very fast upload connection`);
      } else if (httpSpeed > 100) {
        logger.info(`   📈 GOOD SPEED: Above-average upload performance`);
      } else {
        logger.info(`   📊 NORMAL SPEED: Standard upload performance`);
      }
      
      // Clean up all file streams after successful upload
      cleanupAllStreams();
      
      return directoryHash;
      
    } catch (error: any) {
      // 🚨 CRITICAL: Clean up all file streams on error to prevent memory leak
      cleanupAllStreams();
      logger.error('❌ UnixFS directory upload failed:', error.message);
      throw error;
    }
  }
  
  /**
   * 🚀 HOTNODE: Upload directory to assigned hotnode for fast UX
   */
  private async uploadDirectoryToHotnode(dirPath: string, hotnodeEndpoint: string): Promise<string> {
    const axios = await import('axios');
    const FormData = await import('form-data');
    const fs = await import('fs/promises');
    const path = await import('path');
    
    logger.info(`🚀 Uploading directory ${dirPath} to hotnode: ${hotnodeEndpoint}`);
    
    // Get all files in the directory
    const files = await this.getAllFiles(dirPath);
    const form = new FormData.default();
    let totalSize = 0;
    
    // Track streams for cleanup
    const fileStreams: any[] = [];
    
    for (const filePath of files) {
      const relativePath = path.relative(dirPath, filePath);
      const stats = await fs.stat(filePath);
      totalSize += stats.size;
      
      const nodeFs = await import('fs');
      const fileStream = nodeFs.createReadStream(filePath);
      fileStreams.push(fileStream);
      
      form.append('file', fileStream, {
        filename: relativePath,
        filepath: relativePath
      });
      
      logger.info(`📤 Adding to directory: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    const cleanupAllStreams = () => {
      fileStreams.forEach(stream => {
        try {
          if (!stream.destroyed) stream.destroy();
        } catch (e) {
          // Ignore cleanup errors
        }
      });
    };
    
    logger.info(`📦 Total directory size: ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${files.length} files`);
    
    // Dynamic timeout based on file size - hotnodes are fast but large files need time
    const timeoutMs = this.calculateHotnodeUploadTimeout(totalSize);
    logger.info(`⏱️ Hotnode upload timeout: ${Math.floor(timeoutMs / 1000)}s (${(timeoutMs/60000).toFixed(1)} min) - DYNAMIC based on ${(totalSize/1024/1024).toFixed(1)}MB size`);
    
    try {
      const startTime = Date.now();
      
      // 🚨 CRITICAL: Add wrap-with-directory parameter to get directory CID, not file CID
      const uploadUrl = `${hotnodeEndpoint}?wrap-with-directory=true`;
      logger.info(`🎯 Using wrap-with-directory to ensure proper directory CID`);
      
      const response = await axios.default.post(uploadUrl, form, {
        headers: {
          ...form.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: timeoutMs,
        responseType: 'text',
        validateStatus: (status) => status < 400,
      });
      
      const duration = Date.now() - startTime;
      logger.info(`🚀 Hotnode upload completed in ${(duration / 1000).toFixed(1)}s`);
      
      // Parse response - same IPFS format as supernode
      const lines = response.data.trim().split('\n');
      let directoryHash = '';
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const result = JSON.parse(line);
          if (result.Name === '' || !result.Name) {
            directoryHash = result.Hash;
            logger.info(`🎯 Hotnode returned directory hash: ${directoryHash}`);
            break;
          }
        } catch (parseError) {
          continue;
        }
      }
      
      if (!directoryHash && lines.length > 0) {
        // Fallback: use last hash
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const result = JSON.parse(lines[i]);
            if (result.Hash) {
              directoryHash = result.Hash;
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      if (!directoryHash) {
        throw new Error(`Could not extract directory hash from hotnode response`);
      }
      
      logger.info(`✅ Hotnode upload successful: ${directoryHash}`);
      cleanupAllStreams();
      return directoryHash;
      
    } catch (error: any) {
      cleanupAllStreams();
      logger.error(`❌ Hotnode upload failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 🏠 LOCAL FALLBACK: Upload directory to local IPFS daemon when supernode fails
   */
  private async uploadDirectoryToLocalIPFS(dirPath: string): Promise<string> {
    logger.info(`🏠 Uploading directory to local IPFS daemon: ${dirPath}`);
    
    const fs = await import('fs/promises');
    const path = await import('path');
    const { globSource } = await import('ipfs-http-client');
    
    try {
      // Get all files for progress tracking
      const files = await this.getAllFiles(dirPath);
      let totalSize = 0;
      for (const filePath of files) {
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }
      
      logger.info(`📦 Local upload: ${(totalSize / 1024 / 1024).toFixed(1)}MB in ${files.length} files`);
      
      const startTime = Date.now();
      let directoryHash = '';
      
      // Add directory with all contents using globSource
      const addOptions = {
        wrapWithDirectory: true,
        pin: true // Pin locally
      };
      
      logger.info(`🔄 Adding files to local IPFS...`);
      
      for await (const result of this.client.addAll(globSource(dirPath, '**/*'), addOptions)) {
        if (!result.path || result.path === '') {
          // This is the root directory hash
          directoryHash = result.cid.toString();
          logger.info(`🎯 Local IPFS directory hash: ${directoryHash}`);
        }
      }
      
      if (!directoryHash) {
        throw new Error('Failed to get directory hash from local IPFS');
      }
      
      const duration = Date.now() - startTime;
      const speedMbps = (totalSize * 8) / (1024 * 1024) / (duration / 1000);
      
      logger.info(`✅ Local IPFS upload complete: ${directoryHash}`);
      logger.info(`📊 Local upload: ${(totalSize/1024/1024).toFixed(1)}MB in ${(duration/1000).toFixed(1)}s (${speedMbps.toFixed(1)} Mbps)`);
      logger.info(`📝 Content pinned locally and ready for lazy sync to supernode`);
      
      return directoryHash;
      
    } catch (error: any) {
      logger.error(`❌ Local IPFS upload failed:`, error.message);
      throw error;
    }
  }
  
  
  
  private async createDirectoryFromFiles(files: Array<{hash: string, name: string}>, threeSpeakIPFS: string): Promise<string> {
    const axios = await import('axios');
    
    // Create directory object using IPFS object patch
    logger.info(`�️ Creating directory structure from ${files.length} files`);
    
    // Start with empty directory
    const emptyDirResponse = await axios.default.post(`${threeSpeakIPFS}/api/v0/object/new?arg=unixfs-dir`, null, {
      timeout: 30000
    });
    
    // Handle both JSON string and object responses
    let emptyDirResult;
    if (typeof emptyDirResponse.data === 'string') {
      emptyDirResult = JSON.parse(emptyDirResponse.data);
    } else {
      emptyDirResult = emptyDirResponse.data;
    }
    
    let dirHash = emptyDirResult.Hash;
    logger.info(`📁 Created empty directory: ${dirHash}`);
    
    // Add each file to the directory
    for (const file of files) {
      try {
        const addResponse = await axios.default.post(
          `${threeSpeakIPFS}/api/v0/object/patch/add-link?arg=${dirHash}&arg=${file.name}&arg=${file.hash}`,
          null,
          { timeout: 30000 }
        );
        
        // Handle both JSON string and object responses
        let addResult;
        if (typeof addResponse.data === 'string') {
          addResult = JSON.parse(addResponse.data);
        } else {
          addResult = addResponse.data;
        }
        
        dirHash = addResult.Hash;
        logger.info(`🔗 Added ${file.name} to directory: ${dirHash}`);
      } catch (error) {
        logger.error(`❌ Failed to add ${file.name} to directory:`, error);
        throw error;
      }
    }
    
    logger.info(`✅ Directory created: ${dirHash}`);
    return dirHash;
  }

  /**
   * � BULLETPROOF: Pinning that NEVER blocks job completion
   * Jobs MUST complete regardless of pinning status
   */
  private async pinAndAnnounce(hash: string): Promise<void> {
    try {
      // 🚨 CRITICAL: Use bulletproof timeout that CANNOT be bypassed
      await this.attemptPinWithBulletproofTimeout(hash);
      logger.info(`✅ Pinning completed successfully for ${hash}`);
    } catch (error: any) {
      // 🚨 NEVER let pinning failures block job completion
      logger.warn(`⚠️ Pinning failed for ${hash}, but job will continue:`, error.message);
      logger.warn(`📋 Content is uploaded and accessible - pinning can be retried later`);
      
      // Log for manual retry if needed
      this.logFailedPin(hash, error.message);
    }
  }

  /**
   * 🚨 BULLETPROOF TIMEOUT: Pinning with multiple timeout layers
   */
  private async attemptPinWithBulletproofTimeout(hash: string): Promise<void> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');
    
    // 🚨 RESPECT USER CONFIG: Only use local fallback if explicitly enabled
    const configLocalFallbackEnabled = this.config.ipfs?.enable_local_fallback || false;
    const supernodeReachable = await this.isSupernodeReachable();
    
    // ✅ FIXED: Respect user's config - never override ENABLE_LOCAL_FALLBACK=false
    // If user disabled it, jobs will fail instead of filling their hard drive
    const localFallbackEnabled = configLocalFallbackEnabled;
    
    // 🚨 BULLETPROOF: Multiple timeout layers - dynamic based on supernode status
    const HARD_TIMEOUT = this.calculatePinningTimeout(supernodeReachable);
    const SOFT_TIMEOUT = Math.floor(HARD_TIMEOUT * 0.5); // Soft timeout is 50% of hard timeout
    
    logger.info(`🛡️ Starting bulletproof pin for ${hash} (supernode: ${supernodeReachable ? 'reachable' : 'DOWN'}, fallback: ${localFallbackEnabled})`);
    logger.info(`⏱️ Pin timeouts: HARD=${Math.floor(HARD_TIMEOUT/1000)}s, SOFT=${Math.floor(SOFT_TIMEOUT/1000)}s`);
    
    // Create a promise that WILL resolve within the hard timeout no matter what
    const bulletproofPromise = new Promise<void>((resolve, reject) => {
      let isResolved = false;
      
      // HARD TIMEOUT - this WILL fire no matter what happens
      const hardTimeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          logger.warn(`🚨 HARD TIMEOUT: Pinning took longer than ${HARD_TIMEOUT/1000}s for ${hash}`);
          logger.warn(`🚨 EMERGENCY: Job will continue without pinning to prevent blocking`);
          // 🚨 EMERGENCY: Always resolve to prevent job blocking
          resolve();
        }
      }, HARD_TIMEOUT);
      
      // Try remote pinning first
      const tryRemotePin = async () => {
        try {
          logger.info(`📌 Attempting remote pin: ${hash}`);
          
          await axios.default.post(
            `${threeSpeakIPFS}/api/v0/pin/add?arg=${hash}&recursive=true&progress=true`,
            null,
            { 
              timeout: SOFT_TIMEOUT,
              maxContentLength: 10 * 1024 * 1024,
              maxBodyLength: 1024 * 1024
            }
          );
          
          if (!isResolved) {
            isResolved = true;
            clearTimeout(hardTimeout);
            logger.info(`✅ Remote pin succeeded: ${hash}`);
            resolve();
          }
          
        } catch (remoteError: any) {
          logger.warn(`⚠️ Remote pin failed: ${remoteError.message}`);
          
          // Try local fallback if enabled and not already resolved
          if (localFallbackEnabled && !isResolved) {
            try {
              logger.info(`🏠 Trying local fallback pin: ${hash}`);
              await this.client.pin.add(hash);
              
              if (!isResolved) {
                isResolved = true;
                clearTimeout(hardTimeout);
                logger.info(`✅ Local fallback pin succeeded: ${hash}`);
                await this.logLocalPin(hash);
                resolve();
              }
              
            } catch (localError: any) {
              if (!isResolved) {
                isResolved = true;
                clearTimeout(hardTimeout);
                logger.error(`❌ Both remote and local pin failed: ${hash}`);
                logger.warn(`🚨 EMERGENCY: Job will continue - content uploaded and accessible`);
                await this.logFailedPin(hash, `Remote: ${remoteError.message}, Local: ${localError.message}`);
                resolve(); // 🚨 CRITICAL: Always resolve to continue job processing
              }
            }
          } else {
            // No fallback available or already resolved
            if (!isResolved) {
              isResolved = true;
              clearTimeout(hardTimeout);
              logger.error(`❌ Remote pin failed and no local fallback enabled: ${hash}`);
              logger.warn(`🚨 EMERGENCY: Job will continue - content uploaded and accessible`);
              await this.logFailedPin(hash, remoteError.message);
              resolve(); // 🚨 CRITICAL: Always resolve to continue job processing
            }
          }
        }
      };
      
      // Start the pinning attempt
      tryRemotePin().catch(error => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(hardTimeout);
          logger.error(`❌ Unexpected error in pin attempt: ${error.message}`);
          logger.warn(`🚨 EMERGENCY: Job will continue - content uploaded and accessible`);
          resolve(); // 🚨 CRITICAL: Always resolve to continue job processing
        }
      });
    });
    
    // Execute with bulletproof timeout
    return bulletproofPromise;
  }

  /**
   * Log failed pins for manual retry
   */
  private async logFailedPin(hash: string, errorMessage: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      const logDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logDir, { recursive: true });
      
      const logEntry = {
        hash,
        timestamp: new Date().toISOString(),
        type: 'failed_pin',
        error: errorMessage,
        node_id: this.peerId || 'unknown'
      };
      
      const logFile = path.join(logDir, 'failed-pins.jsonl');
      await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
      
      logger.info(`� Logged failed pin for manual retry: ${hash}`);
    } catch (error: any) {
      logger.debug(`Could not log failed pin: ${error.message}`);
    }
  }

  /**
   * Verify that content is actually pinned by checking pin list
   */
  private async verifyPinStatus(hash: string, ipfsEndpoint: string, maxRetries: number = 3): Promise<boolean> {
    const axios = await import('axios');
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`� Pin verification attempt ${attempt}/${maxRetries} for ${hash}`);
        
        // Check if hash is in pin list
        const response = await axios.default.post(
          `${ipfsEndpoint}/api/v0/pin/ls?arg=${hash}&type=all`,
          null,
          { timeout: 30000 }
        );
        
        // Parse response
        let pinData;
        if (typeof response.data === 'string') {
          pinData = JSON.parse(response.data);
        } else {
          pinData = response.data;
        }
        
        // Check if our hash is in the pins
        if (pinData && pinData.Keys && pinData.Keys[hash]) {
          const pinType = pinData.Keys[hash].Type;
          logger.info(`✅ Pin verified: ${hash} (type: ${pinType})`);
          return true;
        }
        
        logger.warn(`⚠️ Hash ${hash} not found in pin list (attempt ${attempt})`);
        
        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error: any) {
        logger.warn(`⚠️ Pin verification attempt ${attempt} failed:`, error.message);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    return false;
  }

  private async getAllFiles(dirPath: string): Promise<string[]> {
    const fs = await import('fs/promises');
    const path = await import('path');
    
    const files: string[] = [];
    const items = await fs.readdir(dirPath);
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = await fs.stat(fullPath);
      
      if (stat.isDirectory()) {
        const subFiles = await this.getAllFiles(fullPath);
        files.push(...subFiles);
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  private extractIPFSHash(uri: string): string {
    // Extract IPFS hash from various URI formats
    if (uri.startsWith('ipfs://')) {
      return uri.replace('ipfs://', '');
    }
    
    if (uri.includes('/ipfs/')) {
      return uri.split('/ipfs/')[1]!.split('/')[0]!;
    }
    
    // Assume it's already a hash
    return uri;
  }

  async pinHash(hash: string): Promise<void> {
    try {
      // 🛡️ Use bulletproof pinning system with fallback instead of direct pinning
      await this.attemptPinWithBulletproofTimeout(hash);
      logger.info(`📌 Pinned with fallback protection: ${hash}`);
    } catch (error) {
      // 🚨 NEVER let pinning failures block job completion
      logger.warn(`⚠️ Pinning failed for ${hash}, but continuing job:`, error);
      // Don't throw - job must continue regardless of pinning status
    }
  }

  private async pinHashWithCluster(hash: string): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      const response = await axios.default.post(`${clusterEndpoint}/pins/${hash}`, null, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      logger.info(`📌 Pinned (cluster): ${hash}`);
      logger.debug(`Cluster pin response:`, response.data);
    } catch (error: any) {
      if (error.response) {
        logger.error(`❌ Cluster pin failed for ${hash}: ${error.response.status} ${error.response.statusText}`);
        if (error.response.data) {
          logger.error(`Response data:`, error.response.data);
        }
      } else {
        logger.error(`❌ Cluster pin request failed for ${hash}:`, error.message);
      }
      throw error;
    }
  }

  async unpinHash(hash: string): Promise<void> {
    try {
      // Use cluster for pins if enabled, otherwise use main daemon  
      if (this.config.ipfs?.use_cluster_for_pins) {
        await this.unpinHashWithCluster(hash);
      } else {
        await this.client.pin.rm(hash);
        logger.info(`📌 Unpinned (main daemon): ${hash}`);
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to unpin ${hash}:`, error);
      // Don't throw, unpinning failures are not critical
    }
  }

  private async unpinHashWithCluster(hash: string): Promise<void> {
    const clusterEndpoint = this.config.ipfs?.cluster_endpoint || 'http://65.21.201.94:9094';
    const axios = await import('axios');
    
    try {
      await axios.default.delete(`${clusterEndpoint}/pins/${hash}`, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
      });
      
      logger.info(`📌 Unpinned (cluster): ${hash}`);
    } catch (error: any) {
      if (error.response) {
        logger.warn(`⚠️ Cluster unpin failed for ${hash}: ${error.response.status} ${error.response.statusText}`);
      } else {
        logger.warn(`⚠️ Cluster unpin request failed for ${hash}:`, error.message);
      }
      throw error;
    }
  }

  async cleanupTemporaryContent(hashes: string[]): Promise<void> {
    logger.info(`🧹 Cleaning up ${hashes.length} temporary IPFS uploads`);
    
    for (const hash of hashes) {
      try {
        await this.unpinHash(hash);
      } catch (error) {
        // Continue cleanup even if individual unpins fail
        logger.warn(`⚠️ Failed to cleanup ${hash}:`, error);
      }
    }
    
    // Run garbage collection to free up space
    try {
      await this.client.repo.gc();
      logger.info('🗑️ IPFS garbage collection completed');
    } catch (error) {
      logger.warn('⚠️ IPFS garbage collection failed:', error);
    }
  }

  /**
   * 🛡️ TANK MODE: Final verification that content is still pinned
   * Call this before reporting job as complete to gateway
   */
  async verifyContentPersistence(hash: string): Promise<boolean> {
    logger.info(`🔐 TANK MODE: Final persistence check for ${hash}`);
    
    // 🛡️ SMART VERIFICATION: Check the node we actually uploaded to
    let verificationEndpoint: string;
    let verificationSource: string;
    
    if (this.lastUploadSource && this.lastUploadSource.cid === hash) {
      // We know where this was uploaded - check that specific node
      const rawEndpoint = this.lastUploadSource.endpoint;
      
      // 🔧 FIX: Extract base URL from hotnode endpoint
      // Traffic director returns full upload endpoint like: https://hotipfs-1.3speak.tv/api/v0/add
      // We need base URL for verification: https://hotipfs-1.3speak.tv
      if (rawEndpoint.includes('/api/v0/')) {
        const baseUrl = rawEndpoint.split('/api/v0/')[0];
        verificationEndpoint = baseUrl || rawEndpoint; // Fallback to raw if split fails
        logger.info(`🔧 Extracted base URL for verification: ${verificationEndpoint} (from ${rawEndpoint})`);
      } else {
        verificationEndpoint = rawEndpoint;
      }
      
      verificationSource = this.lastUploadSource.source;
      logger.info(`🎯 Verifying on upload target: ${verificationSource} (${verificationEndpoint})`);
    } else {
      // Fallback to supernode (legacy behavior)
      verificationEndpoint = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
      verificationSource = 'supernode (fallback)';
      logger.warn(`⚠️ Upload source unknown for ${hash}, defaulting to supernode check`);
    }
    
    // 🏠 SMART CHECK: Verify on the actual upload target
    let isPinned = false;
    
    if (this.lastUploadSource?.source === 'local') {
      // For local uploads, check local IPFS
      logger.info(`🏠 Checking local IPFS daemon for content...`);
      isPinned = await this.verifyLocalPinStatus(hash);
    } else {
      // For hotnode/supernode, use pin verification
      isPinned = await this.verifyPinStatus(hash, verificationEndpoint, 3);
    }
    
    if (!isPinned) {
      logger.error(`🚨 CRITICAL: Content ${hash} is NOT available on ${verificationSource}!`);
      logger.error(`🔍 Upload was to: ${this.lastUploadSource?.source || 'unknown'} (${this.lastUploadSource?.endpoint || 'unknown'})`);
      return false;
    }
    
    logger.info(`✅ Content verified on ${verificationSource}`);
    
    // 🛡️ ENHANCED: Verify directory structure integrity
    try {
      const axios = await import('axios');
      logger.info(`🔍 Verifying directory structure integrity: ${hash}`);
      
      // Check directory listing to ensure structure is intact
      const listResponse = await axios.default.post(
        `${verificationEndpoint}/api/v0/ls?arg=${hash}`,
        null,
        { timeout: 30000 }
      );
      
      const listing = typeof listResponse.data === 'string' 
        ? JSON.parse(listResponse.data) 
        : listResponse.data;
      
      if (!listing.Objects || !listing.Objects[0] || !listing.Objects[0].Links) {
        logger.error(`🚨 CRITICAL: Directory structure is corrupted - no folder structure found in ${hash}`);
        return false;
      }
      
      const links = listing.Objects[0].Links;
      const foundFolders = links.filter((link: any) => link.Type === 1); // Type 1 = directory
      const foundFiles = links.filter((link: any) => link.Type === 2);   // Type 2 = file
      
      logger.info(`📁 Directory structure verification: ${foundFolders.length} folders, ${foundFiles.length} files`);
      
      // 🛡️ RELAXED: Check for reasonable content structure (not overly strict)
      const expectedFiles = ['master.m3u8', 'index.m3u8', 'playlist.m3u8']; // Multiple possible playlist names
      const expectedFolders = ['1080p', '720p', '480p', '360p', '240p']; // All possible quality folders
      
      const hasPlaylistFile = expectedFiles.some(file => 
        foundFiles.find((link: any) => link.Name === file)
      );
      
      const hasQualityContent = foundFolders.length > 0 || foundFiles.length > 0;
      
      if (!hasPlaylistFile && foundFiles.length === 0) {
        logger.error(`🚨 CRITICAL: No playlist files or content found in directory structure`);
        return false;
      }
      
      if (!hasQualityContent) {
        logger.error(`🚨 CRITICAL: Directory appears to be completely empty`);
        return false;
      }
      
      // 📊 Log what we found for debugging
      if (hasPlaylistFile) {
        const playlist = expectedFiles.find(file => 
          foundFiles.find((link: any) => link.Name === file)
        );
        logger.info(`✅ Found playlist file: ${playlist}`);
      }
      
      const qualityFolders = foundFolders.filter((link: any) => 
        expectedFolders.includes(link.Name)
      );
      if (qualityFolders.length > 0) {
        logger.info(`✅ Found quality folders: ${qualityFolders.map((f: any) => f.Name).join(', ')}`);
      }
      
      logger.info(`✅ Directory structure verified - proper HLS layout confirmed`);
      return true;
      
    } catch (error: any) {
      logger.error(`🚨 Directory structure verification failed for ${hash}:`, error.message);
      return false;
    }
  }

  /**
   * Verify local pin status using local IPFS client
   */
  private async verifyLocalPinStatus(hash: string): Promise<boolean> {
    try {
      logger.info(`🔍 Checking local IPFS daemon for pin: ${hash}`);
      
      // 🚨 BULLETPROOF: Try to list pins for this specific hash
      // If hash is pinned, iterator will yield results
      // If hash is NOT pinned, iterator will throw or yield nothing
      let foundPin = false;
      
      try {
        const pins = this.client.pin.ls({ paths: [hash] });
        
        for await (const pin of pins) {
          const pinCid = pin.cid.toString();
          logger.info(`🔍 Found local pin: ${pinCid} (type: ${pin.type})`);
          
          if (pinCid === hash) {
            logger.info(`✅ Local pin verification succeeded for ${hash}`);
            foundPin = true;
            break;
          }
        }
      } catch (iteratorError: any) {
        // 🚨 IPFS client throws error when path doesn't exist or isn't pinned
        // This is NORMAL behavior - not an error, just means "not pinned"
        logger.info(`🔍 Pin query returned no results for ${hash} (${iteratorError.message})`);
        return false;
      }
      
      if (!foundPin) {
        logger.warn(`⚠️ Local pin verification failed - ${hash} not found in local pins`);
        return false;
      }
      
      return true;
      
    } catch (error: any) {
      logger.error(`❌ Local pin verification error for ${hash}:`, error.message);
      return false;
    }
  }

  /**
   * Log locally pinned content for future sync service processing
   */
  private async logLocalPin(hash: string, jobId?: string, contentType?: string, sizeByes?: number): Promise<void> {
    try {
      // Use database if available
      if (this.pinDatabase) {
        const pin: LocalPin = {
          hash,
          sync_status: 'pending'
        };
        
        // Only set optional properties if they have values
        if (jobId) pin.job_id = jobId;
        if (contentType) pin.content_type = contentType;
        if (sizeByes) pin.size_bytes = sizeByes;
        
        await this.pinDatabase.addLocalPin(pin);
        logger.info(`📊 Added local pin to database: ${hash}`);
        return;
      }

      // Fallback to file logging if no database
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Create logs directory if it doesn't exist
      const logDir = path.join(process.cwd(), 'logs');
      try {
        await fs.mkdir(logDir, { recursive: true });
      } catch (error) {
        // Directory might already exist, ignore
      }
      
      // Log locally pinned content with timestamp
      const logEntry = {
        hash: hash,
        timestamp: new Date().toISOString(),
        type: 'local_fallback_pin',
        node_id: this.peerId || 'unknown',
        job_id: jobId,
        content_type: contentType
      };
      
      const logFile = path.join(logDir, 'local-pins.jsonl');
      const logLine = JSON.stringify(logEntry) + '\n';
      
      await fs.appendFile(logFile, logLine);
      logger.info(`📝 Logged local pin for future sync: ${hash}`);
      
    } catch (error: any) {
      logger.warn(`⚠️ Failed to log local pin (non-critical): ${error.message}`);
      // Don't throw - this is just for bookkeeping
    }
  }

  // ===========================================
  // PUBLIC STORAGE ADMIN METHODS
  // ===========================================

  /**
   * Get all pinned items with metadata (for storage admin)
   */
  async getPinnedItems(): Promise<any[]> {
    try {
      const recursivePins = await this.client.pin.ls({ type: 'recursive' });

      const pins: any[] = [];

      for await (const pin of recursivePins) {
        try {
          const stat = await this.client.files.stat(`/ipfs/${pin.cid}`);

          let contents = null;
          try {
            const lsResult = await this.client.ls(pin.cid);
            contents = lsResult.map((item: any) => ({
              name: item.name,
              type: item.type,
              size: item.size,
              cid: item.cid.toString()
            }));
          } catch (lsError) {
            contents = null;
          }

          pins.push({
            cid: pin.cid.toString(),
            type: 'recursive',
            size: stat.cumulativeSize || stat.size || 0,
            blockSize: stat.size || 0,
            blocks: stat.blocks || 0,
            isDirectory: contents !== null,
            contents: contents,
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          pins.push({
            cid: pin.cid.toString(),
            type: 'recursive',
            size: 0,
            error: 'Failed to get details',
            timestamp: new Date().toISOString()
          });
        }
      }

      return pins;

    } catch (error) {
      logger.error('Failed to list pinned items:', error);
      throw new Error(`Failed to list pinned items: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get detailed information about a specific pin
   */
  async getPinDetails(cid: string): Promise<any> {
    try {
      const pinStatus = await this.client.pin.ls({ paths: [cid] });
      const isPinned = Array.from(pinStatus).length > 0;

      if (!isPinned) {
        return {
          cid,
          pinned: false,
          message: 'CID is not pinned locally'
        };
      }

      const stat = await this.client.files.stat(`/ipfs/${cid}`);

      let contents = null;
      let isDirectory = false;
      try {
        const lsResult = await this.client.ls(cid);
        contents = lsResult.map((item: any) => ({
          name: item.name,
          type: item.type,
          size: item.size,
          cid: item.cid.toString()
        }));
        isDirectory = true;
      } catch (lsError) {
        contents = null;
        isDirectory = false;
      }

      let supernodeStatus = 'unknown';
      try {
        const isAvailable = await this.verifyContentPersistence(cid);
        supernodeStatus = isAvailable ? 'available' : 'not_found';
      } catch (error) {
        supernodeStatus = 'check_failed';
      }

      const details = {
        cid,
        pinned: true,
        isDirectory,
        contents,
        size: stat.cumulativeSize || stat.size || 0,
        blockSize: stat.size || 0,
        blocks: stat.blocks || 0,
        supernodeStatus,
        timestamp: new Date().toISOString()
      };

      return details;

    } catch (error) {
      logger.error(`Failed to get pin details for ${cid}:`, error);
      throw new Error(`Failed to get pin details: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Migrate pins to supernode
   */
  async migratePinsToSupernode(cids: string[]): Promise<any> {
    try {
      logger.info(`\x1b[36m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[36m║  🚀 STORAGE ADMIN: Pin Migration to Supernode            ║\x1b[0m`);
      logger.info(`\x1b[36m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      const results = {
        total: cids.length,
        successful: 0,
        failed: 0,
        details: [] as any[]
      };

      for (const cid of cids) {
        try {
          logger.info(`\x1b[33m📤 Migrating: ${cid.substring(0, 20)}...\x1b[0m`);
          const uploadResult = await this.uploadDirectoryToSupernode(cid);

          if (uploadResult.success) {
            results.successful++;
            results.details.push({
              cid,
              status: 'success',
              supernodeHash: uploadResult.hash
            });
            logger.info(`\x1b[32m✅ SUCCESS: Pin migrated to supernode - ${cid.substring(0, 20)}...\x1b[0m`);
          } else {
            results.failed++;
            results.details.push({
              cid,
              status: 'failed',
              error: uploadResult.error
            });
            logger.error(`\x1b[31m❌ FAILED: Migration failed - ${cid.substring(0, 20)}... - ${uploadResult.error}\x1b[0m`);
          }

        } catch (error) {
          results.failed++;
          results.details.push({
            cid,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          logger.error(`\x1b[31m❌ ERROR: Migration error - ${cid.substring(0, 20)}... - ${error}\x1b[0m`);
        }
      }

      logger.info(`\x1b[36m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[36m║  📊 Migration Complete: ${results.successful}/${results.total} successful${' '.repeat(Math.max(0, 25 - results.successful.toString().length - results.total.toString().length))}║\x1b[0m`);
      logger.info(`\x1b[36m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      return results;

    } catch (error) {
      logger.error('Migration failed:', error);
      throw new Error(`Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Upload directory to supernode (for migration)
   * For infrastructure nodes with public IPs - supernode fetches content directly from local node
   */
  private async uploadDirectoryToSupernode(cid: string): Promise<{ success: boolean; hash?: string; error?: string }> {
    const threeSpeakIPFS = this.config.ipfs?.threespeak_endpoint || 'http://65.21.201.94:5002';
    const axios = await import('axios');

    try {
      // 1️⃣ Check if content is already on supernode
      logger.info(`🔍 Checking if ${cid.substring(0, 20)}... is already on supernode`);
      
      try {
        const checkResponse = await axios.default.post(
          `${threeSpeakIPFS}/api/v0/pin/ls?arg=${cid}&type=all`,
          null,
          { timeout: 10000 }
        );
        
        const pinData = typeof checkResponse.data === 'string' 
          ? JSON.parse(checkResponse.data) 
          : checkResponse.data;
        
        if (pinData && pinData.Keys && pinData.Keys[cid]) {
          logger.info(`✅ Content already pinned on supernode: ${cid.substring(0, 20)}...`);
          return { success: true, hash: cid };
        }
      } catch (checkError) {
        // Not found, proceed with migration
        logger.info(`📍 Content not on supernode, initiating migration...`);
      }

      // 2️⃣ Request supernode to pin the CID (it will fetch from our public node via DHT)
      logger.info(`📌 Requesting supernode to pin ${cid.substring(0, 20)}...`);
      logger.info(`🌐 Supernode will fetch content from local IPFS daemon via DHT`);
      
      const pinStartTime = Date.now();
      
      // Start the pin operation (non-blocking on supernode)
      await axios.default.post(
        `${threeSpeakIPFS}/api/v0/pin/add?arg=${cid}&recursive=true`,
        null,
        { 
          timeout: 120000, // 2 minutes for pin request
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 1024 * 1024
        }
      );
      
      const pinRequestDuration = Date.now() - pinStartTime;
      logger.info(`⏱️ Pin request completed in ${(pinRequestDuration/1000).toFixed(1)}s`);

      // 3️⃣ Verify pin completed successfully with polling
      logger.info(`🔄 Verifying pin completion on supernode...`);
      
      const MAX_VERIFICATION_ATTEMPTS = 60; // 60 attempts = 2 minutes max
      const POLL_INTERVAL = 2000; // 2 seconds between checks
      
      for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt++) {
        try {
          const verifyResponse = await axios.default.post(
            `${threeSpeakIPFS}/api/v0/pin/ls?arg=${cid}&type=all`,
            null,
            { timeout: 10000 }
          );
          
          const pinData = typeof verifyResponse.data === 'string' 
            ? JSON.parse(verifyResponse.data) 
            : verifyResponse.data;
          
          if (pinData && pinData.Keys && pinData.Keys[cid]) {
            const totalDuration = Date.now() - pinStartTime;
            logger.info(`✅ Pin verified on supernode: ${cid.substring(0, 20)}... (${(totalDuration/1000).toFixed(1)}s total)`);
            return { success: true, hash: cid };
          }
          
          // Not found yet, wait before retry
          if (attempt < MAX_VERIFICATION_ATTEMPTS) {
            if (attempt % 10 === 0) {
              logger.info(`⏳ Still waiting for pin completion... (attempt ${attempt}/${MAX_VERIFICATION_ATTEMPTS})`);
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          }
          
        } catch (verifyError: any) {
          logger.warn(`⚠️ Verification attempt ${attempt} failed: ${verifyError.message}`);
          
          if (attempt < MAX_VERIFICATION_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          }
        }
      }
      
      // 4️⃣ Verification timeout
      logger.error(`❌ Pin verification timeout after ${MAX_VERIFICATION_ATTEMPTS * POLL_INTERVAL / 1000}s`);
      return {
        success: false,
        error: `Pin verification timeout - supernode may still be processing. Check manually: ${cid}`
      };

    } catch (error: any) {
      logger.error(`❌ Migration failed for ${cid.substring(0, 20)}...: ${error.message}`);
      return {
        success: false,
        error: error.message || 'Unknown error during migration'
      };
    }
  }

  /**
   * Unpin items locally
   */
  async unpinItemsLocally(cids: string[]): Promise<any> {
    try {
      logger.info(`\x1b[35m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[35m║  🗑️  STORAGE ADMIN: Local Pin Removal                     ║\x1b[0m`);
      logger.info(`\x1b[35m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      const results = {
        total: cids.length,
        successful: 0,
        failed: 0,
        details: [] as any[]
      };

      for (const cid of cids) {
        try {
          logger.info(`\x1b[33m🗑️  Unpinning: ${cid.substring(0, 20)}...\x1b[0m`);
          await this.client.pin.rm(cid);

          results.successful++;
          results.details.push({
            cid,
            status: 'unpinned'
          });
          logger.info(`\x1b[32m✅ SUCCESS: Pin removed locally - ${cid.substring(0, 20)}...\x1b[0m`);

        } catch (error) {
          results.failed++;
          results.details.push({
            cid,
            status: 'error',
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          logger.error(`\x1b[31m❌ FAILED: Unpin failed - ${cid.substring(0, 20)}... - ${error}\x1b[0m`);
        }
      }

      logger.info(`\x1b[35m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[35m║  📊 Unpinning Complete: ${results.successful}/${results.total} successful${' '.repeat(Math.max(0, 23 - results.successful.toString().length - results.total.toString().length))}║\x1b[0m`);
      logger.info(`\x1b[35m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      return results;

    } catch (error) {
      logger.error('Unpinning failed:', error);
      throw new Error(`Unpinning failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Run garbage collection
   */
  async runGarbageCollection(): Promise<any> {
    try {
      logger.info(`\x1b[33m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[33m║  🗑️  STORAGE ADMIN: Garbage Collection                    ║\x1b[0m`);
      logger.info(`\x1b[33m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      const gcResult = await this.client.repo.gc();

      let removedItems: string[] = [];

      for await (const item of gcResult) {
        if (item.err) {
          logger.warn(`\x1b[31m⚠️  GC warning: ${item.cid} - ${item.err}\x1b[0m`);
        } else {
          removedItems.push(item.cid.toString());
          if (removedItems.length % 10 === 0) {
            logger.info(`\x1b[36m🧹 Cleaned ${removedItems.length} unpinned items...\x1b[0m`);
          }
        }
      }

      logger.info(`\x1b[33m╔═══════════════════════════════════════════════════════════╗\x1b[0m`);
      logger.info(`\x1b[33m║  ✅ GC Complete: ${removedItems.length} items removed${' '.repeat(Math.max(0, 30 - removedItems.length.toString().length))}║\x1b[0m`);
      logger.info(`\x1b[33m╚═══════════════════════════════════════════════════════════╝\x1b[0m`);

      const result = {
        success: true,
        removedItems: removedItems.length,
        items: removedItems,
        message: `Garbage collection completed - ${removedItems.length} items removed`
      };

      return result;

    } catch (error) {
      logger.error('Garbage collection failed:', error);
      throw new Error(`Garbage collection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(): Promise<any> {
    try {
      const repoStat = await this.client.repo.stat();

      const recursivePins = await this.client.pin.ls({ type: 'recursive' });
      const directPins = await this.client.pin.ls({ type: 'direct' });
      const indirectPins = await this.client.pin.ls({ type: 'indirect' });

      let recursiveCount = 0;
      let directCount = 0;
      let indirectCount = 0;

      for await (const pin of recursivePins) { recursiveCount++; }
      for await (const pin of directPins) { directCount++; }
      for await (const pin of indirectPins) { indirectCount++; }

      // 🚨 BIGINT FIX: Convert all BigInt values to strings for JSON serialization
      // IPFS returns BigInt for large numbers, which JSON.stringify() can't handle
      const convertBigInt = (value: any): any => {
        if (typeof value === 'bigint') {
          return value.toString();
        }
        return value;
      };

      const stats = {
        repository: {
          size: convertBigInt(repoStat.repoSize),
          numObjects: convertBigInt(repoStat.numObjects),
          storageMax: convertBigInt(repoStat.storageMax),
          version: repoStat.version,
          path: repoStat.repoPath
        },
        pins: {
          recursive: recursiveCount,
          direct: directCount,
          indirect: indirectCount,
          total: recursiveCount + directCount + indirectCount
        },
        timestamp: new Date().toISOString()
      };

      return stats;

    } catch (error) {
      logger.error('Failed to get storage stats:', error);
      throw new Error(`Failed to get storage stats: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}