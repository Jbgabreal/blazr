#!/usr/bin/env node

/**
 * Health check script for market cap scheduler
 * Run this to verify the scheduler is working properly
 */

const axios = require('axios');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function checkSchedulerHealth() {
  console.log('🏥 Checking Market Cap Scheduler Health...\n');

  try {
    // Check scheduler status
    console.log('1. Checking scheduler status...');
    const statusResponse = await axios.get(`${API_BASE_URL}/api/market-cap-scheduler/status`);
    const status = statusResponse.data;
    
    console.log('✅ Scheduler Status:', status.isRunning ? '🟢 Running' : '🔴 Stopped');
    
    if (status.lastJob) {
      console.log('📊 Last Job:');
      console.log(`   ID: ${status.lastJob.id}`);
      console.log(`   Status: ${status.lastJob.status}`);
      console.log(`   Tokens Processed: ${status.lastJob.tokensProcessed}`);
      console.log(`   Tokens Updated: ${status.lastJob.tokensUpdated}`);
      console.log(`   Start Time: ${new Date(status.lastJob.startTime).toLocaleString()}`);
      if (status.lastJob.endTime) {
        console.log(`   End Time: ${new Date(status.lastJob.endTime).toLocaleString()}`);
      }
      if (status.lastJob.errors.length > 0) {
        console.log(`   Errors: ${status.lastJob.errors.length}`);
        status.lastJob.errors.forEach((error, index) => {
          console.log(`     ${index + 1}. ${error}`);
        });
      }
    } else {
      console.log('⚠️  No previous jobs found');
    }

    // Check tokens needing updates
    console.log('\n2. Checking tokens needing updates...');
    const tokensResponse = await axios.get(`${API_BASE_URL}/api/tokens/needing-market-cap-update`);
    const tokens = tokensResponse.data;
    
    console.log(`✅ Tokens needing updates: ${tokens.count}`);
    if (tokens.count > 0) {
      console.log('📋 Sample tokens:');
      tokens.tokens.slice(0, 3).forEach((token, index) => {
        console.log(`   ${index + 1}. ${token.token_name} (${token.token_symbol})`);
        console.log(`      Mint: ${token.mint_address.slice(0, 8)}...${token.mint_address.slice(-6)}`);
        console.log(`      Last Update: ${token.last_market_cap_update || 'Never'}`);
      });
    }

    // Test Pump Portal API connectivity
    console.log('\n3. Testing Pump Portal API connectivity...');
    try {
      const pumpPortalResponse = await axios.get('https://pumpportal.fun/data-api/real-time', {
        timeout: 10000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      console.log(`✅ Pump Portal API: Accessible (${pumpPortalResponse.data?.length || 0} tokens available)`);
    } catch (error) {
      console.log(`❌ Pump Portal API: Not accessible (${error.message})`);
    }

    // Overall health assessment
    console.log('\n🏥 Health Assessment:');
    const isHealthy = status.isRunning && tokens.count >= 0;
    console.log(`   Overall Status: ${isHealthy ? '🟢 Healthy' : '🔴 Unhealthy'}`);
    
    if (status.isRunning) {
      console.log('   ✅ Scheduler is running');
    } else {
      console.log('   ❌ Scheduler is not running');
    }
    
    if (tokens.count >= 0) {
      console.log('   ✅ Token queries working');
    } else {
      console.log('   ❌ Token queries failing');
    }

    console.log('\n✨ Health check completed!');

  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Run the health check
if (require.main === module) {
  checkSchedulerHealth().catch(console.error);
}

module.exports = { checkSchedulerHealth }; 