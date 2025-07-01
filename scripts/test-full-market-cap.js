const { updateMarketCaps, initializeWebSocket, subscribeToTokenTrades } = require('../src/services/marketCap/updater');

async function testFullMarketCapUpdate() {
  console.log('🧪 Testing Full Market Cap Update Process');
  console.log('=========================================');

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

    // Wait for some trade data to come in
    console.log('\n3️⃣ Waiting for trade data from PumpPortal...');
    console.log('   (This may take a few minutes if no trades are happening)');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Run the market cap update process
    console.log('\n4️⃣ Running market cap update process...');
    const result = await updateMarketCaps();

    console.log('\n📊 Market Cap Update Results:');
    console.log('=============================');
    console.log(`   Tokens processed: ${result.tokensProcessed}`);
    console.log(`   Tokens updated: ${result.tokensUpdated}`);
    console.log(`   Errors: ${result.errors.length}`);
    console.log(`   Duration: ${result.duration}ms`);
    console.log(`   Message: ${result.message}`);

    if (result.errors.length > 0) {
      console.log('\n❌ Errors encountered:');
      result.errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.tokenAddress}: ${error.error}`);
      });
    }

    // Test individual token update
    console.log('\n5️⃣ Testing individual token update...');
    const { updateTokenMarketCap } = require('../src/services/marketCap/updater');
    
    // Create a mock token ID for testing
    const mockTokenId = 999;
    const individualResult = await updateTokenMarketCap(mockTokenId, testToken);
    
    console.log('\n📊 Individual Token Update Result:');
    console.log('==================================');
    console.log(`   Updated: ${individualResult.updated}`);
    if (individualResult.updated) {
      console.log(`   Market Cap (USD): $${individualResult.marketCapUsd?.toFixed(2)}`);
      console.log(`   Market Cap (SOL): ${individualResult.marketCapSol}`);
      console.log(`   Token Price: $${individualResult.tokenPrice?.toFixed(6)} USD`);
      console.log(`   Data Source: ${individualResult.dataSource}`);
    } else {
      console.log(`   Error: ${individualResult.error}`);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Run the test
testFullMarketCapUpdate()
  .then(() => {
    console.log('\n✅ Full market cap update test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }); 