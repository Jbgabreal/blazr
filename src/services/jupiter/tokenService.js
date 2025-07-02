// JupiterTokenService: Syncs Jupiter token list and prices into supported_tickers
const fetch = require('node-fetch');
const { supabase } = require('../../config/database');

class JupiterTokenService {
  constructor() {
    this.tokenListUrl = 'https://token.jup.ag/strict';
    this.priceUrl = 'https://price.jup.ag/v4/price';
    this.lastSync = null;
    this.syncInterval = 1000 * 60 * 60; // 1 hour
  }

  async syncTokenList() {
    try {
      const response = await fetch(this.tokenListUrl);
      const tokens = await response.json();
      const transformedTokens = tokens.map(token => ({
        ticker: token.symbol,
        mint_address: token.address,
        name: token.name,
        decimals: token.decimals,
        logo_uri: token.logoURI,
        chain_id: token.chainId,
        tags: token.tags,
        extensions: token.extensions,
        last_updated: new Date().toISOString(),
        jupiter_listed: true
      }));
      await this.batchUpsertTokens(transformedTokens);
      this.lastSync = new Date();
      console.log(`[JUPITER] Synced ${transformedTokens.length} tokens from Jupiter`);
      return transformedTokens;
    } catch (error) {
      console.error('[JUPITER] Token list sync failed:', error);
      throw error;
    }
  }

  async getTokenPrices(mintAddresses) {
    try {
      const response = await fetch(this.priceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: mintAddresses })
      });
      const priceData = await response.json();
      return priceData.data;
    } catch (error) {
      console.error('[JUPITER] Price fetch failed:', error);
      return {};
    }
  }

  async batchUpsertTokens(tokens) {
    const { data, error } = await supabase
      .from('supported_tickers')
      .upsert(tokens, {
        onConflict: 'mint_address',
        ignoreDuplicates: false
      });
    if (error) throw error;
    return data;
  }
}

module.exports = { JupiterTokenService }; 