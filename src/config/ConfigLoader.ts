import { z } from 'zod';
import { config } from 'dotenv';

// Load environment variables from .env files (in priority order)
config({ path: '.env.local' }); // Load .env.local first (highest priority)
config({ path: '.env' });       // Then .env (fallback)

// Configuration schema validation
const ConfigSchema = z.object({
  node: z.object({
    name: z.string(),
    privateKey: z.string().optional(),
    publicKey: z.string().optional(),
    cryptoAccounts: z.object({
      hive: z.string()
    }).optional()
  }),
  gateway_client: z.object({
    gateway_url: z.string().url(),
    queue_max_length: z.number().default(1),
    queue_concurrency: z.number().default(1),
    async_uploads: z.boolean().default(false)
  }).optional(),
  remote_gateway: z.object({
    enabled: z.boolean(),
    api: z.string().url()
  }),
  ipfs: z.object({
    apiAddr: z.string().default('/ip4/127.0.0.1/tcp/5001'), // For downloads only
    threespeak_endpoint: z.string().default('http://65.21.201.94:5002'), // Direct upload endpoint
    traffic_director_url: z.string().url().default('https://cdn.3speak.tv/api/hotnode'), // Hotnode traffic director
    cluster_endpoint: z.string().default('http://65.21.201.94:9094'), // Cluster API for pins
    use_cluster_for_pins: z.boolean().default(false), // Use cluster instead of main daemon for pins
    enable_local_fallback: z.boolean().default(false), // Pin locally if remote fails
    local_fallback_threshold: z.number().default(3), // Retry attempts before falling back to local
    remove_local_after_sync: z.boolean().default(true) // Remove local pins after successful sync
  }).optional(),
  encoder: z.object({
    temp_dir: z.string().optional(),
    ffmpeg_path: z.string().optional(),
    hardware_acceleration: z.boolean().default(true),
    max_concurrent_jobs: z.number().default(1)
  }).optional(),
  direct_api: z.object({
    enabled: z.boolean().default(false),
    port: z.number().default(3002),
    api_key: z.string().optional()
  }).optional(),
  mongodb: z.object({
    enabled: z.boolean().default(false),
    uri: z.string().optional(),
    database_name: z.string().optional(),
    connection_timeout: z.number().default(10000),
    socket_timeout: z.number().default(30000)
  }).optional(),
  gateway_aid: z.object({
    enabled: z.boolean().default(false),
    base_url: z.string().url().optional()
  }).optional(),
  storage_admin: z.object({
    password: z.string().optional()
  }).optional()
});

export type EncoderConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<EncoderConfig> {
  try {
    // Build configuration from environment variables
    const configData = {
      node: {
        name: process.env.NODE_NAME || '3speak-encoder-node',
        privateKey: process.env.ENCODER_PRIVATE_KEY,
        publicKey: process.env.ENCODER_PUBLIC_KEY,
        cryptoAccounts: {
          hive: process.env.HIVE_USERNAME || ''
        }
      },
      gateway_client: {
        gateway_url: process.env.GATEWAY_URL || 'https://encoder-gateway.infra.3speak.tv',
        queue_max_length: parseInt(process.env.QUEUE_MAX_LENGTH || '1'),
        queue_concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '1'),
        async_uploads: process.env.ASYNC_UPLOADS === 'true'
      },
      remote_gateway: {
        enabled: process.env.REMOTE_GATEWAY_ENABLED !== 'false',
        api: process.env.GATEWAY_URL || 'https://encoder-gateway.infra.3speak.tv'
      },
      ipfs: {
        apiAddr: process.env.IPFS_API_ADDR || '/ip4/127.0.0.1/tcp/5001',
        threespeak_endpoint: process.env.THREESPEAK_IPFS_ENDPOINT || 'http://65.21.201.94:5002',
        traffic_director_url: process.env.TRAFFIC_DIRECTOR_URL || 'https://cdn.3speak.tv/api/hotnode',
        cluster_endpoint: process.env.IPFS_CLUSTER_ENDPOINT || 'http://65.21.201.94:9094',
        use_cluster_for_pins: process.env.USE_CLUSTER_FOR_PINS === 'true',
        enable_local_fallback: process.env.ENABLE_LOCAL_FALLBACK === 'true',
        local_fallback_threshold: parseInt(process.env.LOCAL_FALLBACK_THRESHOLD || '3', 10),
        remove_local_after_sync: process.env.REMOVE_LOCAL_AFTER_SYNC !== 'false'
      },
      encoder: {
        temp_dir: process.env.TEMP_DIR,
        ffmpeg_path: process.env.FFMPEG_PATH,
        hardware_acceleration: process.env.HARDWARE_ACCELERATION !== 'false',
        max_concurrent_jobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '1')
      },
      direct_api: {
        enabled: process.env.DIRECT_API_ENABLED === 'true',
        port: parseInt(process.env.DIRECT_API_PORT || '3002'),
        api_key: process.env.DIRECT_API_KEY
      },
      mongodb: {
        enabled: process.env.MONGODB_VERIFICATION_ENABLED === 'true',
        uri: process.env.MONGODB_URI,
        database_name: process.env.DATABASE_NAME,
        connection_timeout: parseInt(process.env.MONGODB_CONNECTION_TIMEOUT || '10000'),
        socket_timeout: parseInt(process.env.MONGODB_SOCKET_TIMEOUT || '30000')
      },
      gateway_aid: {
        enabled: process.env.GATEWAY_AID_ENABLED === 'true',
        base_url: process.env.GATEWAY_AID_BASE_URL
      },
      storage_admin: {
        password: process.env.STORAGE_ADMIN_PASSWORD
      }
    };
    
    // Validate config with Zod
    const config = ConfigSchema.parse(configData);
    
    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid configuration: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    
    throw new Error(`Could not load config from environment variables: ${error}`);
  }
}

export function getDefaultConfig(): Partial<EncoderConfig> {
  return {
    gateway_client: {
      gateway_url: 'https://encoder-gateway.infra.3speak.tv',
      queue_max_length: 1,
      queue_concurrency: 1,
      async_uploads: false
    },
    remote_gateway: {
      enabled: true,
      api: 'https://encoder-gateway.infra.3speak.tv'
    },
    ipfs: {
      apiAddr: '/ip4/127.0.0.1/tcp/5001', // For downloads only
      threespeak_endpoint: 'http://65.21.201.94:5002', // Direct upload endpoint
      traffic_director_url: 'https://cdn.3speak.tv/api/hotnode', // Hotnode traffic director
      cluster_endpoint: 'http://65.21.201.94:9094', // Cluster API for pins
      use_cluster_for_pins: false, // Use cluster instead of main daemon for pins
      enable_local_fallback: false, // Pin locally if remote fails
      local_fallback_threshold: 3, // Retry attempts before falling back to local
      remove_local_after_sync: true // Remove local pins after successful sync
    },
    encoder: {
        hardware_acceleration: true,
        max_concurrent_jobs: 1
      },
      direct_api: {
        enabled: false,
        port: 3002,
        api_key: undefined
      },
      mongodb: {
        enabled: false,
        uri: undefined,
        database_name: undefined,
        connection_timeout: 10000,
        socket_timeout: 30000
      },
      gateway_aid: {
        enabled: false,
        base_url: undefined
      },
      storage_admin: {
        password: undefined
      }
    };
}