const WebSocket = require('ws');
const { tokenPriceService } = require('../src/services/marketCap/tokenPriceService');

// Pump Portal WebSocket configuration
const PUMP_PORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Cache for token price data
const tokenPriceCache = new Map();
let wsConnection = null;
let isConnected = false;

/**
 * Initialize WebSocket connection to PumpPortal
 */
function initializeWebSocket() {
  if (wsConnection) {
    return wsConnection;
  }

  console.log('🔌 Connecting to PumpPortal WebSocket...');
  
  wsConnection = new WebSocket(PUMP_PORTAL_WS_URL);

  wsConnection.on('open', () => {
    console.log('✅ Connected to PumpPortal WebSocket');
    isConnected = true;
  });

  wsConnection.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleWebSocketMessage(message);
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

  return wsConnection;
}

/**
 * Handle incoming WebSocket messages
 */
function handleWebSocketMessage(message) {
  console.log('📡 Received WebSocket message from PumpPortal:');
  console.log('   Message type:', message.type || 'unknown');
  console.log('   Full message:', JSON.stringify(message, null, 2));
  
  // Handle token trade events from PumpPortal
  // PumpPortal sends trade data with marketCapSol field
  if (message.mint && message.marketCapSol !== undefined) {
    const tokenAddress = message.mint;
    const marketCapSol = message.marketCapSol;
    const txType = message.txType; // 'buy' or 'sell'
    const solAmount = message.solAmount;
    const tokenAmount = message.tokenAmount;
    
    console.log('📊 Processing PumpPortal trade data:');
    console.log('   Token Address:', tokenAddress);
    console.log('   Transaction Type:', txType);
    console.log('   SOL Amount:', solAmount);
    console.log('   Token Amount:', tokenAmount);
    console.log('   Market Cap (SOL):', marketCapSol);
    
    // Update cache with latest market cap data
    tokenPriceCache.set(tokenAddress, {
      marketCapSol: marketCapSol,
      lastTradeType: txType,
      lastSolAmount: solAmount,
      lastTokenAmount: tokenAmount,
      lastUpdated: new Date().toISOString()
    });
    
    console.log('✅ Updated cache for token:', tokenAddress);
    console.log('   Market cap in SOL:', marketCapSol);
    
    // Test market cap conversion immediately
    testMarketCapConversion(tokenAddress, marketCapSol);
  } else if (message.message === 'Successfully subscribed to keys.') {
    console.log('✅ Successfully subscribed to PumpPortal token trades');
  } else {
    console.log('⚠️  Unknown message type or missing data');
  }
}

/**
 * Subscribe to token trade data for specific tokens
 */
function subscribeToTokenTrades(tokenAddresses) {
  if (!isConnected || !wsConnection) {
    console.warn('⚠️  WebSocket not connected, attempting to connect...');
    initializeWebSocket();
    return;
  }

  console.log('📡 Subscribing to PumpPortal token trades:');
  console.log('   Tokens to subscribe:', tokenAddresses);
  console.log('   Number of tokens:', tokenAddresses.length);

  // Subscribe to specific token trades (this is the correct method for market cap data)
  const tradePayload = {
    method: "subscribeTokenTrade",
    keys: tokenAddresses
  };

  console.log('   Trade subscription payload:', JSON.stringify(tradePayload, null, 2));
  wsConnection.send(JSON.stringify(tradePayload));
  
  console.log(`📡 Subscribed to trade data for ${tokenAddresses.length} tokens`);
}

/**
 * Test market cap conversion for a token
 */
async function testMarketCapConversion(tokenAddress, marketCapSol) {
  try {
    console.log(`\n💱 Testing market cap conversion for ${tokenAddress}:`);
    console.log(`   Market cap in SOL: ${marketCapSol}`);
    
    // Calculate market cap in USD using Jupiter token price
    const marketCapResult = await tokenPriceService.calculateMarketCap(tokenAddress, marketCapSol);

    if (marketCapResult) {
      console.log('✅ Market cap conversion successful:');
      console.log(`   Market cap in SOL: ${marketCapResult.marketCapSol}`);
      console.log(`   SOL price: $${marketCapResult.solPrice.toFixed(2)} USD`);
      console.log(`   Token price: $${marketCapResult.tokenPrice.toFixed(6)} USD`);
      console.log(`   Market cap in USD: $${marketCapResult.marketCapUsd.toFixed(2)} USD`);
      
      // Verify calculation
      const expectedUsd = marketCapSol * marketCapResult.solPrice;
      console.log(`   Verification: ${marketCapSol} SOL × $${marketCapResult.solPrice.toFixed(2)} = $${expectedUsd.toFixed(2)} USD`);
      
      if (Math.abs(marketCapResult.marketCapUsd - expectedUsd) < 0.01) {
        console.log('✅ Calculation verification passed!');
      } else {
        console.log('❌ Calculation verification failed!');
      }
    } else {
      console.log('❌ Failed to calculate market cap');
    }
  } catch (error) {
    console.error(`❌ Error in market cap conversion:`, error.message);
  }
}

async function testMarketCapLogic() {
  console.log('🧪 Testing Market Cap Logic (WebSocket + Conversion)');
  console.log('===================================================');

  try {
    // Initialize WebSocket connection
    console.log('\n1️⃣ Initializing WebSocket connection...');
    initializeWebSocket();

    // Wait for connection to establish
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Subscribe to a test token that we know has trading activity
    console.log('\n2️⃣ Subscribing to test token...');
    const testToken = '6etEoWR2jd7nzL6hzi4kgcdJusrCLT2pqRg2BgU5pump';
    subscribeToTokenTrades([testToken]);

    // Wait for trade data and process it
    console.log('\n3️⃣ Waiting for trade data from PumpPortal...');
    console.log('   (This may take a few minutes if no trades are happening)');
    console.log('   Press Ctrl+C to stop after seeing some data...');
    
    // Keep the connection alive for a while to receive data
    await new Promise(resolve => {
      setTimeout(() => {
        console.log('\n⏰ Test timeout reached, disconnecting...');
        if (wsConnection) {
          wsConnection.close();
        }
        resolve();
      }, 30000); // 30 seconds
    });

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testMarketCapLogic()
  .then(() => {
    console.log('\n✅ Market cap logic test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }); 