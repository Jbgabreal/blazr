#!/usr/bin/env node

const WebSocket = require('ws');

// PumpPortal WebSocket URL
const PUMP_PORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Specific token to monitor
const TARGET_TOKEN = 'NdvVCe7StoC22v2Dcff3bAWh9yuVY2GfnhPSGVXbonk';

console.log('🎯 Testing Specific Token Trading Activity');
console.log('📡 Connecting to:', PUMP_PORTAL_WS_URL);
console.log('🎯 Target token:', TARGET_TOKEN);
console.log('');

const ws = new WebSocket(PUMP_PORTAL_WS_URL);

ws.on('open', function open() {
  console.log('✅ Connected to PumpPortal WebSocket');
  
  // Subscribe to token trade data for the specific token (correct method)
  const tradePayload = {
    method: "subscribeTokenTrade",
    keys: [TARGET_TOKEN]
  };
  
  console.log('📤 Subscribing to trade data for:', TARGET_TOKEN);
  console.log('   Payload:', JSON.stringify(tradePayload, null, 2));
  console.log('');
  
  ws.send(JSON.stringify(tradePayload));
  
  console.log('⏳ Waiting for messages... (Press Ctrl+C to stop)');
  console.log('   Note: If no trades happen on this token, you won\'t see trade events');
  console.log('   The subscribeTokenTrade method only sends data when trades occur');
  console.log('');
});

ws.on('message', function message(data) {
  try {
    const parsed = JSON.parse(data);
    
    // Check if this is a subscription confirmation
    if (parsed.message && parsed.message.includes('Successfully subscribed')) {
      console.log('✅ Subscription confirmed:', parsed.message);
      console.log('');
      return;
    }
    
    // Check if this is a trade event for our token
    if (parsed.type === 'tokenTrade' && parsed.data && parsed.data.tokenAddress === TARGET_TOKEN) {
      console.log('🎯 TARGET TOKEN TRADE DETECTED!');
      console.log('   Trade data:', JSON.stringify(parsed.data, null, 2));
      console.log('');
    }
    // Show other events for context
    else {
      console.log('📥 Other event:');
      console.log('   Type:', parsed.type || 'unknown');
      console.log('   Token:', parsed.data?.tokenAddress || 'unknown');
      console.log('');
    }
  } catch (error) {
    console.log('📥 Received raw message:', data.toString());
    console.log('');
  }
});

ws.on('error', function error(err) {
  console.error('❌ WebSocket error:', err);
});

ws.on('close', function close() {
  console.log('🔌 WebSocket connection closed');
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  ws.close();
  process.exit(0);
});

// Auto-disconnect after 60 seconds (longer to catch more events)
setTimeout(() => {
  console.log('\n⏰ Test timeout reached, disconnecting...');
  console.log('💡 If you didn\'t see any trade events for', TARGET_TOKEN);
  console.log('   it means this token is not currently being traded on PumpPortal');
  ws.close();
  process.exit(0);
}, 60000); 