const { marketCapScheduler } = require('../src/services/marketCap/scheduler');

async function testOneMinuteScheduler() {
  console.log('🧪 Testing 1-Minute Market Cap Scheduler');
  console.log('========================================');

  try {
    // Check current scheduler status
    console.log('\n1️⃣ Current scheduler status:');
    console.log(`   Is running: ${marketCapScheduler.isRunning}`);
    console.log(`   Update interval: ${marketCapScheduler.getUpdateInterval()} minutes`);
    console.log(`   Last job status:`, marketCapScheduler.lastJobStatus);

    // Start scheduler with 1-minute intervals
    console.log('\n2️⃣ Starting scheduler with 1-minute intervals...');
    await marketCapScheduler.start(1);
    
    console.log('✅ Scheduler started successfully');
    console.log(`   Is running: ${marketCapScheduler.isRunning}`);
    console.log(`   Update interval: ${marketCapScheduler.getUpdateInterval()} minutes`);

    // Monitor for a few minutes to see the updates
    console.log('\n3️⃣ Monitoring scheduler for 3 minutes...');
    console.log('   (You should see updates every minute)');
    
    const startTime = Date.now();
    const monitorDuration = 3 * 60 * 1000; // 3 minutes
    
    while (Date.now() - startTime < monitorDuration) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
      
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`   [${elapsed}s] Scheduler running: ${marketCapScheduler.isRunning}`);
      
      if (marketCapScheduler.lastJobStatus) {
        const lastJob = marketCapScheduler.lastJobStatus;
        console.log(`   [${elapsed}s] Last job: ${lastJob.status} (${lastJob.tokensUpdated || 0} tokens updated)`);
      }
    }

    // Stop the scheduler
    console.log('\n4️⃣ Stopping scheduler...');
    marketCapScheduler.stop();
    console.log('✅ Scheduler stopped successfully');

    // Test manual trigger
    console.log('\n5️⃣ Testing manual trigger...');
    const manualResult = await marketCapScheduler.triggerUpdate();
    console.log('✅ Manual trigger completed:');
    console.log(`   Status: ${manualResult.status}`);
    console.log(`   Tokens updated: ${manualResult.tokensUpdated || 0}`);
    console.log(`   Tokens processed: ${manualResult.tokensProcessed || 0}`);

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run the test
testOneMinuteScheduler()
  .then(() => {
    console.log('\n✅ 1-minute scheduler test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }); 