const axios = require('axios');

// Jupiter API configuration
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint address

class SolPriceService {
  constructor() {
    this.solPrice = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    this.isUpdating = false;
  }

  /**
   * Fetch SOL price from Jupiter Quote API
   */
  async fetchSolPrice() {
    try {
      console.log('💰 Fetching SOL price from Jupiter...');
      
      const response = await axios.get(JUPITER_QUOTE_API, {
        params: {
          inputMint: SOL_MINT,
          outputMint: USDC_MINT,
          amount: '1000000000', // 1 SOL (9 decimals)
          slippageBps: '50', // 0.5% slippage
          onlyDirectRoutes: 'false',
          asLegacyTransaction: 'false'
        },
        timeout: 10000
      });

      if (response.data && response.data.outAmount) {
        const solPrice = parseFloat(response.data.outAmount) / 1000000; // USDC has 6 decimals
        
        console.log(`✅ SOL price updated: $${solPrice.toFixed(2)}`);
        return solPrice;
      } else {
        throw new Error('Invalid response format from Jupiter API - missing outAmount');
      }
    } catch (error) {
      console.error('❌ Error fetching SOL price:', error.message);
      
      // Return cached price if available, otherwise throw
      if (this.solPrice) {
        console.log(`⚠️  Using cached SOL price: $${this.solPrice.toFixed(2)}`);
        return this.solPrice;
      }
      throw error;
    }
  }

  /**
   * Update SOL price
   */
  async updateSolPrice() {
    if (this.isUpdating) {
      console.log('⏳ SOL price update already in progress...');
      return this.solPrice;
    }

    this.isUpdating = true;
    
    try {
      const newPrice = await this.fetchSolPrice();
      this.solPrice = newPrice;
      this.lastUpdate = new Date().toISOString();
      
      return newPrice;
    } catch (error) {
      console.error('❌ Failed to update SOL price:', error.message);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Get current SOL price (cached or fetch new)
   */
  async getSolPrice() {
    // If we have a recent price (less than 5 minutes old), return it
    if (this.solPrice && this.lastUpdate) {
      const lastUpdateTime = new Date(this.lastUpdate);
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      if (lastUpdateTime > fiveMinutesAgo) {
        return this.solPrice;
      }
    }

    // Otherwise, fetch new price
    return await this.updateSolPrice();
  }

  /**
   * Convert SOL amount to USD
   */
  convertSolToUsd(solAmount) {
    if (!this.solPrice) {
      throw new Error('SOL price not available');
    }
    return solAmount * this.solPrice;
  }

  /**
   * Convert USD amount to SOL
   */
  convertUsdToSol(usdAmount) {
    if (!this.solPrice) {
      throw new Error('SOL price not available');
    }
    return usdAmount / this.solPrice;
  }

  /**
   * Start automatic SOL price updates every 5 minutes
   */
  startAutoUpdate() {
    if (this.updateInterval) {
      console.log('⚠️  SOL price auto-update already running');
      return;
    }

    console.log('🔄 Starting SOL price auto-update (every 5 minutes)');
    
    // Initial update
    this.updateSolPrice().catch(error => {
      console.error('❌ Initial SOL price update failed:', error.message);
    });

    // Set up recurring updates
    this.updateInterval = setInterval(async () => {
      try {
        await this.updateSolPrice();
      } catch (error) {
        console.error('❌ Recurring SOL price update failed:', error.message);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  /**
   * Stop automatic SOL price updates
   */
  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log('🛑 Stopped SOL price auto-update');
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      solPrice: this.solPrice,
      lastUpdate: this.lastUpdate,
      isAutoUpdating: !!this.updateInterval,
      isUpdating: this.isUpdating
    };
  }
}

// Create singleton instance
const solPriceService = new SolPriceService();

// Auto-start in all environments
if (process.env.NODE_ENV !== 'test') {
  solPriceService.startAutoUpdate();
}

module.exports = { solPriceService }; 