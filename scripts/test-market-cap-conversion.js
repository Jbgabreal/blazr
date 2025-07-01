const { tokenPriceService } = require('../src/services/marketCap/tokenPriceService');

async function testMarketCapConversion() {
  console.log('🧪 Testing Market Cap Conversion (SOL to USD)');
  console.log('==============================================');

  // Test token from PumpPortal
  const testToken = '6etEoWR2jd7nzL6hzi4kgcdJusrCLT2pqRg2BgU5pump';
  const marketCapSol = 73.27822448584998; // Example from PumpPortal

  console.log(`🎯 Test token: ${testToken}`);
  console.log(`📊 Market cap in SOL: ${marketCapSol}`);

  try {
    // Test SOL price fetching
    console.log('\n1️⃣ Testing SOL price fetching...');
    const solPrice = await tokenPriceService.getSolPrice();
    
    if (solPrice) {
      console.log(`✅ SOL price: $${solPrice.price.toFixed(2)} USD`);
    } else {
      console.log('❌ Failed to fetch SOL price');
      return;
    }

    // Test token price fetching
    console.log('\n2️⃣ Testing token price fetching...');
    const tokenPrice = await tokenPriceService.getTokenPrice(testToken);
    
    if (tokenPrice) {
      console.log(`✅ Token price: $${tokenPrice.price.toFixed(6)} USD`);
    } else {
      console.log('⚠️  Could not fetch token price (this is normal for new tokens)');
    }

    // Test market cap calculation
    console.log('\n3️⃣ Testing market cap calculation...');
    const marketCapResult = await tokenPriceService.calculateMarketCap(testToken, marketCapSol);
    
    if (marketCapResult) {
      console.log('✅ Market cap calculation successful:');
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

    // Test with different market cap values
    console.log('\n4️⃣ Testing with different market cap values...');
    const testValues = [1, 10, 50, 100, 500];
    
    for (const testSol of testValues) {
      const result = await tokenPriceService.calculateMarketCap(testToken, testSol);
      if (result) {
        console.log(`   ${testSol} SOL = $${result.marketCapUsd.toFixed(2)} USD`);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testMarketCapConversion()
  .then(() => {
    console.log('\n✅ Market cap conversion test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }); 