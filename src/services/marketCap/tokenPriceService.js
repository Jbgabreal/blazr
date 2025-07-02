const axios = require('axios');

// Jupiter API configuration
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112'; // SOL mint address

class TokenPriceService {
  constructor() {
    this.priceCache = new Map();
    this.lastUpdate = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Fetch token price from Jupiter Quote API
   */
  async fetchTokenPrice(tokenMint, amount = '1000000000') {
    try {
      console.log(`💰 Fetching price for token: ${tokenMint}`);
      
      const response = await axios.get(JUPITER_QUOTE_API, {
        params: {
          inputMint: tokenMint,
          outputMint: USDC_MINT,
          amount: amount, // 1 token (assuming 9 decimals)
          slippageBps: '50', // 0.5% slippage
          onlyDirectRoutes: 'false',
          asLegacyTransaction: 'false'
        },
        timeout: 10000
      });

      if (response.data && response.data.outAmount) {
        const tokenPrice = parseFloat(response.data.outAmount) / 1000000; // USDC has 6 decimals
        
        console.log(`✅ Token price updated: $${tokenPrice.toFixed(6)} USD`);
        return {
          price: tokenPrice,
          outAmount: response.data.outAmount,
          swapUsdValue: response.data.swapUsdValue,
          timestamp: new Date().toISOString()
        };
      } else {
        throw new Error('Invalid response format from Jupiter API - missing outAmount');
      }
    } catch (error) {
      console.error(`❌ Error fetching price for token ${tokenMint}:`, error.message);
      return null;
    }
  }

  /**
   * Get cached token price or fetch new one
   */
  async getTokenPrice(tokenMint, forceRefresh = false) {
    // Check cache first
    if (!forceRefresh && this.priceCache.has(tokenMint)) {
      const cached = this.priceCache.get(tokenMint);
      const lastUpdate = this.lastUpdate.get(tokenMint);
      
      if (lastUpdate && (Date.now() - lastUpdate) < this.cacheTimeout) {
        console.log(`📋 Using cached price for ${tokenMint}: $${cached.price.toFixed(6)} USD`);
        return cached;
      }
    }

    // Fetch new price
    const priceData = await this.fetchTokenPrice(tokenMint);
    
    if (priceData) {
      this.priceCache.set(tokenMint, priceData);
      this.lastUpdate.set(tokenMint, Date.now());
    }
    
    return priceData;
  }

  /**
   * Get SOL price in USD
   */
  async getSolPrice(forceRefresh = false) {
    return await this.getTokenPrice(SOL_MINT, forceRefresh);
  }

  /**
   * Calculate market cap in USD using only SOL price (no token price)
   */
  async calculateMarketCap(tokenMint, marketCapInSol) {
    try {
      // If market cap is 0, return 0 for USD as well
      if (marketCapInSol === 0) {
        console.log(`💱 Market cap calculation for ${tokenMint}:`);
        console.log(`   Market cap in SOL: 0`);
        console.log(`   Market cap in USD: $0.00`);
        return {
          marketCapUsd: 0,
          solPrice: 0,
          marketCapSol: 0,
          timestamp: new Date().toISOString()
        };
      }
      
      // Only fetch SOL price in USD
      const solPriceData = await this.getSolPrice();
      if (!solPriceData) {
        console.warn(`⚠️  No SOL price data available`);
        return null;
      }
      // Convert market cap from SOL to USD
      const marketCapInUsd = marketCapInSol * solPriceData.price;
      console.log(`💱 Market cap calculation for ${tokenMint}:`);
      console.log(`   Market cap in SOL: ${marketCapInSol}`);
      console.log(`   SOL price: $${solPriceData.price.toFixed(2)} USD`);
      console.log(`   Market cap in USD: $${marketCapInUsd.toFixed(2)} USD`);
      return {
        marketCapUsd: marketCapInUsd,
        solPrice: solPriceData.price,
        marketCapSol: marketCapInSol,
        timestamp: solPriceData.timestamp
      };
    } catch (error) {
      console.error(`❌ Error calculating market cap for ${tokenMint}:`, error.message);
      return null;
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      cachedTokens: this.priceCache.size,
      cacheTimeout: this.cacheTimeout,
      lastUpdates: Object.fromEntries(this.lastUpdate)
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.priceCache.clear();
    this.lastUpdate.clear();
    console.log('🗑️  Token price cache cleared');
  }
}

// Create singleton instance
const tokenPriceService = new TokenPriceService();

module.exports = { tokenPriceService }; 