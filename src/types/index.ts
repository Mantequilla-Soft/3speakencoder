// Job related types
export interface VideoJob {
  id: string;
  type?: 'gateway'; // Job type identifier
  status: JobStatus;
  created_at: string;
  updated_at?: string;
  input: {
    uri: string;
    size: number;
    format?: string;
  };
  metadata: {
    video_owner: string;
    video_permlink: string;
  };
  storageMetadata: {
    app: string;
    key: string;
    type: string;
  };
  profiles: VideoProfile[];
  output: EncodedOutput[];
  progress?: number;
  download_pct?: number;
  result?: EncodedOutput[]; // For consistency with DirectJob
  error?: string; // For error tracking
  
  // 🎬 Direct API short video support
  short?: boolean;              // Enable short video mode (480p only, 60s max)
  
  // 🔔 Webhook callback support (Direct API only)
  webhook_url?: string;         // URL to POST completion notification
  api_key?: string;             // API key for webhook authentication
  originalFilename?: string;    // Original filename for tracking
  
  // 🎯 Gateway auto-assignment support (February 2026)
  assigned_to?: string | null;  // DID of encoder assigned to this job
  assigned_date?: string;       // Timestamp when job was assigned
}

export interface VideoProfile {
  name: string;
  size: string; // e.g., "?x1080", "?x720", "?x480"
  width?: number;
  height?: number;
  bitrate?: string;
}

export interface EncodedOutput {
  profile: string;
  path: string;
  size: number;
  duration: number;
  segments: string[];
  playlist: string;
  ipfsHash?: string;  // IPFS hash of the uploaded directory
  uri?: string;       // IPFS URI pointing to the playlist
}

export enum JobStatus {
  PENDING = 'pending',
  QUEUED = 'queued', 
  ASSIGNED = 'assigned',
  DOWNLOADING = 'downloading',
  RUNNING = 'running',
  UPLOADING = 'uploading',
  COMPLETE = 'complete',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

// Gateway API types
export interface GatewayJobResponse {
  data: {
    queueJob: {
      reason: string;
      job: VideoJob;
    };
  };
}

export interface NodeInfo {
  name: string;
  cryptoAccounts: {
    hive: string;
  };
  peer_id: string;
  commit_hash: string;
}

export interface JWSPayload {
  node_info: NodeInfo;
}

// Encoder types
export interface CodecCapability {
  name: string;
  type: 'hardware' | 'software';
  available: boolean;
  tested: boolean;
  priority: number;
}

export interface EncodingProgress {
  jobId: string;
  profile: string;
  percent: number;
  fps?: number;
  bitrate?: string;
  eta?: string;
}

export interface SystemCapabilities {
  ffmpeg: {
    version: string;
    codecs: CodecCapability[];
  };
  hardware: {
    gpu: boolean;
    qsv: boolean;
    nvenc: boolean;
    vaapi: boolean;
  };
  system: {
    cpu_cores: number;
    memory_gb: number;
    os: string;
  };
}

// File probe types for intelligent encoding
export interface FileProbeResult {
  container: string;              // 'mov', 'mp4', 'avi', 'mkv'
  videoCodec: string;            // 'hevc', 'h264', 'prores', 'vp9'
  audioCodec: string;            // 'aac', 'ac3', 'pcm', 'opus'
  pixelFormat: string;           // 'yuv420p', 'yuv420p10le', 'yuv422p'
  bitDepth: number;              // 8, 10, 12
  colorSpace?: string;           // 'bt709', 'bt2020', 'smpte170m'
  colorTransfer?: string;        // 'bt709', 'smpte2084' (HDR), 'arib-std-b67' (HLG)
  hdrMetadata: boolean;          // Dolby Vision, HDR10, HDR10+
  rotationDegrees: number;       // 0, 90, 180, 270 - iPhone/mobile rotation
  resolution: {
    width: number;
    height: number;
  };
  framerate: number;
  duration: number;
  bitrate?: number;
  videoStreamCount: number;
  audioStreamCount: number;
  extraStreams: StreamInfo[];    // Non-video/audio streams (metadata, subtitles, etc.)
  issues: ProbeIssue[];          // Detected compatibility issues
  rawMetadata?: any;             // Full ffprobe output for debugging
}

export interface StreamInfo {
  index: number;
  type: string;                  // 'data', 'subtitle', 'attachment'
  codec?: string;
  tags?: Record<string, string>;
}

export interface ProbeIssue {
  severity: 'warning' | 'error' | 'info';
  type: string;                  // 'unsupported_codec', 'extra_streams', 'hdr_metadata', etc.
  message: string;
  suggestion?: string;           // How to fix it
}

export interface EncodingStrategy {
  inputOptions: string[];        // Pre-processing flags (e.g., -hwaccel)
  mapOptions: string[];          // Stream selection (e.g., -map 0:v:0 -map 0:a:0)
  videoFilters: string[];        // Pixel format conversion, scaling
  codecPriority: string[];       // Preferred codecs for this input type
  extraOptions: string[];        // Additional ffmpeg flags
  reason: string;                // Why this strategy was chosen (for logging)
}

// Re-export DirectApi types
export * from './DirectApi.js';

// Re-export DirectApi types
export * from './DirectApi.js';