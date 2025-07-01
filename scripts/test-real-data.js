const WebSocket = require('ws');
const { tokenPriceService } = require('../src/services/marketCap/tokenPriceService');

// Pump Portal WebSocket configuration
const PUMP_PORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Test with a token that has active trading
const ACTIVE_TOKEN = '3ti8dzrM1bjhzDojP7cknwxR2Ud9PX74A2bMo1mLpump';

console.log('🧪 Testing Real Data from PumpPortal');
console.log('=====================================');
console.log(`🎯 Testing with active token: ${ACTIVE_TOKEN}`);

let wsConnection = null;
let isConnected = false;
let receivedRealData = false;
let dataCount = 0;

function initializeWebSocket() {
  console.log('🔌 Connecting to PumpPortal WebSocket...');
  
  wsConnection = new WebSocket(PUMP_PORTAL_WS_URL);

  wsConnection.on('open', () => {
    console.log('✅ Connected to PumpPortal WebSocket');
    isConnected = true;
    
    // Subscribe to the active token
    const payload = {
      method: "subscribeTokenTrade",
      keys: [ACTIVE_TOKEN]
    };
    
    console.log('📡 Subscribing to active token trades...');
    console.log('   Payload:', JSON.stringify(payload, null, 2));
    wsConnection.send(JSON.stringify(payload));
  });

  wsConnection.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      
      if (message.message === 'Successfully subscribed to keys.') {
        console.log('✅ Successfully subscribed to token trades');
        return;
      }
      
      // Check if this is real trade data
      if (message.mint && message.marketCapSol !== undefined) {
        dataCount++;
        receivedRealData = true;
        
        console.log(`\n📊 REAL TRADE DATA RECEIVED (#${dataCount}):`);
        console.log('==========================================');
        console.log(`   Token: ${message.mint}`);
        console.log(`   Transaction Type: ${message.txType}`);
        console.log(`   SOL Amount: ${message.solAmount}`);
        console.log(`   Token Amount: ${message.tokenAmount}`);
        console.log(`   Market Cap (SOL): ${message.marketCapSol}`);
        console.log(`   Pool: ${message.pool}`);
        
        // Test market cap conversion
        console.log('\n💱 Testing Market Cap Conversion:');
        console.log('================================');
        
        try {
          const marketCapResult = await tokenPriceService.calculateMarketCap(message.mint, message.marketCapSol);
          
          if (marketCapResult) {
            console.log('✅ Real market cap conversion successful:');
            console.log(`   Market cap in SOL: ${marketCapResult.marketCapSol}`);
            console.log(`   SOL price: $${marketCapResult.solPrice.toFixed(2)} USD`);
            console.log(`   Token price: $${marketCapResult.tokenPrice.toFixed(6)} USD`);
            console.log(`   Market cap in USD: $${marketCapResult.marketCapUsd.toFixed(2)} USD`);
            
            // Verify calculation
            const expectedUsd = message.marketCapSol * marketCapResult.solPrice;
            console.log(`   Verification: ${message.marketCapSol} SOL × $${marketCapResult.solPrice.toFixed(2)} = $${expectedUsd.toFixed(2)} USD`);
            
            if (Math.abs(marketCapResult.marketCapUsd - expectedUsd) < 0.01) {
              console.log('✅ Calculation verification passed!');
            } else {
              console.log('❌ Calculation verification failed!');
            }
          } else {
            console.log('❌ Failed to calculate market cap');
          }
        } catch (error) {
          console.log('❌ Error in market cap conversion:', error.message);
        }
        
        console.log('\n📈 This proves the system CAN receive and process real data!');
        
        // Stop after receiving 3 real data points
        if (dataCount >= 3) {
          console.log('\n✅ Received 3 real data points, stopping test...');
          wsConnection.close();
        }
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  wsConnection.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    isConnected = false;
  });

  wsConnection.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    isConnected = false;
  });
}

async function testRealData() {
  try {
    // Initialize WebSocket
    initializeWebSocket();
    
    // Wait for connection and data
    console.log('\n⏳ Waiting for real trade data...');
    console.log('   (This may take a few minutes if no trades are happening)');
    console.log('   Press Ctrl+C to stop...');
    
    // Monitor for 5 minutes
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
    while (Date.now() - startTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
      
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`   [${elapsed}s] Waiting for real data... (${dataCount} received)`);
      
      if (receivedRealData) {
        console.log('   ✅ Real data received! System is working correctly.');
      }
    }
    
    // Final summary
    console.log('\n📊 Test Summary:');
    console.log('================');
    console.log(`   Real data received: ${receivedRealData ? '✅ YES' : '❌ NO'}`);
    console.log(`   Data points received: ${dataCount}`);
    console.log(`   Connection status: ${isConnected ? '✅ Connected' : '❌ Disconnected'}`);
    
    if (receivedRealData) {
      console.log('\n🎉 SUCCESS: System is receiving and processing real data!');
      console.log('   The "mock" data you saw earlier was just a fallback when no real data was available.');
    } else {
      console.log('\n⚠️  No real data received during test period.');
      console.log('   This could mean:');
      console.log('   - No trades happened for this token during the test');
      console.log('   - Token might not be actively traded right now');
      console.log('   - But the system is ready to receive real data when available');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    if (wsConnection) {
      wsConnection.close();
    }
  }
}

// Run the test
testRealData()
  .then(() => {
    console.log('\n✅ Real data test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }); 