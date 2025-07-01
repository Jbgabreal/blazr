#!/usr/bin/env node

/**
 * Test script to verify auto-start functionality
 * Tests that market cap scheduler starts in both development and production
 */

const { spawn } = require('child_process');
const axios = require('axios');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function testAutoStart(environment = 'development') {
  console.log(`🧪 Testing Auto-Start in ${environment.toUpperCase()} environment...\n`);

  // Set environment
  process.env.NODE_ENV = environment;

  // Start server in background
  const server = spawn('node', ['Proxy/server.js'], {
    stdio: 'pipe',
    env: process.env,
    cwd: process.cwd()
  });

  let serverOutput = '';
  let schedulerStarted = false;

  // Collect server output
  server.stdout.on('data', (data) => {
    const output = data.toString();
    serverOutput += output;
    console.log(output.trim());
    
    // Check if scheduler started
    if (output.includes('Auto-starting market cap scheduler')) {
      schedulerStarted = true;
    }
  });

  server.stderr.on('data', (data) => {
    console.error('Server Error:', data.toString());
  });

  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    // Test if scheduler is running
    console.log('\n🔍 Testing scheduler status...');
    const statusResponse = await axios.get(`${API_BASE_URL}/api/market-cap-scheduler/status`);
    const status = statusResponse.data;
    
    console.log('✅ Scheduler Status:', status.isRunning ? '🟢 Running' : '🔴 Stopped');
    
    if (status.isRunning) {
      console.log('✅ Auto-start test PASSED - Scheduler is running');
    } else {
      console.log('❌ Auto-start test FAILED - Scheduler is not running');
    }

    // Test if endpoints are working
    console.log('\n🔍 Testing market cap endpoints...');
    const tokensResponse = await axios.get(`${API_BASE_URL}/api/created-tokens`);
    console.log('✅ Market cap endpoints working:', {
      total_tokens: tokensResponse.data.total_tokens,
      realtime_data_included: tokensResponse.data.realtime_data_included
    });

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    // Stop server
    server.kill('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return schedulerStarted;
}

async function runAllTests() {
  console.log('🚀 Testing Auto-Start Functionality\n');

  // Test development environment
  console.log('='.repeat(50));
  console.log('TESTING DEVELOPMENT ENVIRONMENT');
  console.log('='.repeat(50));
  const devResult = await testAutoStart('development');

  // Wait between tests
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Test production environment
  console.log('\n' + '='.repeat(50));
  console.log('TESTING PRODUCTION ENVIRONMENT');
  console.log('='.repeat(50));
  const prodResult = await testAutoStart('production');

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('TEST RESULTS SUMMARY');
  console.log('='.repeat(50));
  console.log(`Development Environment: ${devResult ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`Production Environment: ${prodResult ? '✅ PASSED' : '❌ FAILED'}`);
  
  if (devResult && prodResult) {
    console.log('\n🎉 All auto-start tests PASSED!');
    console.log('✅ Market cap scheduler auto-starts in both environments');
  } else {
    console.log('\n❌ Some auto-start tests FAILED');
    console.log('🔧 Check the configuration and try again');
  }
}

// Run the tests
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = { testAutoStart, runAllTests }; 