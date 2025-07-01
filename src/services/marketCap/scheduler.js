const { updateMarketCaps } = require('./updater');
const { supabase } = require('../../config/database');

class MarketCapScheduler {
  constructor() {
    this.interval = null;
    this.isRunning = false;
    this.lastJobStatus = null;
    this.updateInterval = 1; // minutes
  }

  async start(intervalMinutes = 1) {
    if (this.isRunning) {
      console.log('⚠️  Market cap scheduler is already running');
      return;
    }

    this.updateInterval = intervalMinutes;
    console.log(`🚀 Starting market cap scheduler with ${intervalMinutes} minute intervals`);

    // Start the first update immediately
    await this.performUpdate();

    // Schedule recurring updates
    this.interval = setInterval(async () => {
      await this.performUpdate();
    }, intervalMinutes * 60 * 1000);

    this.isRunning = true;
    console.log(`✅ Market cap scheduler started successfully`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('🛑 Market cap scheduler stopped');
  }

  async performUpdate() {
    const startTime = new Date();
    console.log(`📊 Starting market cap update at ${startTime.toISOString()}`);

    try {
      this.lastJobStatus = {
        status: 'running',
        startTime: startTime.toISOString(),
        tokensUpdated: 0,
        error: null
      };

      const result = await updateMarketCaps();
      
      this.lastJobStatus = {
        status: 'completed',
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        tokensUpdated: result.tokensUpdated,
        tokensProcessed: result.tokensProcessed,
        errors: result.errors || []
      };

      console.log(`✅ Market cap update completed: ${result.tokensUpdated} tokens updated`);
    } catch (error) {
      console.error('❌ Market cap update failed:', error);
      
      this.lastJobStatus = {
        status: 'failed',
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        tokensUpdated: 0,
        error: error.message
      };
    }
  }

  async triggerUpdate() {
    console.log('🔄 Manually triggering market cap update...');
    await this.performUpdate();
    return this.lastJobStatus;
  }

  getLastJobStatus() {
    return this.lastJobStatus;
  }

  isSchedulerRunning() {
    return this.isRunning;
  }

  getUpdateInterval() {
    return this.updateInterval;
  }
}

// Create singleton instance
const marketCapScheduler = new MarketCapScheduler();

// Auto-start in all environments
if (process.env.NODE_ENV !== 'test') {
      // Start with a small delay to ensure server is fully initialized
    setTimeout(() => {
      marketCapScheduler.start(1);
    }, 5000);
}

module.exports = { marketCapScheduler }; 