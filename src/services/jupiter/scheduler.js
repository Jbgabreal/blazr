const cron = require('node-cron');
const { JupiterTokenService } = require('./tokenService');

class JupiterSyncScheduler {
  constructor() {
    this.jupiterService = new JupiterTokenService();
    this.isRunning = false;
  }

  start() {
    // Sync token list daily at 2 AM
    cron.schedule('0 2 * * *', async () => {
      await this.syncTokenList();
    });
    // If you want to sync prices less frequently, comment out or adjust the next line:
    // cron.schedule('*/5 8-22 * * *', async () => {
    //   await this.syncPrices();
    // });
    console.log('[JUPITER] Scheduler started');
  }

  async syncTokenList() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.jupiterService.syncTokenList();
    } catch (error) {
      console.error('[JUPITER] Scheduled sync failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async syncPrices() {
    // Get all supported tokens and update their prices
    const { data: tokens } = await supabase
      .from('supported_tickers')
      .select('mint_address');
    if (tokens && tokens.length > 0) {
      const prices = await this.jupiterService.getTokenPrices(
        tokens.map(t => t.mint_address)
      );
      // Optionally: batch update prices in DB (not shown here)
    }
  }
}

module.exports = { JupiterSyncScheduler }; 