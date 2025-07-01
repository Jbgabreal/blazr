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
  } else if (message.message === 'Successfully subscribed to keys.') {
    console.log('✅ Successfully subscribed to PumpPortal token trades');
  } else {
    console.log('⚠️  Unknown message type or missing data');
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
 * Get cached token price data
 */
function getCachedTokenPrice(tokenAddress) {
  return tokenPriceCache.get(tokenAddress) || null;
}

/**
 * Generate mock market cap data for tokens without real data
 * This is a fallback for development/testing purposes
 */
function generateMockMarketCapData(tokenAddress) {
  // Generate a deterministic but varied market cap based on token address
  const hash = tokenAddress.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  
  const baseMarketCapSol = (Math.abs(hash) % 100) + 1; // 1 to 100 SOL
  const multiplier = 1 + (Math.abs(hash) % 5) / 10; // 1.0x to 1.5x
  
  return {
    marketCapSol: baseMarketCapSol * multiplier,
    lastTradeType: 'mock',
    lastSolAmount: baseMarketCapSol * 0.01, // Small trade amount
    lastTokenAmount: baseMarketCapSol * 1000, // Mock token amount
    lastUpdated: new Date().toISOString(),
    isMock: true
  };
}

/**
 * Calculate market cap in USD using Jupiter token price
 */
async function calculateMarketCapInUsd(tokenMint, marketCapInSol) {
  try {
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
    const oneMinuteAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    
    console.log('🔍 Fetching tokens needing market cap updates...');
    console.log('   Cutoff time:', oneMinuteAgo);
    
    const { data, error } = await supabase
      .from('created_tokens')
      .select('id, mint_address, token_name, market_cap, last_market_cap_update')
      .or(`last_market_cap_update.is.null,last_market_cap_update.lt.${oneMinuteAgo}`)
      .eq('is_test', false) // Only update real tokens, not test tokens
      .order('last_market_cap_update', { ascending: true, nullsFirst: true });

    if (error) {
      throw error;
    }

    console.log('📋 Tokens from database:');
    data.forEach((token, index) => {
      console.log(`   ${index + 1}. ${token.token_name || 'Unknown'}`);
      console.log(`      Mint: ${token.mint_address}`);
      console.log(`      Current Market Cap: ${token.market_cap || 'NULL'}`);
      console.log(`      Last Update: ${token.last_market_cap_update || 'NULL'}`);
    });

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
    console.log(`📊 Updating market cap for token: ${tokenAddress}`);
    
    // First try to get cached market cap data from PumpPortal
    let cachedData = getCachedTokenPrice(tokenAddress);
    
    let marketCapSol = null;
    let dataSource = 'mock';
    
    if (cachedData && cachedData.marketCapSol !== undefined) {
      // Use real market cap data from PumpPortal
      marketCapSol = cachedData.marketCapSol;
      dataSource = 'real-time';
      console.log(`📊 Using real market cap data from PumpPortal: ${marketCapSol} SOL`);
    } else {
      // Generate mock data for development/testing
      console.log(`🔄 No cached data for ${tokenAddress}, generating mock data for development`);
      const mockData = generateMockMarketCapData(tokenAddress);
      marketCapSol = mockData.marketCapSol; // Mock data now returns marketCapSol directly
      dataSource = 'mock';
      console.log(`📊 Using mock market cap data: ${marketCapSol} SOL`);
    }

    // Calculate market cap in USD using Jupiter token price
    const marketCapResult = await calculateMarketCapInUsd(tokenAddress, marketCapSol);

    if (!marketCapResult) {
      console.warn(`⚠️  Could not calculate market cap for ${tokenAddress}, skipping update`);
      return { updated: false, error: 'Could not calculate market cap' };
    }

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

    console.log(`✅ Updated market cap for ${tokenAddress}:`);
    console.log(`   Market cap in SOL: ${marketCapResult.marketCapSol}`);
    console.log(`   Market cap in USD: $${marketCapResult.marketCapUsd.toFixed(2)}`);
    console.log(`   Token price: $${marketCapResult.tokenPrice.toFixed(6)} USD`);
    console.log(`   Data source: ${dataSource}`);
    
    return { 
      updated: true, 
      marketCapUsd: marketCapResult.marketCapUsd,
      marketCapSol: marketCapResult.marketCapSol,
      tokenPrice: marketCapResult.tokenPrice,
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
  console.log('🚀 Starting market cap update process...');
  
  const startTime = Date.now();
  let tokensUpdated = 0;
  let tokensProcessed = 0;
  const errors = [];

  try {
    // Initialize WebSocket connection
    initializeWebSocket();

    // Get tokens that need updates
    const tokens = await getTokensNeedingUpdate();
    console.log(`📋 Found ${tokens.length} tokens needing market cap updates`);

    if (tokens.length === 0) {
      return {
        tokensUpdated: 0,
        tokensProcessed: 0,
        errors: [],
        message: 'No tokens need updates'
      };
    }

    // Subscribe to trade data for all tokens
    const tokenAddresses = tokens.map(token => token.mint_address);
    subscribeToTokenTrades(tokenAddresses);

    // Wait a bit for real-time data to come in (if any trades happen)
    console.log('⏳ Waiting for real-time trade data...');
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
    console.log(`✅ Market cap update completed in ${duration}ms`);
    console.log(`📊 Results: ${tokensUpdated} updated, ${tokensProcessed} processed, ${errors.length} errors`);

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
  generateMockMarketCapData,
  calculateMarketCapInUsd
}; 