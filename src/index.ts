#!/usr/bin/env node
import { ThreeSpeakEncoder } from './services/ThreeSpeakEncoder.js';
import { DashboardService } from './services/DashboardService.js';
import { logger, dashboardTransport } from './services/Logger.js';
import { loadConfig } from './config/ConfigLoader.js';
import { HealthMonitor } from './services/HealthMonitor.js';

async function main() {
  try {
    logger.info('🚀 Starting 3Speak Modern Video Encoder...');
    
    // Load configuration
    const config = await loadConfig();
    logger.info('✅ Configuration loaded');
    
    // Measure event-loop lag from the start, so stalls during startup are seen too
    const healthMonitor = new HealthMonitor();
    healthMonitor.start();

    // Start dashboard service
    const dashboard = new DashboardService(3001, healthMonitor);
    await dashboard.start();
    logger.info(`📊 Dashboard available at: ${dashboard.getUrl()}`);
    
    // Connect logger to dashboard for live log streaming
    dashboardTransport.setDashboard(dashboard);
    logger.info('✅ Live dashboard logs enabled');
    
    // Initialize and start encoder
    const encoder = new ThreeSpeakEncoder(config, dashboard);
    dashboard.setEncoder(encoder); // Connect encoder to dashboard for maintenance operations
    await encoder.start();
    
    logger.info('✅ 3Speak Encoder is ready and running!');
    
    // Graceful shutdown handling
    process.on('SIGINT', async () => {
      logger.info('📴 Shutting down encoder...');
      await encoder.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      logger.info('📴 Shutting down encoder...');
      await encoder.stop();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('💥 Failed to start encoder:', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught exception:', error);
  if ((error as NodeJS.ErrnoException).code !== 'EPROTO') {
    process.exit(1); // All other fatal errors still crash the process
  }
  // EPROTO socket errors during uploads: let the job's timeout handler clean up
});

process.on('unhandledRejection', (reason) => {
  logger.error('💥 Unhandled promise rejection:', reason);
});

main().catch((error) => {
  logger.error('💥 Unhandled error:', error);
  process.exit(1);
});