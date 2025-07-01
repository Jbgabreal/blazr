#!/usr/bin/env node

/**
 * Test script for market cap functionality
 * Run with: node Proxy/scripts/test-market-cap.js
 */

const axios = require('axios');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function testMarketCapAPI() {
  console.log('🧪 Testing Market Cap API...\n');

  try {
    // Test 1: Get tokens needing market cap update
    console.log('1. Testing GET /api/tokens/needing-market-cap-update');
    const tokensResponse = await axios.get(`${API_BASE_URL}/api/tokens/needing-market-cap-update`);
    console.log('✅ Success:', tokensResponse.data);
    console.log(`   Found ${tokensResponse.data.count} tokens needing updates\n`);

    // Test 2: Test scheduler status
    console.log('2. Testing GET /api/market-cap-scheduler/status');
    const statusResponse = await axios.get(`${API_BASE_URL}/api/market-cap-scheduler/status`);
    console.log('✅ Success:', statusResponse.data);
    console.log(`   Scheduler running: ${statusResponse.data.isRunning}\n`);

    // Test 3: Start scheduler
    console.log('3. Testing POST /api/market-cap-scheduler/start');
    const startResponse = await axios.post(`${API_BASE_URL}/api/market-cap-scheduler/start`, {
      intervalMinutes: 15
    });
    console.log('✅ Success:', startResponse.data.message, '\n');

    // Test 4: Trigger manual update
    console.log('4. Testing POST /api/market-cap-scheduler/trigger-update');
    const triggerResponse = await axios.post(`${API_BASE_URL}/api/market-cap-scheduler/trigger-update`);
    console.log('✅ Success:', triggerResponse.data);
    console.log(`   Job ID: ${triggerResponse.data.job.id}`);
    console.log(`   Status: ${triggerResponse.data.job.status}`);
    console.log(`   Tokens processed: ${triggerResponse.data.job.tokensProcessed}`);
    console.log(`   Tokens updated: ${triggerResponse.data.job.tokensUpdated}\n`);

    // Test 5: Test Pump Portal API directly
    console.log('5. Testing Pump Portal API directly');
    try {
      const pumpPortalResponse = await axios.get('https://pumpportal.fun/data-api/real-time', {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      console.log('✅ Success: Pump Portal API is accessible');
      console.log(`   Received ${pumpPortalResponse.data?.length || 0} tokens\n`);
    } catch (error) {
      console.log('⚠️  Warning: Pump Portal API not accessible:', error.message, '\n');
    }

    // Test 6: Get updated status
    console.log('6. Testing updated scheduler status');
    const updatedStatusResponse = await axios.get(`${API_BASE_URL}/api/market-cap-scheduler/status`);
    console.log('✅ Success:', updatedStatusResponse.data);
    console.log(`   Scheduler running: ${updatedStatusResponse.data.isRunning}`);
    if (updatedStatusResponse.data.lastJob) {
      console.log(`   Last job status: ${updatedStatusResponse.data.lastJob.status}`);
      console.log(`   Last job tokens updated: ${updatedStatusResponse.data.lastJob.tokensUpdated}`);
    }

    console.log('\n🎉 All tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
    process.exit(1);
  }
}

async function testMarketCapForSpecificToken() {
  console.log('\n🔍 Testing Market Cap for Specific Token...\n');

  // You can replace this with an actual token mint address
  const testMint = process.env.TEST_MINT || 'So11111111111111111111111111111111111111112';

  try {
    // Test getting market cap for specific token
    console.log(`1. Testing GET /api/token/${testMint}/market-cap`);
    const response = await axios.get(`${API_BASE_URL}/api/token/${testMint}/market-cap`);
    console.log('✅ Success:', response.data);

    // Test updating market cap for specific token
    console.log(`\n2. Testing POST /api/token/${testMint}/market-cap`);
    const updateResponse = await axios.post(`${API_BASE_URL}/api/token/${testMint}/market-cap`, {
      marketCap: 1000000,
      price: 0.001,
      volume24h: 50000
    });
    console.log('✅ Success:', updateResponse.data);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
  }
}

async function testEnhancedTokenEndpoints() {
  console.log('\n🌐 Testing Enhanced Token Endpoints...\n');

  try {
    // Test 1: Get all created tokens (database data only)
    console.log('1. Testing GET /api/created-tokens (database data only)');
    const allTokensResponse = await axios.get(`${API_BASE_URL}/api/created-tokens`);
    console.log('✅ Success:', {
      total_tokens: allTokensResponse.data.total_tokens,
      realtime_data_included: allTokensResponse.data.realtime_data_included,
      sample_token: allTokensResponse.data.tokens[0] ? {
        mint: allTokensResponse.data.tokens[0].mint_address,
        market_cap: allTokensResponse.data.tokens[0].market_cap,
        has_market_cap: !!allTokensResponse.data.tokens[0].market_cap
      } : 'No tokens found'
    });

    // Test 2: Get all created tokens with real-time data
    console.log('\n2. Testing GET /api/created-tokens?includeRealtimeData=true');
    const realtimeResponse = await axios.get(`${API_BASE_URL}/api/created-tokens?includeRealtimeData=true`);
    console.log('✅ Success:', {
      total_tokens: realtimeResponse.data.total_tokens,
      realtime_data_included: realtimeResponse.data.realtime_data_included,
      tokens_with_realtime_data: realtimeResponse.data.tokens_with_realtime_data,
      sample_token: realtimeResponse.data.tokens[0] ? {
        mint: realtimeResponse.data.tokens[0].mint_address,
        market_cap: realtimeResponse.data.tokens[0].market_cap,
        price: realtimeResponse.data.tokens[0].price,
        volume24h: realtimeResponse.data.tokens[0].volume24h,
        has_realtime_data: realtimeResponse.data.tokens[0].has_realtime_data
      } : 'No tokens found'
    });

    // Test 3: Get user's tokens (if you have a test public key)
    const testPublicKey = process.env.TEST_PUBLIC_KEY;
    if (testPublicKey) {
      console.log('\n3. Testing GET /api/created-tokens/user');
      const userTokensResponse = await axios.get(`${API_BASE_URL}/api/created-tokens/user?publicKey=${testPublicKey}&includeRealtimeData=true`);
      console.log('✅ Success:', {
        total_tokens: userTokensResponse.data.total_tokens,
        realtime_data_included: userTokensResponse.data.realtime_data_included,
        tokens_with_realtime_data: userTokensResponse.data.tokens_with_realtime_data
      });
    } else {
      console.log('\n3. Skipping user tokens test (TEST_PUBLIC_KEY not set)');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
  }
}

async function main() {
  console.log('🚀 Market Cap API Test Suite\n');
  console.log('API Base URL:', API_BASE_URL);
  console.log('Test Mint:', process.env.TEST_MINT || 'So11111111111111111111111111111111111111112');
  console.log('');

  await testMarketCapAPI();
  await testMarketCapForSpecificToken();
  await testEnhancedTokenEndpoints();

  console.log('\n✨ Test suite completed!');
}

// Run the tests
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { testMarketCapAPI, testMarketCapForSpecificToken, testEnhancedTokenEndpoints }; 