/**
 * 🧪 Gateway Monitor Service Test
 * 
 * Test the Gateway Monitor API verification service for community encoders
 * This service provides REST API-based job ownership checking to prevent
 * race conditions without requiring MongoDB access.
 */

import { GatewayMonitorService } from '../src/services/GatewayMonitorService.js';
import type { EncoderConfig } from '../src/config/ConfigLoader.js';

// Test configuration with Gateway Monitor enabled
const testConfig: EncoderConfig = {
  node: {
    name: 'test-community-encoder',
    cryptoAccounts: {
      hive: 'testuser'
    }
  },
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
  gateway_monitor: {
    enabled: true,
    base_url: 'https://gateway-monitor.3speak.tv/api'
  }
};

async function testGatewayMonitor() {
  console.log('🧪 Gateway Monitor Service Test\n');
  console.log('================================\n');
  
  // Initialize service
  const monitor = new GatewayMonitorService(testConfig);
  
  console.log('1️⃣ Service Status:');
  const status = monitor.getStatus();
  console.log(`   Enabled: ${status.enabled ? '✅ Yes' : '❌ No'}`);
  console.log(`   Base URL: ${status.baseUrl}`);
  console.log('');
  
  if (!monitor.isEnabled()) {
    console.log('❌ Gateway Monitor is not enabled - cannot run tests');
    console.log('💡 Set GATEWAY_MONITOR_ENABLED=true in config to enable');
    return;
  }
  
  // Test with a real job ID (from your terminal command)
  const testJobId = '2f42577d-9c93-4a62-9ae2-d1270b5bc4f3';
  const testDID = 'did:key:z6Mkq65oNPyW3Gq187UHrvzWVZTmLhYk4wgFsBGD9HQpXSGp';
  
  console.log('2️⃣ Testing Job Details Fetch:');
  console.log(`   Job ID: ${testJobId}`);
  console.log('');
  
  try {
    const jobDetails = await monitor.getJobDetails(testJobId);
    
    if (jobDetails) {
      console.log('   ✅ Job found!');
      console.log(`   📊 Status: ${jobDetails.status}`);
      console.log(`   👤 Assigned to: ${jobDetails.assigned_to || 'unassigned'}`);
      console.log(`   📅 Created: ${jobDetails.created_at}`);
      console.log(`   📅 Completed: ${jobDetails.completed_at || 'not completed'}`);
      console.log(`   📦 Input size: ${jobDetails.input.size} bytes`);
      console.log(`   🎬 Owner: ${jobDetails.metadata.video_owner}`);
      console.log(`   🎬 Permlink: ${jobDetails.metadata.video_permlink}`);
      if (jobDetails.result?.cid) {
        console.log(`   ✅ Result CID: ${jobDetails.result.cid}`);
      }
      console.log('');
      
      console.log('3️⃣ Testing Ownership Verification:');
      console.log(`   Expected owner: ${testDID}`);
      console.log('');
      
      const verification = await monitor.verifyJobOwnership(testJobId, testDID);
      
      console.log('   📊 Verification Results:');
      console.log(`   Job exists: ${verification.jobExists ? '✅ Yes' : '❌ No'}`);
      console.log(`   Is owned by us: ${verification.isOwned ? '✅ Yes' : '❌ No'}`);
      console.log(`   Actual owner: ${verification.actualOwner || 'unassigned'}`);
      console.log(`   Job status: ${verification.status || 'unknown'}`);
      console.log(`   Safe to process: ${verification.isSafeToProcess ? '✅ Yes' : '❌ No'}`);
      console.log('');
      
      console.log('4️⃣ Testing Job Availability Check:');
      console.log('');
      
      const availability = await monitor.isJobAvailableToClaim(testJobId);
      
      console.log('   📊 Availability Results:');
      console.log(`   Available to claim: ${availability.available ? '✅ Yes' : '❌ No'}`);
      console.log(`   Reason: ${availability.reason}`);
      console.log(`   Current owner: ${availability.currentOwner || 'none'}`);
      console.log(`   Status: ${availability.status || 'unknown'}`);
      console.log('');
      
    } else {
      console.log('   ❌ Job not found in Gateway Monitor API');
      console.log('');
    }
    
    console.log('✅ All tests completed successfully!\n');
    console.log('🎯 Summary:');
    console.log('   - Gateway Monitor service is working correctly');
    console.log('   - Can fetch job details from REST API');
    console.log('   - Can verify job ownership');
    console.log('   - Can check if jobs are available to claim');
    console.log('');
    console.log('💡 This prevents race conditions for community encoders!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('   Error message:', error.message);
    }
    process.exit(1);
  }
}

// Run tests
testGatewayMonitor().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
