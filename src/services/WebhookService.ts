import axios from 'axios';
import { logger } from './Logger.js';
import { WebhookPayload } from '../types/DirectApi.js';

export class WebhookService {
  private maxRetries: number = 3;
  private retryDelay: number = 1000; // 1 second

  async sendWebhook(url: string, payload: WebhookPayload, apiKey?: string): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.info(`📤 Sending webhook (attempt ${attempt}/${this.maxRetries}): ${url}`);
        
        const response = await axios.post(url, payload, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': '3Speak-Encoder/1.0.0',
            ...(apiKey && { 'X-API-Key': apiKey }) // 🔑 Add API key if provided
          },
          validateStatus: (status) => status < 500 // Retry on 5xx errors only
        });

        if (response.status >= 200 && response.status < 300) {
          logger.info(`✅ Webhook delivered successfully: ${url} (${response.status})`);
          return;
        } else {
          logger.warn(`⚠️ Webhook returned ${response.status}: ${url}`);
          return; // Don't retry 4xx errors
        }

      } catch (error) {
        lastError = error as Error;
        
        if (axios.isAxiosError(error)) {
          if (error.response && error.response.status < 500) {
            // Don't retry 4xx errors
            logger.warn(`⚠️ Webhook failed with ${error.response.status}: ${url}`);
            return;
          }
        }

        logger.warn(`⚠️ Webhook attempt ${attempt} failed: ${error}`);

        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          logger.info(`⏳ Retrying webhook in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    logger.error(`❌ Webhook failed after ${this.maxRetries} attempts: ${url}`, lastError);
    throw new Error(`Webhook delivery failed: ${lastError?.message}`);
  }

  /**
   * Send progress update to gateway during encoding (non-blocking, fire-and-forget)
   * Spec: POST /webhook/progress with { owner, permlink, progress, stage }
   */
  async sendProgressPing(
    webhookUrl: string,
    owner: string,
    permlink: string,
    progress: number,
    stage?: string,
    apiKey?: string
  ): Promise<void> {
    // Progress URL is webhook_url + /progress per the encoder contract
    const progressUrl = `${webhookUrl}/progress`;

    try {
      logger.debug(`📊 Sending progress ping: ${owner}/${permlink} → ${progress}% (${stage || 'N/A'})`);
      
      const response = await axios.post(
        progressUrl,
        {
          owner,
          permlink,
          progress: Math.round(progress),
          ...(stage && { stage })
        },
        {
          timeout: 5000, // Shorter timeout for progress pings
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': '3Speak-Encoder/1.0.0',
            ...(apiKey && { 'X-API-Key': apiKey })
          },
          validateStatus: (status) => status < 500
        }
      );

      if (response.status >= 200 && response.status < 300) {
        logger.debug(`✅ Progress ping delivered: ${progress}%`);
      } else {
        logger.warn(`⚠️ Progress ping returned ${response.status} for ${owner}/${permlink}`);
      }

    } catch (error) {
      // Fire-and-forget: log but don't throw
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status && status >= 400 && status < 500) {
          logger.warn(`⚠️ Progress ping rejected (${status}): ${owner}/${permlink}`);
        } else {
          logger.warn(`⚠️ Progress ping failed: ${error.message}`);
        }
      } else {
        logger.warn(`⚠️ Progress ping error:`, error);
      }
      // Don't propagate error - progress pings are optional
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}