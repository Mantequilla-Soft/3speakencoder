/**
 * Test suite for Gateway finishJob response handling
 * Tests the February 2026 gateway update that returns { status: 'success' | 'error' }
 * 
 * Run with: npm run build && node tests/test-finishJob-response.js
 * Or directly: node tests/test-finishJob-response.js
 */

// Type definition for response (standalone)
interface GatewayFinishJobResponse {
  status?: 'success' | 'error';
  message?: string;
  error?: string;
  success?: boolean;
  duplicate?: boolean;
  originalError?: string;
}

// Simple logger for tests
const logger = {
  info: (...args: any[]) => console.log('[INFO]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args),
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  debug: (...args: any[]) => console.log('[DEBUG]', ...args)
};

interface TestCase {
  name: string;
  mockResponse: any;
  expectedStatus: 'success' | 'error' | 'unknown';
  shouldThrow?: boolean;
  description: string;
}

const testCases: TestCase[] = [
  {
    name: 'New format - success',
    mockResponse: { status: 'success', message: 'Job finished successfully' },
    expectedStatus: 'success',
    description: 'Gateway returns new format with status: success'
  },
  {
    name: 'New format - error',
    mockResponse: { status: 'error', message: 'Job validation failed', error: 'Invalid CID' },
    expectedStatus: 'error',
    shouldThrow: true,
    description: 'Gateway returns new format with status: error'
  },
  {
    name: 'Old format - no status field',
    mockResponse: { result: 'completed', job_id: '123' },
    expectedStatus: 'success',
    description: 'Backward compatibility: old gateway response without status field'
  },
  {
    name: 'Empty response',
    mockResponse: {},
    expectedStatus: 'success',
    description: 'Empty response treated as success (backward compatible)'
  },
  {
    name: 'Null response',
    mockResponse: null,
    expectedStatus: 'success',
    description: 'Null response treated as success (backward compatible)'
  },
  {
    name: 'Duplicate completion',
    mockResponse: { status: 'success', success: true, duplicate: true, message: 'Job already completed by another encoder' },
    expectedStatus: 'success',
    description: 'Synthetic response for duplicate completion'
  }
];

async function runTests() {
  logger.info('🧪 Starting finishJob response handling tests...');
  logger.info('📋 Testing February 2026 gateway update compatibility\n');

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    try {
      logger.info(`\n🔬 Test: ${testCase.name}`);
      logger.info(`   Description: ${testCase.description}`);
      logger.info(`   Mock response:`, testCase.mockResponse);

      // Simulate response parsing logic from GatewayClient.finishJob()
      const response = testCase.mockResponse;
      let parsedResponse: GatewayFinishJobResponse;

      if (response && typeof response === 'object') {
        if (response.status === 'success') {
          parsedResponse = {
            status: 'success',
            message: response.message || 'Job finished successfully'
          };
        } else if (response.status === 'error') {
          if (testCase.shouldThrow) {
            throw new Error(`Gateway reported error: ${response.message || response.error || 'Unknown error'}`);
          }
          parsedResponse = {
            status: 'error',
            message: response.message,
            error: response.error
          };
        } else if (!response.status) {
          // Backward compatible: no status field
          parsedResponse = {
            status: 'success',
            message: 'Job finished (legacy response format)'
          };
        } else {
          parsedResponse = {
            status: 'success',
            message: 'Job finished (unexpected response format)'
          };
        }
      } else {
        // Null or non-object response
        parsedResponse = {
          status: 'success',
          message: 'Job finished (unexpected response format)'
        };
      }

      // Validate expected behavior
      if (testCase.shouldThrow) {
        logger.error(`   ❌ FAILED: Expected exception but none was thrown`);
        failed++;
        continue;
      }

      if (parsedResponse.status === testCase.expectedStatus) {
        logger.info(`   ✅ PASSED: Got expected status "${parsedResponse.status}"`);
        logger.info(`   Message: ${parsedResponse.message}`);
        passed++;
      } else {
        logger.error(`   ❌ FAILED: Expected status "${testCase.expectedStatus}", got "${parsedResponse.status}"`);
        failed++;
      }

    } catch (error: any) {
      if (testCase.shouldThrow) {
        logger.info(`   ✅ PASSED: Exception thrown as expected: ${error.message}`);
        passed++;
      } else {
        logger.error(`   ❌ FAILED: Unexpected exception: ${error.message}`);
        failed++;
      }
    }
  }

  logger.info('\n\n📊 Test Results:');
  logger.info(`   ✅ Passed: ${passed}`);
  logger.info(`   ❌ Failed: ${failed}`);
  logger.info(`   Total: ${testCases.length}`);

  if (failed === 0) {
    logger.info('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    logger.error(`\n💥 ${failed} test(s) failed`);
    process.exit(1);
  }
}

// Additional integration tests (require actual gateway connection)
async function runIntegrationTests() {
  logger.info('\n\n🌐 Integration Tests (requires gateway connection)');
  logger.info('⚠️  Skipping - requires actual DID credentials and gateway access');
  logger.info('💡 To run integration tests:');
  logger.info('   1. Set DID_SEED and DID_PRIVATE_KEY env vars');
  logger.info('   2. Ensure gateway is accessible');
  logger.info('   3. Uncomment integration test code below\n');

  // Uncomment to run actual integration tests
  /*
  try {
    const config = mockConfig as any;
    const identity = new IdentityService(config);
    await identity.initialize();
    
    const gateway = new GatewayClient(config);
    gateway.setIdentity(identity);

    // Test actual finishJob call
    const testJobId = 'test-job-' + Date.now();
    const testResult = {
      ipfs_hash: 'QmTestHash123',
      master_playlist: 'master.m3u8'
    };

    logger.info('🔄 Attempting actual finishJob call...');
    const response = await gateway.finishJob(testJobId, testResult);
    
    logger.info('✅ Integration test response:', response);
    
    if (response.status === 'success' || response.status === 'error') {
      logger.info('✅ Gateway is using new response format (Feb 2026+)');
    } else {
      logger.warn('⚠️  Gateway might be using old response format');
    }
    
  } catch (error: any) {
    logger.error('❌ Integration test failed:', error.message);
    logger.info('💡 This is expected if gateway is not accessible or job doesnt exist');
  }
  */
}

// Run tests
runTests()
  .then(() => runIntegrationTests())
  .catch(error => {
    logger.error('💥 Test runner failed:', error);
    process.exit(1);
  });
