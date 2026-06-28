import { z } from 'zod';
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

const ConfigSchema = z.object({
  node: z.object({
    name: z.string(),
    privateKey: z.string().optional(),
    publicKey: z.string().optional(),
    cryptoAccounts: z.object({
      hive: z.string()
    }).optional()
  }),
  ipfs_gateway_url: z.string().url().default('https://ipfs.3speak.tv'),
  ipfs: z.object({
    apiAddr: z.string().default('/ip4/127.0.0.1/tcp/5001'),
    threespeak_endpoint: z.string().default('http://65.21.201.94:5002'),
    traffic_director_url: z.string().url().default('https://cdn.3speak.tv/api/hotnode'),
    cluster_endpoint: z.string().default('http://65.21.201.94:9094'),
    use_cluster_for_pins: z.boolean().default(false),
    enable_local_fallback: z.boolean().default(false),
    local_fallback_threshold: z.number().default(3),
    remove_local_after_sync: z.boolean().default(true)
  }).optional(),
  encoder: z.object({
    temp_dir: z.string().optional(),
    ffmpeg_path: z.string().optional(),
    hardware_acceleration: z.boolean().default(true),
    max_concurrent_jobs: z.number().default(1),
    aria2_connections: z.number().default(12)
  }).optional(),
  direct_api: z.object({
    enabled: z.boolean().default(false),
    port: z.number().default(3002),
    api_key: z.string().optional()
  }).optional(),
  storage_admin: z.object({
    password: z.string().optional()
  }).optional(),
  embed_system: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['managed', 'community']).default('managed'),
    gateway_url: z.string().url().optional()
  }).optional()
});

export type EncoderConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(): Promise<EncoderConfig> {
  try {
    const configData = {
      node: {
        name: process.env.NODE_NAME || '3speak-encoder-node',
        privateKey: process.env.ENCODER_PRIVATE_KEY,
        publicKey: process.env.ENCODER_PUBLIC_KEY,
        cryptoAccounts: {
          hive: process.env.HIVE_USERNAME || ''
        }
      },
      ipfs_gateway_url: process.env.IPFS_GATEWAY_URL || 'https://ipfs.3speak.tv',
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
        max_concurrent_jobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '1'),
        aria2_connections: parseInt(process.env.ARIA2_CONNECTIONS || '12')
      },
      direct_api: {
        enabled: process.env.DIRECT_API_ENABLED === 'true',
        port: parseInt(process.env.DIRECT_API_PORT || '3002'),
        api_key: process.env.DIRECT_API_KEY
      },
      storage_admin: {
        password: process.env.STORAGE_ADMIN_PASSWORD
      },
      embed_system: {
        enabled: process.env.EMBED_SYSTEM_ENABLED === 'true',
        mode: process.env.EMBED_SYSTEM_MODE || 'managed',
        gateway_url: process.env.EMBED_GATEWAY_URL || undefined
      }
    };

    return ConfigSchema.parse(configData);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid configuration: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    throw new Error(`Could not load config from environment variables: ${error}`);
  }
}
