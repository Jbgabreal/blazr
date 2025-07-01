#!/usr/bin/env node

const WebSocket = require('ws');

// PumpPortal WebSocket URL
const PUMP_PORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Test token address
const TEST_TOKEN = '6etEoWR2jd7nzL6hzi4kgcdJusrCLT2pqRg2BgU5pump';

console.log('🧪 Testing PumpPortal WebSocket Connection');
console.log('📡 Connecting to:', PUMP_PORTAL_WS_URL);
console.log('🎯 Test token:', TEST_TOKEN);
console.log('');

const ws = new WebSocket(PUMP_PORTAL_WS_URL);

ws.on('open', function open() {
  console.log('✅ Connected to PumpPortal WebSocket');
  
  // Subscribe to token trade data for specific tokens
  const payload = {
    method: "subscribeTokenTrade",
    keys: [TEST_TOKEN]
  };
  
  console.log('📤 Sending subscription payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');
  
  ws.send(JSON.stringify(payload));
  
  console.log('⏳ Waiting for messages... (Press Ctrl+C to stop)');
  console.log('');
});

ws.on('message', function message(data) {
  try {
    const parsed = JSON.parse(data);
    console.log('📥 Received message:');
    console.log('   Type:', parsed.type || 'unknown');
    console.log('   Full data:', JSON.stringify(parsed, null, 2));
    console.log('');
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

// Auto-disconnect after 30 seconds
setTimeout(() => {
  console.log('\n⏰ Test timeout reached, disconnecting...');
  ws.close();
  process.exit(0);
}, 30000); 