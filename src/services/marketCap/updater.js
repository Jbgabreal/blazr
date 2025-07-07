const WebSocket = require('ws');
const { supabase } = require('../../config/database');
const { tokenPriceService } = require('./tokenPriceService');

// Pump Portal WebSocket configuration
const PUMP_PORTAL_WS_URL = 'wss://pumpportal.fun/api/data';

// Cache for token price data
const tokenPriceCache = new Map();
let wsConnection = null;
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 20;
let lastSubscribedTokens = [];

/**
 * Initialize WebSocket connection to PumpPortal with robust reconnection
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
    reconnectAttempts = 0;
    // Re-subscribe to last tokens if any
    if (lastSubscribedTokens.length > 0) {
      subscribeToTokenTrades(lastSubscribedTokens);
    }
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
    // Close to trigger reconnect
    if (wsConnection) wsConnection.close();
  });

  wsConnection.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    isConnected = false;
    if (reconnectAttempts < maxReconnectAttempts) {
      const delay = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts)); // exponential backoff, max 30s
      console.warn(`🔄 Attempting to reconnect to PumpPortal in ${delay / 1000}s (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
      setTimeout(() => {
        wsConnection = null;
        reconnectAttempts++;
        initializeWebSocket();
      }, delay);
    } else {
      console.error('❌ Max WebSocket reconnect attempts reached. Giving up.');
    }
  });

  return wsConnection;
}

/**
 * Handle incoming WebSocket messages
 */
function handleWebSocketMessage(message) {
  // Handle token trade events from PumpPortal
  // PumpPortal sends trade data with marketCapSol field
  if (message.mint && message.marketCapSol !== undefined) {
    const tokenAddress = message.mint;
    const marketCapSol = message.marketCapSol;
    const txType = message.txType; // 'buy' or 'sell'
    const solAmount = message.solAmount;
    const tokenAmount = message.tokenAmount;
    
    console.log('📊 [PumpPortal] Trade detected:', {
      token: tokenAddress.slice(0, 8) + '...',
      type: txType,
      solAmount: solAmount,
      marketCap: marketCapSol + ' SOL'
    });
    
    // Update cache with latest market cap data
    tokenPriceCache.set(tokenAddress, {
      marketCapSol: marketCapSol,
      lastTradeType: txType,
      lastSolAmount: solAmount,
      lastTokenAmount: tokenAmount,
      lastUpdated: new Date().toISOString()
    });
  } else if (message.message === 'Successfully subscribed to keys.') {
    console.log('✅ PumpPortal WebSocket connected and subscribed');
  } else {
    // Only log unknown messages in debug mode
    if (process.env.DEBUG_WEBSOCKET) {
      console.log('⚠️  Unknown WebSocket message:', message);
    }
  }
}

/**
 * Subscribe to token trade data for specific tokens (with memory for re-subscription)
 */
function subscribeToTokenTrades(tokenAddresses) {
  lastSubscribedTokens = tokenAddresses;
  if (!isConnected || !wsConnection) {
    console.warn('⚠️  WebSocket not connected, attempting to connect...');
    initializeWebSocket();
    return;
  }

  // Subscribe to specific token trades (this is the correct method for market cap data)
  const tradePayload = {
    method: "subscribeTokenTrade",
    keys: tokenAddresses
  };

  wsConnection.send(JSON.stringify(tradePayload));
  
  console.log(`📡 Subscribed to ${tokenAddresses.length} tokens on PumpPortal`);
}

/**
 * Get cached token price data
 */
function getCachedTokenPrice(tokenAddress) {
  return tokenPriceCache.get(tokenAddress) || null;
}

/**
 * Calculate market cap in USD using SOL price
 */
async function calculateMarketCapInUsd(tokenMint, marketCapInSol) {
  try {
    // If market cap is 0, return 0 for USD as well
    if (marketCapInSol === 0) {
      return {
        marketCapUsd: 0,
        marketCapSol: 0,
        solPrice: 0,
        timestamp: new Date().toISOString()
      };
    }
    
    const result = await tokenPriceService.calculateMarketCap(tokenMint, marketCapInSol);
    
    if (!result) {
      console.warn(`⚠️  Could not calculate market cap for ${tokenMint}`);
      return null;
    }
    
    return result;
  } catch (error) {
    console.error(`❌ Error calculating market cap for ${tokenMint}:`, error.message);
    return null;
  }
}

/**
 * Get tokens that need market cap updates
 */
async function getTokensNeedingUpdate() {
  try {
    const fifteenSecondsAgo = new Date(Date.now() - 15 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('created_tokens')
      .select('id, mint_address, token_name, market_cap, last_market_cap_update')
      .or(`last_market_cap_update.is.null,last_market_cap_update.lt.${fifteenSecondsAgo}`)
      .eq('is_test', false) // Only update real tokens, not test tokens
      .order('last_market_cap_update', { ascending: true, nullsFirst: true });

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Error fetching tokens needing update:', error);
    throw error;
  }
}

/**
 * Update market cap for a single token using cached data or fallback
 */
async function updateTokenMarketCap(tokenId, tokenAddress) {
  try {
    
    // First try to get cached market cap data from PumpPortal
    let cachedData = getCachedTokenPrice(tokenAddress);
    
    let marketCapSol = null;
    let dataSource = 'cached';
    
    if (cachedData && cachedData.marketCapSol !== undefined && cachedData.marketCapSol > 0) {
      // Use real market cap data from PumpPortal
      marketCapSol = cachedData.marketCapSol;
      dataSource = 'real-time';
      console.log(`📊 [${tokenAddress.slice(0, 8)}...] Using real-time data: ${marketCapSol} SOL`);
    } else {
      
      // Get current market cap from database to use as fallback
      const { data: currentToken, error: dbError } = await supabase
        .from('created_tokens')
        .select('market_cap, last_market_cap_update')
        .eq('id', tokenId)
        .single();
      
      if (dbError) {
        console.error(`❌ Error fetching current token data: ${dbError.message}`);
        marketCapSol = 0;
        dataSource = 'none';
      } else if (currentToken && currentToken.market_cap && currentToken.market_cap > 0) {
        // Use cached value from database (convert USD back to SOL for calculation)
        const solPriceData = await tokenPriceService.getSolPrice();
        if (solPriceData && solPriceData.price > 0) {
          marketCapSol = currentToken.market_cap / solPriceData.price;
          dataSource = 'cached';
        } else {
          marketCapSol = 0;
          dataSource = 'none';
        }
      } else {
        // No cached value available, use 0
        marketCapSol = 0;
        dataSource = 'none';
      }
    }

    // Calculate market cap in USD using SOL price
    const marketCapResult = await calculateMarketCapInUsd(tokenAddress, marketCapSol);

    if (!marketCapResult) {
      console.warn(`⚠️  Could not calculate market cap for ${tokenAddress}, skipping update`);
      return { updated: false, error: 'Could not calculate market cap' };
    }

    // Only update database if we have new real data or if we don't have any cached value
    const shouldUpdate = dataSource === 'real-time' || (dataSource === 'none' && marketCapSol === 0);
    
    if (shouldUpdate) {
      const { error } = await supabase
        .from('created_tokens')
        .update({
          market_cap: marketCapResult.marketCapUsd, // Store USD value in database
          last_market_cap_update: new Date().toISOString()
        })
        .eq('id', tokenId);

      if (error) {
        throw error;
      }
    }
    
    return { 
      updated: shouldUpdate, 
      marketCapUsd: marketCapResult.marketCapUsd,
      marketCapSol: marketCapResult.marketCapSol,
      dataSource
    };
  } catch (error) {
    console.error(`❌ Error updating market cap for token ${tokenAddress}:`, error);
    return { updated: false, error: error.message };
  }
}

/**
 * Main function to update market caps for all tokens
 */
async function updateMarketCaps() {
  const startTime = Date.now();
  let tokensUpdated = 0;
  let tokensProcessed = 0;
  const errors = [];

  try {
    // Initialize WebSocket connection
    initializeWebSocket();

    // Get tokens that need updates
    const tokens = await getTokensNeedingUpdate();
    
    if (tokens.length === 0) {
      return {
        tokensUpdated: 0,
        tokensProcessed: 0,
        errors: [],
        message: 'No tokens need updates'
      };
    }

    console.log(`📋 Processing ${tokens.length} tokens for market cap updates`);

    // Subscribe to trade data for all tokens
    const tokenAddresses = tokens.map(token => token.mint_address);
    subscribeToTokenTrades(tokenAddresses);

    // Wait a bit for real-time data to come in (if any trades happen)
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Process tokens
    for (const token of tokens) {
      tokensProcessed++;
      const result = await updateTokenMarketCap(token.id, token.mint_address);
      
      if (result.updated) {
        tokensUpdated++;
      } else if (result.error) {
        errors.push({
          tokenAddress: token.mint_address,
          error: result.error
        });
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Market cap update: ${tokensUpdated}/${tokensProcessed} updated in ${duration}ms`);

    return {
      tokensUpdated,
      tokensProcessed,
      errors,
      duration,
      message: `Updated ${tokensUpdated} out of ${tokensProcessed} tokens`
    };

  } catch (error) {
    console.error('❌ Market cap update process failed:', error);
    throw error;
  }
}

/**
 * Get market cap statistics
 */
async function getMarketCapStats() {
  try {
    const { data, error } = await supabase
      .from('created_tokens')
      .select('market_cap, last_market_cap_update')
      .eq('is_test', false)
      .not('market_cap', 'is', null);

    if (error) {
      throw error;
    }

    const totalMarketCap = data.reduce((sum, token) => sum + (token.market_cap || 0), 0);
    const tokensWithMarketCap = data.length;
    const lastUpdate = data.length > 0 
      ? new Date(Math.max(...data.map(t => new Date(t.last_market_cap_update || 0))))
      : null;

    return {
      totalMarketCap,
      tokensWithMarketCap,
      lastUpdate: lastUpdate?.toISOString(),
      averageMarketCap: tokensWithMarketCap > 0 ? totalMarketCap / tokensWithMarketCap : 0
    };
  } catch (error) {
    console.error('Error getting market cap stats:', error);
    throw error;
  }
}

module.exports = {
  updateMarketCaps,
  updateTokenMarketCap,
  getTokensNeedingUpdate,
  getMarketCapStats,
  initializeWebSocket,
  subscribeToTokenTrades,
  getCachedTokenPrice,
  calculateMarketCapInUsd
};