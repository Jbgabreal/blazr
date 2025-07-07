const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const { createClient } = require('@supabase/supabase-js');
const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, createTransferInstruction } = require('@solana/spl-token');
const { Helius } = require('helius-sdk');
const OpenAI = require('openai');
const { encode } = require('bs58');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const child_process = require('child_process');
const bs58 = require('bs58');
const { Buffer } = require('buffer');
const fetch = require('node-fetch');
const { JupiterTokenService } = require('./src/services/jupiter/tokenService');
const { JupiterSyncScheduler } = require('./src/services/jupiter/scheduler');
const { solPriceService } = require('./src/services/marketCap/solPriceService');

// Debug logging for environment variables
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_KEY:', process.env.SUPABASE_KEY);
console.log('HELIUS_API_KEY:', process.env.HELIUS_API_KEY);

const app = express();
const PORT = process.env.PORT || 4000;

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Initialize clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const helius = new Helius(process.env.HELIUS_API_KEY);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Enable CORS with origins from environment variable
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: function (origin, callback) {
    console.log('[CORS DEBUG]', { origin, allowedOrigins });
    if (!origin) return callback(null, true);
    // Always allow any Chrome extension
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    // Allow exact matches
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow prefix matches for preview URLs
    if (allowedOrigins.some(prefix => prefix && origin.startsWith(prefix))) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Parse JSON bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from uploads directory
app.use('/uploads', express.static(uploadDir));

// Serve static assets for frontend compatibility
app.use('/assets', express.static(path.join(__dirname, '../src/assets')));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// --- Supabase Caching Helpers (Removed token metadata caching) ---

async function getCachedTokenBalance(publicKey, mint) {
  try {
    const { data, error } = await supabase
      .from('token_balances')
      .select('*')
      .eq('public_key', publicKey)
      .eq('mint', mint)
      .single();
    if (error || !data) return null;
    if (data.last_updated && Date.now() - new Date(data.last_updated).getTime() < CACHE_TTL_MS) {
      return data.balance;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function setCachedTokenBalance(publicKey, mint, balance) {
  try {
    await supabase.from('token_balances').upsert({
      public_key: publicKey,
      mint,
      balance,
      last_updated: new Date().toISOString(),
    });
  } catch (e) {}
}

// Add price caching constants
const PRICE_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute cache

// Add price caching functions
async function getCachedTokenPrices(tokenAddresses) {
  try {
    const { data, error } = await supabase
      .from('token_prices')
      .select('*')
      .in('token_address', tokenAddresses)
      .gte('last_updated', new Date(Date.now() - PRICE_CACHE_TTL_MS).toISOString());

    if (error) {
      console.error('Error fetching cached prices:', error);
      return {};
    }

    const priceMap = {};
    data.forEach(record => {
      priceMap[record.token_address] = {
        usdPrice: record.usd_price,
        name: record.name,
        symbol: record.symbol,
        logo: record.logo,
        priceChange24h: record.price_change_24h
      };
    });

    return priceMap;
  } catch (e) {
    console.error('Error in getCachedTokenPrices:', e);
    return {};
  }
}

async function cacheTokenPrices(priceData) {
  try {
    const now = new Date().toISOString();
    const records = Object.entries(priceData).map(([address, data]) => ({
      token_address: address,
      usd_price: data.usdPrice,
      name: data.name,
      symbol: data.symbol,
      logo: data.logo,
      price_change_24h: data.priceChange24h,
      last_updated: now
    }));

    if (records.length > 0) {
      const { error } = await supabase
        .from('token_prices')
        .upsert(records, {
          onConflict: 'token_address',
          ignoreDuplicates: false
        });

      if (error) {
        console.error('Error caching token prices:', error);
      }
    }
  } catch (e) {
    console.error('Error in cacheTokenPrices:', e);
  }
}

// Wallet token caching removed - always fetch fresh data

// --- Token Generation Endpoint ---
app.post('/api/generate-token-data', async (req, res) => {
  try {
    const { text, mediaUrls, tweetUrl, authorName, authorAvatar, imageFile } = req.body;
    console.log('Received token generation request:', { tweetUrl, authorName });

    if (!text || !tweetUrl || !authorName) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['text', 'tweetUrl', 'authorName']
      });
    }

    // Check if tweet already exists in database
    const { data: existingTweet, error: queryError } = await supabase
      .from('processed_tweets')
      .select('*')
      .eq('tweet_url', tweetUrl)
      .single();

    if (queryError && queryError.code !== 'PGRST116') {
      console.error('Database query error:', queryError);
      throw new Error('Failed to check existing tweet');
    }

    if (existingTweet) {
      return res.json({
        name: existingTweet.token_name,
        ticker: existingTweet.token_ticker,
        description: existingTweet.token_description,
        image: existingTweet.token_image,
        website: existingTweet.token_twitter,
        pumpPortalTx: existingTweet.pump_portal_tx || null
      });
    }

    // Generate meme token data with OpenAI
    const prompt = `Given this tweet:\nText: "${text}"\nAuthor: ${authorName}\nGenerate a meme token based on this tweet with the following format:\n{\n  "name": "A catchy, meme-worthy name based on the tweet's theme or author (max 3 words)",\n  "ticker": "A 3-6 letter acronym or playful reference to the name",\n  "description": "A one-sentence meme-worthy summary of the tweet (max 15 words)"\n}\nMake it funny and viral-worthy.`;
    let tokenData;
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a creative meme token generator. Generate funny, viral-worthy token names and descriptions based on tweets." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
      });
      const response = completion.choices[0].message.content;
      tokenData = JSON.parse(response);
    } catch (error) {
      console.error('OpenAI API error:', error);
      throw new Error('Failed to generate token data');
    }

    // Use imageFile (base64) for the image
    if (!imageFile) {
      return res.status(400).json({ error: 'Image file is required (base64 string)' });
    }

    // Step 1: Upload metadata to pump.fun IPFS
    let metadataUri;
    try {
      const formData = new FormData();
      formData.append('name', tokenData.name);
      formData.append('symbol', tokenData.ticker);
      formData.append('description', tokenData.description);
      formData.append('twitter', tweetUrl);
      formData.append('showName', 'true');

      // Write base64 image to file
      const imageBuffer = Buffer.from(imageFile.split(',')[1], 'base64');
      const tmpImagePath = path.join(uploadDir, `tmp_${Date.now()}.png`);
      fs.writeFileSync(tmpImagePath, imageBuffer);
      formData.append('file', fs.createReadStream(tmpImagePath), 'image.png');

      const ipfsResp = await axios.post('https://pump.fun/api/ipfs', formData, { headers: formData.getHeaders() });
      fs.unlinkSync(tmpImagePath);
      metadataUri = ipfsResp.data.metadataUri;
    } catch (error) {
      console.error('IPFS upload error:', error);
      throw new Error('Failed to upload metadata to IPFS');
    }

    // Step 2: Generate mint keypair
    const mintKeypair = Keypair.generate();
    const mintBase58 = encode(mintKeypair.secretKey);

    // Step 3: POST to pumpportal.fun/api/trade
    let tradeResp;
    try {
      const tradePayload = {
        action: 'create',
        tokenMetadata: {
          name: tokenData.name,
          symbol: tokenData.ticker,
          uri: metadataUri
        },
        mint: mintBase58,
        denominatedInSol: 'true',
        amount: 1, // dev buy 1 SOL
        slippage: 10,
        priorityFee: 0.0001,
        pool: 'pump'
      };
      tradeResp = await axios.post(
        'https://pumpportal.fun/api/trade',
        tradePayload,
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      console.error('Pump Portal API error:', error);
      throw new Error('Failed to create token on Pump Portal');
    }

    // Step 4: Store in database
    try {
      await supabase.from('processed_tweets').insert({
        tweet_url: tweetUrl,
        tweet_text: text,
        author_name: authorName,
        author_avatar: authorAvatar,
        media_urls: mediaUrls,
        token_name: tokenData.name,
        token_ticker: tokenData.ticker,
        token_description: tokenData.description,
        token_image: imageFile,
        token_twitter: tweetUrl,
        pump_portal_tx: tradeResp.data
      });
    } catch (error) {
      console.error('Database insert error:', error);
      throw new Error('Failed to store token data in database');
    }

    res.json({
      ...tokenData,
      pumpPortalTx: tradeResp.data
    });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(500).json({
      error: 'Failed to generate token',
      message: error.message
    });
  }
});

// --- Generate Token Metadata Only Endpoint ---
app.post('/api/generate-token-metadata', async (req, res) => {
  console.log('[TokenMeta] Incoming request:', req.body);
  try {
    const { text, mediaUrls, tweetUrl, postUrl, authorName, authorAvatar } = req.body;
    // --- Twitter logic (existing) ---
    if (tweetUrl) {
      if (!text || !tweetUrl || !authorName) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['text', 'tweetUrl', 'authorName']
        });
      }
      // Check if tweet already exists in database
      const { data: existingTweet, error: queryError } = await supabase
        .from('processed_tweets')
        .select('*')
        .eq('tweet_url', tweetUrl)
        .single();
      if (existingTweet) {
        return res.json({
          name: existingTweet.token_name,
          ticker: existingTweet.token_ticker,
          description: existingTweet.token_description,
          image: existingTweet.token_image,
          twitterUrl: existingTweet.token_twitter || tweetUrl
        });
      }
      // Generate meme token data with OpenAI (Twitter)
      const prompt = `Given this tweet:\nText: "${text}"\nAuthor: ${authorName}\nGenerate a meme token based on this tweet with the following format:\n{\n  "name": "A catchy, meme-worthy name based on the tweet's theme or author (max 3 words)",\n  "ticker": "A 3-6 letter acronym or playful reference to the name",\n  "description": "A one-sentence meme-worthy summary of the tweet (max 15 words)"\n}\nMake it funny and viral-worthy.`;
      console.log('[OpenAI][Twitter] Prompt being sent:', prompt);
      console.log('[OpenAI][Twitter] Data:', { text, mediaUrls, tweetUrl, authorName, authorAvatar });
      let tokenData;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: "You are a creative meme token generator. Generate funny, viral-worthy token names and descriptions based on tweets." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
        });
        const response = completion.choices[0].message.content;
        console.log('[OpenAI][Twitter] Raw response:', response);
        tokenData = JSON.parse(response);
        console.log('[OpenAI][Twitter] Parsed tokenData:', tokenData);
      } catch (error) {
        console.error('OpenAI API error:', error);
        throw new Error('Failed to generate token data');
      }
      // Pick best image: first media or author avatar
      tokenData.image = (mediaUrls && mediaUrls.length > 0) ? mediaUrls[0] : authorAvatar;
      tokenData.twitterUrl = tweetUrl;
      // Cache the generated metadata in Supabase
      try {
        await supabase.from('processed_tweets').insert({
          tweet_url: tweetUrl,
          tweet_text: text,
          author_name: authorName,
          author_avatar: authorAvatar,
          media_urls: mediaUrls,
          token_name: tokenData.name,
          token_ticker: tokenData.ticker,
          token_description: tokenData.description,
          token_image: tokenData.image,
          token_twitter: tweetUrl
        });
      } catch (e) {
        console.warn('Failed to cache token metadata in Supabase:', e.message);
      }
      const twitterResponse = {
        name: tokenData.name,
        ticker: tokenData.ticker,
        description: tokenData.description,
        image: tokenData.image,
        twitterUrl: tokenData.twitterUrl
      };
      console.log('[OpenAI][Twitter] Final response to client:', twitterResponse);
      res.json(twitterResponse);
      return;
    }
    // --- Reddit logic (new) ---
    if (postUrl) {
      if (!text || !postUrl || !authorName) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['text', 'postUrl', 'authorName']
        });
      }
      // Generate meme token data with OpenAI (Reddit)
      const prompt = `Given this Reddit post:\nText: "${text}"\nAuthor: ${authorName}\nGenerate a meme token based on this post with the following format:\n{\n  "name": "A catchy, meme-worthy name based on the post's theme or author (max 3 words)",\n  "ticker": "A 3-6 letter acronym or playful reference to the name",\n  "description": "A one-sentence meme-worthy summary of the post (max 15 words)"\n}\nMake it funny and viral-worthy.`;
      console.log('[OpenAI][Reddit] Prompt being sent:', prompt);
      console.log('[OpenAI][Reddit] Data:', { text, mediaUrls, postUrl, authorName, authorAvatar });
      let tokenData;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            { role: "system", content: "You are a creative meme token generator. Generate funny, viral-worthy token names and descriptions based on Reddit posts." },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
        });
        const response = completion.choices[0].message.content;
        console.log('[OpenAI][Reddit] Raw response:', response);
        tokenData = JSON.parse(response);
        console.log('[OpenAI][Reddit] Parsed tokenData:', tokenData);
      } catch (error) {
        console.error('OpenAI API error:', error);
        throw new Error('Failed to generate token data');
      }
      // Pick best image: first media or author avatar
      tokenData.image = (mediaUrls && mediaUrls.length > 0) ? mediaUrls[0] : authorAvatar;
      tokenData.redditUrl = postUrl;
      const redditResponse = {
        name: tokenData.name,
        ticker: tokenData.ticker,
        description: tokenData.description,
        image: tokenData.image,
        redditUrl: tokenData.redditUrl
      };
      console.log('[OpenAI][Reddit] Final response to client:', redditResponse);
      res.json(redditResponse);
      return;
    }
    // fallback
    return res.status(400).json({ error: 'Missing tweetUrl or postUrl' });
  } catch (error) {
    console.error('Token metadata generation error:', error);
    res.status(500).json({
      error: 'Failed to generate token metadata',
      message: error.message
    });
  }
});

// --- Proxy Image Endpoint ---
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return res.status(500).send('Failed to fetch image');
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    response.body.pipe(res);
  } catch (err) {
    res.status(500).send('Failed to fetch image');
  }
});

// --- SOL Transfer Endpoint ---
app.post('/api/transactions/send-sol', async (req, res) => {
  try {
    const { fromPublicKey, toPublicKey, amount, secretKey } = req.body;

    if (!fromPublicKey || !toPublicKey || !amount || !secretKey) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log('Attempting to send SOL transaction...');

    const fromKeypair = new PublicKey(fromPublicKey);
    const toKeypair = new PublicKey(toPublicKey);
    const amountInLamports = amount * LAMPORTS_PER_SOL;

    // Create transfer instruction
    const transferInstruction = SystemProgram.transfer({
      fromPubkey: fromKeypair,
      toPubkey: toKeypair,
      lamports: amountInLamports,
    });

    // Create signer from secret key
    const secretKeyUint8 = Uint8Array.from(secretKey);
    const signer = { publicKey: fromKeypair, secretKey: secretKeyUint8 };

    // Send options
    const sendOptions = {
      skipPreflight: true,
      maxRetries: 0
    };

    console.log('Sending transaction using Helius Smart Transactions...');
    const signature = await helius.rpc.sendSmartTransaction(
      [transferInstruction],
      [signer],
      [], // No lookup tables needed for simple transfer
      sendOptions
    );

    console.log('Transaction sent successfully! Signature:', signature);
    res.json({ signature });
  } catch (error) {
    console.error('Failed to send SOL:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.toString()
    });
  }
});

// --- SPL Token Transfer Endpoint ---
app.post('/api/transactions/send-spl', async (req, res) => {
  try {
    const { fromPublicKey, toPublicKey, tokenMint, amount, decimals, secretKey } = req.body;

    if (!fromPublicKey || !toPublicKey || !tokenMint || !amount || !decimals || !secretKey) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const connection = await getConnection();
    const fromKeypair = new PublicKey(fromPublicKey);
    const toKeypair = new PublicKey(toPublicKey);
    const mintKeypair = new PublicKey(tokenMint);
    const amountInSmallestUnit = amount * Math.pow(10, decimals);

    // Get or create token accounts
    const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      { publicKey: fromKeypair, secretKey: Uint8Array.from(secretKey) },
      mintKeypair,
      fromKeypair
    );

    const toTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      { publicKey: fromKeypair, secretKey: Uint8Array.from(secretKey) },
      mintKeypair,
      toKeypair
    );

    // Create transaction
    const transaction = new Transaction().add(
      createTransferInstruction(
        fromTokenAccount.address,
        toTokenAccount.address,
        fromKeypair,
        BigInt(amountInSmallestUnit)
      )
    );

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromKeypair;

    // Sign transaction with stored keypair
    const secretKeyUint8 = Uint8Array.from(secretKey);
    transaction.sign({ publicKey: fromKeypair, secretKey: secretKeyUint8 });

    // Send and confirm transaction
    const signature = await connection.sendTransaction(transaction);
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    });

    if (confirmation.value.err) {
      throw new Error('Transaction failed: ' + JSON.stringify(confirmation.value.err));
    }

    res.json({ signature });
  } catch (error) {
    console.error('Failed to send SPL token:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Token Accounts Endpoint ---
app.post('/api/rpc/token-accounts', async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner) {
      return res.status(400).json({ error: 'Owner public key is required' });
    }
    
    // Always fetch fresh data (no caching)
    const tokenAccountsResponse = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        jsonrpc: "2.0",
        id: "token-accounts-1",
        method: "getTokenAccountsByOwner",
        params: [
          owner,
          {
            programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          },
          {
            encoding: "jsonParsed"
          }
        ]
      }
    );
    if (!tokenAccountsResponse.data || !tokenAccountsResponse.data.result || !tokenAccountsResponse.data.result.value) {
      throw new Error('Invalid response from Helius token accounts');
    }
    // First collect all tokens with positive balances
    const tokensMap = tokenAccountsResponse.data.result.value.reduce((acc, account) => {
      try {
        if (!account.account.data.parsed || !account.account.data.parsed.info) {
          return acc;
        }

        const tokenData = account.account.data.parsed.info;
        const mint = tokenData.mint;
        const tokenAmount = tokenData.tokenAmount;
        
        if (tokenAmount.uiAmount > 0) {
          acc[mint] = {
            mint,
            owner: tokenData.owner,
            amount: tokenAmount.amount,
            decimals: tokenAmount.decimals,
            uiAmount: tokenAmount.uiAmount,
          };
        }
        
        return acc;
      } catch (err) {
        console.warn('Error processing token account:', err);
        return acc;
      }
    }, {});

    // Get mints array for price lookup and metadata
    const mints = Object.keys(tokensMap);
    
    if (mints.length === 0) {
      return res.json({ tokens: {} });
    }

    // Fetch prices from Moralis
    const priceData = await fetchTokenPrices(mints);
    // Fetch metadata from Helius
    const heliusMetaResp = await axios.post(
      `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`,
      { mintAccounts: mints }
    );
    const heliusMetaArr = heliusMetaResp.data;
    const heliusMetaMap = {};
    heliusMetaArr.forEach(meta => { heliusMetaMap[meta.mint] = meta; });
    // Helper to resolve IPFS URLs
    function resolveIpfsUrl(url) {
      if (!url) return '';
      if (url.startsWith('ipfs://')) {
        return url.replace('ipfs://', 'https://ipfs.io/ipfs/');
      }
      return url;
    }

    // Merge metadata and price data
    const tokens = {};
    for (const [mint, tokenData] of Object.entries(tokensMap)) {
      const price = priceData[mint] || {};
      const meta = heliusMetaMap[mint] || {};
      let image = meta.offChainData?.image || meta.legacyMetadata?.logoURI || '';
      if (!image && meta.onChainData?.data?.uri) {
        image = meta.onChainData.data.uri;
      }
      image = resolveIpfsUrl(image);
      tokens[mint] = {
        ...tokenData,
        name: meta.offChainData?.name || meta.legacyMetadata?.name || 'Unknown Token',
        symbol: meta.offChainData?.symbol || meta.legacyMetadata?.symbol || mint.slice(0, 4),
        image,
        usdPrice: price.usdPrice || null, // Use Moralis usdPrice (per token)
        priceChange24h: price.priceChange24h || price.usdPrice24hrPercentChange || null,
        usdValue: price.usdPrice ? tokenData.uiAmount * price.usdPrice : null
      };
    }

    // Fetch SOL balance using Helius
    const solBalanceResponse = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
      {
        jsonrpc: "2.0",
        id: "sol-balance-1",
        method: "getBalance",
        params: [owner]
      }
    );
    const solLamports = solBalanceResponse.data?.result?.value || 0;
    const solAmount = solLamports / 1e9;

    // Fetch SOL price from Moralis
    let solPrice = 0;
    try {
      solPrice = await solPriceService.getSolPrice();
    } catch (e) {
      console.error('[BalanceCheck] Failed to fetch SOL price from Jupiter:', e.message);
      return res.status(503).json({
        error: 'Failed to fetch SOL price. Please try again later.',
        errorCode: 'SOL_PRICE_UNAVAILABLE'
      });
    }
    const solUsdValue = solAmount * solPrice;

    // Add SOL token (keep hardcoded image)
    const solToken = {
      mint: 'So11111111111111111111111111111111111111112',
      owner: owner,
      amount: solAmount.toString(),
      decimals: 9,
      uiAmount: solAmount,
      symbol: 'SOL',
      name: 'Solana',
      image: 'https://turquoise-faithful-whitefish-884.mypinata.cloud/ipfs/bafkreifxayewmnlfvwyydnkkq3f2vgbzk76pcpizfkpj4hlucaczw6kzim',
      usdPrice: solPrice,
      usdValue: solUsdValue,
    };
    const allTokens = [solToken, ...Object.values(tokens)];

    // No caching - return fresh data
    res.json({ tokens: allTokens });
  } catch (error) {
    console.error('Token accounts fetch error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch token accounts',
      details: error.message 
    });
  }
});

// --- Endpoint for trade-local ---
app.post('/api/trade-local', upload.single('imageFile'), async (req, res) => {
  try {
    const { publicKey, amount } = req.body;
    // Validate publicKey
    let userPubkey;
    try {
      if (!publicKey) throw new Error('Missing publicKey');
      const solanaWeb3 = require('@solana/web3.js');
      userPubkey = new solanaWeb3.PublicKey(publicKey);
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid or missing publicKey in request.',
        errorCode: 'INVALID_PUBLIC_KEY'
      });
    }
    // 1. Fetch user's SOL balance
    const solanaWeb3 = require('@solana/web3.js');
    const connection = new solanaWeb3.Connection(process.env.SWAP_SOLANA_RPC_URL, 'confirmed');
    const balanceLamports = await connection.getBalance(userPubkey);
    const solBalance = balanceLamports / solanaWeb3.LAMPORTS_PER_SOL;
    // 2. Fetch current SOL/USD price from Jupiter (via solPriceService)
    let solPrice = 0;
    try {
      solPrice = await solPriceService.getSolPrice();
    } catch (e) {
      console.error('[BalanceCheck] Failed to fetch SOL price from Jupiter:', e.message);
      return res.status(503).json({
        error: 'Failed to fetch SOL price. Please try again later.',
        errorCode: 'SOL_PRICE_UNAVAILABLE'
      });
    }
    // 3. Calculate minimum required SOL
    const minSol = 4 / solPrice;
    const inputAmount = Number(amount) || 0;
    const requiredSol = inputAmount > 0 ? inputAmount + minSol : minSol;
    // 4. Check if user has enough SOL
    if (solBalance <= requiredSol) {
      return res.status(400).json({
        error: `Insufficient SOL balance. You need at least ${(requiredSol).toFixed(4)} SOL (including your buy amount and $4 for fees) to create a token. Your balance: ${solBalance.toFixed(4)} SOL`,
        errorCode: 'INSUFFICIENT_BALANCE',
        requiredSol: requiredSol,
        solBalance: solBalance,
        solPrice: solPrice
      });
    }
    // Validate required fields
    if (!req.body.publicKey) {
      throw new Error('Public key is required');
    }
    if (!req.body.action) {
      throw new Error('Action is required');
    }
    if (req.body.amount === undefined || req.body.amount === null) {
      throw new Error('Amount is required');
    }
    if (!['buy', 'sell', 'create'].includes(req.body.action)) {
      throw new Error('Invalid action. Must be either "buy", "sell", or "create"');
    }

    // For token creation, first upload metadata to Pump.fun IPFS
    let metadataUri;
    if (req.body.action === 'create' && req.body.tokenMetadata) {
      try {
        const tokenMetadata = JSON.parse(req.body.tokenMetadata);
        const formData = new FormData();
        formData.append('name', tokenMetadata.name);
        formData.append('symbol', tokenMetadata.symbol);
        // Append 'powered by Blazr' on a new line after the user's description, only if not already present
        let description = tokenMetadata.description || '';
        if (!description.toLowerCase().includes('powered by blazr')) {
          description = description.trim() + '\n\npowered by Blazr';
        }
        formData.append('description', description);
        formData.append('twitter', tokenMetadata.twitter || '');
        formData.append('showName', 'true');
        
        // Use the uploaded image file
        if (req.file) {
          formData.append('file', req.file.buffer, { filename: 'token.png', contentType: req.file.mimetype });
          
          const ipfsResp = await axios.post('https://pump.fun/api/ipfs', formData, { 
            headers: formData.getHeaders() 
          });
          metadataUri = ipfsResp.data.metadataUri;
          console.log('IPFS upload successful, metadataUri:', metadataUri);
        } else {
          throw new Error('Image file is required for token creation');
        }
      } catch (error) {
        console.error('IPFS upload error:', error);
        throw new Error('Failed to upload metadata to IPFS: ' + error.message);
      }
    }

    // Parse other fields from FormData
    const secretKey = JSON.parse(req.body.secretKey || '[]');
    const mintSecretKey = JSON.parse(req.body.mintSecretKey || '[]');
    const computeBudget = JSON.parse(req.body.computeBudget || '{}');
    const instructions = JSON.parse(req.body.instructions || '[]');

    // Build the request for Pump Portal
    let requestBodyForPumpPortal = {
      publicKey: req.body.publicKey,
      action: req.body.action,
      mint: req.body.mint,
      denominatedInSol: String(req.body.denominatedInSol),
      amount: Number(req.body.amount),
      slippage: req.body.slippage !== undefined ? Number(req.body.slippage) : 10,
      priorityFee: Number(req.body.priorityFee || 0),
      pool: req.body.pool || 'auto',
      computeUnits: req.body.computeUnits !== undefined ? Number(req.body.computeUnits) : 600000,
      maxComputeUnits: req.body.maxComputeUnits !== undefined ? Number(req.body.maxComputeUnits) : 600000,
      skipPreflight: req.body.skipPreflight === 'true',
      computeBudget: computeBudget,
      instructions: instructions,
      skipInitialBuy: req.body.skipInitialBuy === 'true'
    };

    // Add metadataUri for token creation
    if (req.body.action === 'create' && metadataUri) {
      requestBodyForPumpPortal.tokenMetadata = {
        name: JSON.parse(req.body.tokenMetadata).name,
        symbol: JSON.parse(req.body.tokenMetadata).symbol,
        uri: metadataUri
      };
    }

    const pumpPortalStart = Date.now();
    console.log('Sending request to Pump Portal:', requestBodyForPumpPortal);
    console.time('[launchtimer][backend] Pump Portal API Call');
    console.log('🚨 About to POST to PumpPortal in /api/trade-local:', JSON.stringify(requestBodyForPumpPortal));
    let pumpPortalResponse;
    try {
      pumpPortalResponse = await axios.post('https://pumpportal.fun/api/trade-local', requestBodyForPumpPortal, {
        timeout: 60000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        responseType: 'arraybuffer'
      });

    } catch (err) {
      console.error('🚨 PumpPortal axios.post error:', {
        message: err.message,
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        config: {
          url: err.config?.url,
          method: err.config?.method,
          timeout: err.config?.timeout
        }
      });
      throw err;
    }
    console.timeEnd('[launchtimer][backend] Pump Portal API Call');
    const pumpPortalDuration = Date.now() - pumpPortalStart;
    if (pumpPortalDuration > 2000) {
      console.warn(`[launchtimer][backend] BLOCKER: Pump Portal API Call took ${pumpPortalDuration}ms`);
    }
    timing.pumpPortal = Date.now() - pumpPortalStart;
    console.log('Received response from Pump Portal');

    // Log the response info from PumpPortal for debugging
    console.log('[PumpPortal][trade-local] Response info:', {
      status: pumpPortalResponse.status,
      statusText: pumpPortalResponse.statusText,
      headers: pumpPortalResponse.headers,
      dataLength: pumpPortalResponse.data.length,
      dataType: typeof pumpPortalResponse.data,
      isBuffer: Buffer.isBuffer(pumpPortalResponse.data),
      isArrayBuffer: pumpPortalResponse.data instanceof ArrayBuffer
    });
    
    // Only log a small preview of binary data to avoid spam
    if (Buffer.isBuffer(pumpPortalResponse.data) || pumpPortalResponse.data instanceof ArrayBuffer) {
      const preview = Buffer.from(pumpPortalResponse.data).toString('hex').substring(0, 100);
      console.log('[PumpPortal][trade-local] Binary data preview (first 50 bytes):', preview + '...');
    } else {
      console.log('[PumpPortal][trade-local] Response data:', pumpPortalResponse.data);
    }

    // Check for error in Pump Portal response (user-friendly)
    let pumpPortalData;
    try {
      pumpPortalData = JSON.parse(Buffer.from(pumpPortalResponse.data).toString());
    } catch (e) {
      // If not JSON, ignore (could be binary tx)
      console.log('[PumpPortal] Response is not JSON (likely binary transaction data)');
    }
    
    if (pumpPortalData && pumpPortalData.error) {
      console.error('[PumpPortal] Error response:', pumpPortalData);
      
      let userMessage = 'An error occurred while launching your token.';
      let errorCode = 'UNKNOWN_ERROR';
      
      const errorText = pumpPortalData.error.toString().toLowerCase();
      
      if (errorText.includes('insufficient') || errorText.includes('balance')) {
        userMessage = 'Insufficient SOL balance to launch this token. Please ensure you have enough SOL for the transaction fee and any initial buy amount.';
        errorCode = 'INSUFFICIENT_BALANCE';
      } else if (errorText.includes('already exists') || errorText.includes('duplicate')) {
        userMessage = 'A token with this mint address already exists. Please try again with a different mint.';
        errorCode = 'TOKEN_ALREADY_EXISTS';
      } else if (errorText.includes('invalid') || errorText.includes('invalid mint')) {
        userMessage = 'Invalid mint address provided. Please check your token configuration.';
        errorCode = 'INVALID_MINT';
      } else if (errorText.includes('rate limit') || errorText.includes('too many requests')) {
        userMessage = 'Too many requests. Please wait a moment and try again.';
        errorCode = 'RATE_LIMITED';
      } else if (errorText.includes('network') || errorText.includes('connection')) {
        userMessage = 'Network error occurred. Please check your connection and try again.';
        errorCode = 'NETWORK_ERROR';
      } else if (errorText.includes('timeout')) {
        userMessage = 'Request timed out. Please try again.';
        errorCode = 'TIMEOUT';
      }
      
      console.error(`[PumpPortal] User-friendly error: ${userMessage} (Code: ${errorCode})`);
      
      return res.status(400).json({ 
        error: userMessage,
        errorCode: errorCode,
        originalError: pumpPortalData.error,
        details: pumpPortalData.details || null
      });
    }

    const responseDataBuffer = Buffer.from(pumpPortalResponse.data);
    const txBase64 = responseDataBuffer.toString('base64');
    console.log('[PumpPortal] Transaction data:', {
      bufferSize: responseDataBuffer.length,
      base64Length: txBase64.length,
      base64Preview: txBase64.substring(0, 100) + '...'
    });

    // Advanced retry logic
    const rpcUrls = [process.env.SWAP_SOLANA_RPC_URL, process.env.SWAP2_SOLANA_RPC_URL].filter(Boolean);
    const maxAttempts = 2;
    const maxPolls = 15;
    const basePollInterval = 1000; // ms

    let signature = null;
    let lastError = null;
    let sendTiming = 0;
    let usedBackupRpc = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (let rpcIdx = 0; rpcIdx < rpcUrls.length; rpcIdx++) {
        try {
          const sendStart = Date.now();
          const rpcUrl = rpcUrls[rpcIdx];
          const connection = new Connection(rpcUrl, 'confirmed');
          const tx = VersionedTransaction.deserialize(new Uint8Array(responseDataBuffer));
          console.log(`[Attempt ${attempt + 1}, RPC ${rpcIdx + 1}] Deserialized transaction (using RPC: ${rpcUrl})`);
          if (!secretKey || secretKey.length === 0) {
            throw new Error('User wallet secretKey is required in the request body');
          }
          const userKeypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
          if (req.body.action === 'create') {
            if (!mintSecretKey || mintSecretKey.length === 0) {
              throw new Error('Mint secretKey is required for token creation');
            }
            const mintKeypair = Keypair.fromSecretKey(Uint8Array.from(mintSecretKey));
            const { blockhash } = await connection.getLatestBlockhash('finalized');
            tx.message.recentBlockhash = blockhash;
            tx.sign([mintKeypair, userKeypair]);
          } else {
            const { blockhash } = await connection.getLatestBlockhash('finalized');
            tx.message.recentBlockhash = blockhash;
            tx.sign([userKeypair]);
          }
          console.log(`[Attempt ${attempt + 1}, RPC ${rpcIdx + 1}] Signed transaction, sending...`);
          signature = await connection.sendTransaction(tx, {
            maxRetries: 3,
            preflightCommitment: 'processed',
            skipPreflight: false
          });
          sendTiming = Date.now() - sendStart;
          console.log(`[Attempt ${attempt + 1}, RPC ${rpcIdx + 1}] Transaction sent, signature:`, signature);
          usedBackupRpc = rpcIdx === 1;
          break; // Success
        } catch (err) {
          lastError = err;
          console.error(`[Attempt ${attempt + 1}, RPC ${rpcIdx + 1}] Error sending transaction:`, err);
          if (rpcIdx < rpcUrls.length - 1) {
            continue;
          }
          if (err.message && err.message.includes('block height exceeded')) {
            continue;
          }
          break;
        }
      }
      if (signature) break;
    }
    timing.sendTransaction = sendTiming;
    timing.total = Date.now() - start;
    if (!signature) {
      throw lastError || new Error('Failed to send transaction');
    }
    const now = new Date().toISOString();
    console.log(`[launchtimer][backend] About to send response for /api/trade-local at ${now}`);
    
    // Respond immediately after sending transaction, do not wait for confirmation polling
    res.json({ status: 'pending', signature, timing, usedBackupRpc });
    
    // --- Background confirmation and status update logic ---
    const POLL_ATTEMPTS = 15;
    const POLL_INTERVAL = 2000; // ms
    (async function confirmTxInBackground() {
      let confirmed = false;
      let errorDetails = null;
      console.log(`[TX-CONFIRMATION] Starting confirmation polling for signature: ${signature}`);
      console.log(`[TX-CONFIRMATION] Mint address: ${req.body.mint}`);
      
      // Create a new connection for background confirmation
      const rpcUrls = [process.env.SWAP_SOLANA_RPC_URL, process.env.SWAP2_SOLANA_RPC_URL].filter(Boolean);
      console.log(`[TX-CONFIRMATION] Available RPC URLs:`, rpcUrls);
      let backgroundConnection = null;
      
      for (const rpcUrl of rpcUrls) {
        try {
          backgroundConnection = new Connection(rpcUrl, 'confirmed');
          console.log(`[TX-CONFIRMATION] Successfully created connection with RPC: ${rpcUrl}`);
          break;
        } catch (e) {
          console.warn(`[TX-CONFIRMATION] Failed to create connection with RPC ${rpcUrl}:`, e.message);
          continue;
        }
      }
      
      if (!backgroundConnection) {
        console.error(`[TX-CONFIRMATION] Failed to create connection for background confirmation`);
        // Still try to update database with failed status
        try {
          await supabase
            .from('created_tokens')
            .update({ 
              status: 'failed',
              confirmed_at: null
            })
            .eq('mint_address', req.body.mint);
          console.log(`[TX-CONFIRMATION] Database updated for mint ${req.body.mint}: status = failed (connection error)`);
        } catch (dbError) {
          console.error(`[TX-CONFIRMATION] Failed to update database after connection error:`, dbError);
        }
        return;
      }
      
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        try {
          const statusObj = await backgroundConnection.getSignatureStatus(signature);
          console.log(`[TX-CONFIRMATION] Attempt ${i + 1}/${POLL_ATTEMPTS}:`, {
            signature: signature,
            status: statusObj?.value?.confirmationStatus,
            err: statusObj?.value?.err,
            slot: statusObj?.context?.slot,
            hasValue: !!statusObj?.value
          });
          
          if (statusObj && statusObj.value) {
            if (statusObj.value.err) {
              errorDetails = statusObj.value.err;
              console.error(`[TX-CONFIRMATION] Transaction failed with error:`, errorDetails);
              break;
            }
            if (statusObj.value.confirmationStatus === 'confirmed') {
              confirmed = true;
              console.log(`[TX-CONFIRMATION] ✅ Transaction confirmed successfully!`);
              break;
            }
          } else {
            console.log(`[TX-CONFIRMATION] No status value yet, continuing...`);
          }
        } catch (e) {
          console.warn(`[TX-CONFIRMATION] Error checking status (attempt ${i + 1}):`, e.message);
        }
        await new Promise(res => setTimeout(res, POLL_INTERVAL));
      }
      
      const finalStatus = confirmed ? 'confirmed' : 'failed';
      console.log(`[TX-CONFIRMATION] Final status for ${signature}: ${finalStatus}${errorDetails ? ` (Error: ${JSON.stringify(errorDetails)})` : ''}`);
      
      // Update DB status
      try {
        console.log(`[TX-CONFIRMATION] Attempting to update database for mint: ${req.body.mint}`);
        const updateResult = await supabase
          .from('created_tokens')
          .update({ 
            status: finalStatus,
            confirmed_at: confirmed ? new Date().toISOString() : null
          })
          .eq('mint_address', req.body.mint);
        
        if (updateResult.error) {
          console.error(`[TX-CONFIRMATION] Database update error:`, updateResult.error);
        } else {
          console.log(`[TX-CONFIRMATION] Database updated successfully for mint ${req.body.mint}: status = ${finalStatus}`);
          console.log(`[TX-CONFIRMATION] Update result:`, updateResult);
        }
      } catch (dbError) {
        console.error(`[TX-CONFIRMATION] Failed to update database:`, dbError);
        console.error(`[TX-CONFIRMATION] Database error details:`, {
          message: dbError.message,
          code: dbError.code,
          details: dbError.details
        });
      }
    })();
  } catch (error) {
    console.error('Trade error in /api/trade-local:', error.message, error);
    let status = 500;
    let errorResponse = {
      error: 'Failed to process request',
      details: error.message,
      requestBody: {
        publicKey: req.body.publicKey ? `${req.body.publicKey.slice(0, 4)}...${req.body.publicKey.slice(-4)}` : undefined,
        action: req.body.action,
        mint: req.body.mint ? `${req.body.mint.slice(0, 4)}...${req.body.mint.slice(-4)}` : undefined,
        amount: req.body.amount
      }
    };
    
    // Handle Pump Portal API errors specifically
    if (error.response) {
      status = error.response.status || status;
      console.error('Pump Portal API error response:', error.response.data);
      
      let userMessage = 'An error occurred while communicating with Pump Portal.';
      let errorCode = 'PUMP_PORTAL_ERROR';
      
      // Try to parse the error response
      let pumpPortalError = null;
      try {
        if (typeof error.response.data === 'string') {
          pumpPortalError = JSON.parse(error.response.data);
        } else {
          pumpPortalError = error.response.data;
        }
      } catch (e) {
        pumpPortalError = { error: error.response.data };
      }
      
      const errorText = (pumpPortalError?.error || '').toString().toLowerCase();
      
      if (errorText.includes('insufficient') || errorText.includes('balance')) {
        userMessage = 'Insufficient SOL balance to launch this token. Please ensure you have enough SOL for the transaction fee and any initial buy amount.';
        errorCode = 'INSUFFICIENT_BALANCE';
        status = 400; // Bad request
      } else if (errorText.includes('already exists') || errorText.includes('duplicate')) {
        userMessage = 'A token with this mint address already exists. Please try again with a different mint.';
        errorCode = 'TOKEN_ALREADY_EXISTS';
        status = 400;
      } else if (errorText.includes('invalid') || errorText.includes('invalid mint')) {
        userMessage = 'Invalid mint address provided. Please check your token configuration.';
        errorCode = 'INVALID_MINT';
        status = 400;
      } else if (errorText.includes('rate limit') || errorText.includes('too many requests')) {
        userMessage = 'Too many requests to Pump Portal. Please wait a moment and try again.';
        errorCode = 'RATE_LIMITED';
        status = 429;
      } else if (errorText.includes('network') || errorText.includes('connection')) {
        userMessage = 'Network error occurred while connecting to Pump Portal. Please check your connection and try again.';
        errorCode = 'NETWORK_ERROR';
        status = 503;
      } else if (errorText.includes('timeout')) {
        userMessage = 'Request to Pump Portal timed out. Please try again.';
        errorCode = 'TIMEOUT';
        status = 408;
      } else if (status === 404) {
        userMessage = 'Pump Portal service not found. Please try again later.';
        errorCode = 'SERVICE_NOT_FOUND';
      } else if (status >= 500) {
        userMessage = 'Pump Portal service is experiencing issues. Please try again later.';
        errorCode = 'SERVICE_ERROR';
      }
      
      errorResponse = {
        error: userMessage,
        errorCode: errorCode,
        originalError: pumpPortalError?.error || error.response.data,
        details: pumpPortalError?.details || null,
        pumpPortalStatus: status
      };
    }
    
    res.status(status).json(errorResponse);
  }
});

// --- Endpoint to fetch ALL created tokens (for landing page, public, etc.) ---
app.get('/api/created-tokens', async (req, res) => {
  try {
    const { includeRealtimeData = 'false' } = req.query;
    
    // Get tokens from database with explicit market cap fields
    const { data, error } = await supabase
      .from('created_tokens')
      .select(`
        *,
        market_cap,
        last_market_cap_update
      `)
      .order('created_at', { ascending: false });
    
    if (error) throw error;

    // If real-time data is requested, fetch from Pump Portal
    if (includeRealtimeData === 'true' && data && data.length > 0) {
      try {
        // Get real-time market cap data from Pump Portal
        const pumpPortalResponse = await axios.get('https://pumpportal.fun/data-api/real-time', {
          timeout: 10000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (pumpPortalResponse.data && Array.isArray(pumpPortalResponse.data)) {
          // Create a map of real-time data
          const realtimeDataMap = new Map();
          pumpPortalResponse.data.forEach(token => {
            if (token.mint) {
              realtimeDataMap.set(token.mint, {
                marketCap: token.marketCap || null,
                price: token.price || null,
                volume24h: token.volume24h || null,
                lastUpdated: new Date().toISOString()
              });
            }
          });

          // Merge real-time data with database data
          const enhancedTokens = data.map(token => {
            const realtimeData = realtimeDataMap.get(token.mint_address);
            return {
              ...token,
              // Use real-time data if available, otherwise use database data
              market_cap: realtimeData?.marketCap || token.market_cap,
              price: realtimeData?.price || null,
              volume24h: realtimeData?.volume24h || null,
              last_market_cap_update: realtimeData?.lastUpdated || token.last_market_cap_update,
              // Add flag to indicate if real-time data was used
              has_realtime_data: !!realtimeData
            };
          });

          res.json({ 
            tokens: enhancedTokens,
            realtime_data_included: true,
            total_tokens: enhancedTokens.length,
            tokens_with_realtime_data: enhancedTokens.filter(t => t.has_realtime_data).length
          });
        } else {
          // Fallback to database data only
          res.json({ 
            tokens: data,
            realtime_data_included: false,
            total_tokens: data.length,
            error: 'Failed to fetch real-time data from Pump Portal'
          });
        }
      } catch (realtimeError) {
        console.warn('Failed to fetch real-time market cap data:', realtimeError.message);
        // Return database data with warning
        res.json({ 
          tokens: data,
          realtime_data_included: false,
          total_tokens: data.length,
          warning: 'Real-time data unavailable, using cached data'
        });
      }
    } else {
      // Return database data only
      res.json({ 
        tokens: data,
        realtime_data_included: false,
        total_tokens: data.length
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// --- Test Endpoint for Token Creation (No SOL Cost) ---
app.post('/api/test/create-token', async (req, res) => {
  try {
    const { 
      mint, 
      name, 
      symbol, 
      description, 
      image, 
      publicKey, 
      website,
      twitter,
      telegram
    } = req.body;

    if (!mint || !name || !symbol || !publicKey) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['mint', 'name', 'symbol', 'publicKey']
      });
    }

    // Generate a fake transaction signature for testing
    const fakeSignature = 'test_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    console.log('[TEST] Simulating token creation:', {
      mint,
      name,
      symbol,
      description,
      publicKey,
      fakeSignature
    });

    // Save to database with is_test flag
    const { data, error } = await supabase
      .from('created_tokens')
      .insert({
        mint_address: mint,
        token_name: name,
        token_symbol: symbol,
        token_description: description || '',
        metadata: {
          name,
          symbol,
          description: description || '',
          imageFile: image || '',
          website: website || '',
          twitter: twitter || '',
          telegram: telegram || ''
        },
        user_public_key: publicKey,
        created_at: new Date().toISOString(),
        tx_signature: fakeSignature,
        is_test: true
      })
      .select()
      .single();

    if (error) {
      console.error('[TEST] Database insert error:', error);
      throw error;
    }

    // No caching - always fetch live data
    console.log('[TEST-TOKEN-CREATION] Token created, mint:', mint);

    console.log('[TEST] Token saved to database successfully:', data);

    res.json({ 
      success: true, 
      token: data,
      signature: fakeSignature,
      message: 'Test token created successfully (no SOL cost)',
      isTest: true
    });
  } catch (err) {
    console.error('[TEST] Create token error:', err);
    res.status(500).json({ 
      error: 'Failed to create test token',
      details: err.message 
    });
  }
});

// --- Endpoint to CREATE a new token (for token launch) ---
app.post('/api/created-tokens', async (req, res) => {
  console.log('[launchtimer][backend] /api/created-tokens request received');
  console.time('[launchtimer][backend] DB Save');
  try {
    const { 
      mint, 
      name, 
      symbol, 
      description, 
      image, 
      publicKey, 
      launchedAt, 
      txSignature,
      website,
      twitter,
      telegram
    } = req.body;

    if (!mint || !name || !symbol || !publicKey) {
      console.timeEnd('[launchtimer][backend] DB Save');
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['mint', 'name', 'symbol', 'publicKey']
      });
    }

    const { data, error } = await supabase
      .from('created_tokens')
      .insert({
        mint_address: mint,
        token_name: name,
        token_symbol: symbol,
        token_description: description || '',
        metadata: {
          name,
          symbol,
          description: description || '',
          imageFile: image || '',
          website: website || '',
          twitter: twitter || '',
          telegram: telegram || ''
        },
        user_public_key: publicKey,
        created_at: launchedAt ? new Date(launchedAt).toISOString() : new Date().toISOString(),
        tx_signature: txSignature || null,
        is_test: false,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error('Database insert error:', error);
      console.timeEnd('[launchtimer][backend] DB Save');
      throw error;
    }

    // No caching - always fetch live data
    console.log('[TOKEN-CREATION] Token created, mint:', mint);

    console.timeEnd('[launchtimer][backend] DB Save');
    console.log('[launchtimer][backend] /api/created-tokens response sent');
    res.json({ 
      success: true, 
      token: data,
      message: 'Token created successfully' 
    });
  } catch (err) {
    console.error('Create token error:', err);
    console.timeEnd('[launchtimer][backend] DB Save');
    res.status(500).json({ 
      error: 'Failed to create token',
      details: err.message 
    });
  }
});

// --- Endpoint to fetch tokens created BY A USER (for dashboard/portfolio) ---
app.get('/api/created-tokens/user', async (req, res) => {
  try {
    const { publicKey, testMode, includeRealtimeData = 'false' } = req.query;
    if (!publicKey) {
      return res.status(400).json({ error: 'Missing publicKey' });
    }
    
    // Filter by test mode if specified
    let query = supabase
      .from('created_tokens')
      .select(`
        *,
        market_cap,
        last_market_cap_update
      `)
      .eq('user_public_key', publicKey);
    
    if (testMode === 'true') {
      query = query.eq('is_test', true);
    } else if (testMode === 'false') {
      query = query.eq('is_test', false);
    }
    // If testMode is not specified, return all tokens (both test and real)
    
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    // If real-time data is requested and not in test mode, fetch from Pump Portal
    if (includeRealtimeData === 'true' && testMode !== 'true' && data && data.length > 0) {
      try {
        // Get real-time market cap data from Pump Portal
        const pumpPortalResponse = await axios.get('https://pumpportal.fun/data-api/real-time', {
          timeout: 10000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (pumpPortalResponse.data && Array.isArray(pumpPortalResponse.data)) {
          // Create a map of real-time data
          const realtimeDataMap = new Map();
          pumpPortalResponse.data.forEach(token => {
            if (token.mint) {
              realtimeDataMap.set(token.mint, {
                marketCap: token.marketCap || null,
                price: token.price || null,
                volume24h: token.volume24h || null,
                lastUpdated: new Date().toISOString()
              });
            }
          });

          // Merge real-time data with database data
          const enhancedTokens = data.map(token => {
            const realtimeData = realtimeDataMap.get(token.mint_address);
            return {
              ...token,
              // Use real-time data if available, otherwise use database data
              market_cap: realtimeData?.marketCap || token.market_cap,
              price: realtimeData?.price || null,
              volume24h: realtimeData?.volume24h || null,
              last_market_cap_update: realtimeData?.lastUpdated || token.last_market_cap_update,
              // Add flag to indicate if real-time data was used
              has_realtime_data: !!realtimeData
            };
          });

          res.json({ 
            tokens: enhancedTokens,
            realtime_data_included: true,
            total_tokens: enhancedTokens.length,
            tokens_with_realtime_data: enhancedTokens.filter(t => t.has_realtime_data).length
          });
        } else {
          // Fallback to database data only
          res.json({ 
            tokens: data,
            realtime_data_included: false,
            total_tokens: data.length,
            error: 'Failed to fetch real-time data from Pump Portal'
          });
        }
      } catch (realtimeError) {
        console.warn('Failed to fetch real-time market cap data:', realtimeError.message);
        // Return database data with warning
        res.json({ 
          tokens: data,
          realtime_data_included: false,
          total_tokens: data.length,
          warning: 'Real-time data unavailable, using cached data'
        });
      }
    } else {
      // Return database data only
      res.json({ 
        tokens: data,
        realtime_data_included: false,
        total_tokens: data.length
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Endpoint to get user's test tokens (for global test mode) ---
app.get('/api/test-tokens/user', async (req, res) => {
  try {
    const { publicKey } = req.query;
    if (!publicKey) {
      return res.status(400).json({ error: 'Missing publicKey' });
    }
    
    // Get only test tokens for the user
    const { data, error } = await supabase
      .from('created_tokens')
      .select('*')
      .eq('user_public_key', publicKey)
      .eq('is_test', true)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    // Transform data to match token format expected by frontend
    const transformedTokens = data.map(token => ({
      mint: token.mint_address,
      owner: token.user_public_key,
      amount: '0', // Test tokens don't have real balances
      decimals: 9,
      uiAmount: 0,
      symbol: token.token_symbol || token.metadata?.symbol,
      name: token.token_name || token.metadata?.name,
      image: token.metadata?.imageFile || token.metadata?.image,
      usdPrice: null, // Test tokens don't have real prices
      usdValue: null,
      priceChange24h: null,
      balance: 0,
      address: token.mint_address,
      isCreatedByUser: true,
      description: token.metadata?.description || token.token_description,
      launched_at: token.created_at,
      is_test: true
    }));
    
    res.json({ tokens: transformedTokens });
  } catch (err) {
    console.error('[TEST-TOKENS-USER] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Endpoint to get test token balances (always returns 0 for test tokens) ---
app.post('/api/test-token-balances', async (req, res) => {
  try {
    const { publicKey, mints } = req.body;
    if (!publicKey || !mints || !Array.isArray(mints)) {
      return res.status(400).json({ error: 'Missing publicKey or mints array' });
    }
    
    // For test tokens, return zero balances since they don't exist on-chain
    const testBalances = mints.map(mint => ({
      mint,
      owner: publicKey,
      amount: '0',
      decimals: 9,
      uiAmount: 0,
      balance: 0
    }));
    
    res.json({ tokens: testBalances });
  } catch (err) {
    console.error('[TEST-TOKEN-BALANCES] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Endpoint to get test token metadata and price (database only, no external APIs) ---
app.get('/api/test-token/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    if (!mint) {
      return res.status(400).json({ error: 'Missing mint address' });
    }

    // Get test token from database
    const { data, error } = await supabase
      .from('created_tokens')
      .select('*')
      .eq('mint_address', mint)
      .eq('is_test', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Test token not found' });
    }

    // Return database data only - no external API calls for test tokens
    const tokenData = {
      mint: data.mint_address,
      name: data.token_name || data.metadata?.name,
      symbol: data.token_symbol || data.metadata?.symbol,
      description: data.metadata?.description || data.token_description,
      image: data.metadata?.imageFile || data.metadata?.image,
      website: data.metadata?.website,
      twitter: data.metadata?.twitter,
      telegram: data.metadata?.telegram,
      created_at: data.created_at,
      tx_signature: data.tx_signature,
      is_test: true,
      // Test tokens don't have real price data, so we return null
      usdPrice: null,
      priceChange24h: null,
      marketCap: null,
      volume24h: null
    };

    res.json({ token: tokenData });
  } catch (err) {
    console.error('[TEST-TOKEN] Error fetching test token:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Endpoint to get test token price (always returns null for test tokens) ---
app.get('/api/test-token/:mint/price', async (req, res) => {
  try {
    const { mint } = req.params;
    if (!mint) {
      return res.status(400).json({ error: 'Missing mint address' });
    }

    // Verify this is actually a test token
    const { data, error } = await supabase
      .from('created_tokens')
      .select('mint_address, is_test')
      .eq('mint_address', mint)
      .eq('is_test', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Test token not found' });
    }

    // Test tokens don't have real price data
    res.json({ 
      price: null,
      message: 'Test tokens do not have on-chain price data',
      is_test: true
    });
  } catch (err) {
    console.error('[TEST-TOKEN-PRICE] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Endpoint to get test token metadata (database only) ---
app.get('/api/test-token/:mint/metadata', async (req, res) => {
  try {
    const { mint } = req.params;
    if (!mint) {
      return res.status(400).json({ error: 'Missing mint address' });
    }

    // Get test token metadata from database
    const { data, error } = await supabase
      .from('created_tokens')
      .select('*')
      .eq('mint_address', mint)
      .eq('is_test', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Test token not found' });
    }

    // Return database metadata only - no external API calls for test tokens
    const metadata = {
      mint: data.mint_address,
      name: data.token_name || data.metadata?.name,
      symbol: data.token_symbol || data.metadata?.symbol,
      description: data.metadata?.description || data.token_description,
      image: data.metadata?.imageFile || data.metadata?.image,
      website: data.metadata?.website,
      twitter: data.metadata?.twitter,
      telegram: data.metadata?.telegram,
      decimals: 9, // Default for test tokens
      is_test: true
    };

    res.json({ metadata });
  } catch (err) {
    console.error('[TEST-TOKEN-METADATA] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Supported Tickers API ---


// Add or update one or more supported tickers (accepts single object or array)
app.post('/api/supported-tickers', async (req, res) => {
  try {
    let tickers = req.body;
    if (!Array.isArray(tickers)) {
      tickers = [tickers]; // Support single object for backward compatibility
    }
    // Validate all
    for (const t of tickers) {
      if (!t.ticker || !t.mint_address) {
        return res.status(400).json({ error: 'Each object must have ticker and mint_address' });
      }
    }
    // Upsert all
    const { data, error } = await supabase
      .from('supported_tickers')
      .upsert(
        tickers.map(t => ({
          ticker: t.ticker.toUpperCase(),
          mint_address: t.mint_address
        })),
        { onConflict: 'ticker' }
      )
      .select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ tickers: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add root route handler
app.get('/', (req, res) => {
  res.json({ message: 'Server is running' });
});

// --- Helper Functions ---
async function getConnection(type = 'default') {
  let rpcUrl;
  if (type === 'swap') {
    rpcUrl = process.env.SWAP_SOLANA_RPC_URL
      || process.env.SOLANA_RPC_URL
      || process.env.QUICKNODE_RPC_URL
      || 'https://api.mainnet-beta.solana.com';
  } else {
    rpcUrl = process.env.SOLANA_RPC_URL
      || process.env.QUICKNODE_RPC_URL
      || 'https://api.mainnet-beta.solana.com';
  }
  return new Connection(rpcUrl, 'confirmed');
}

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const MORALIS_API_URL = 'https://solana-gateway.moralis.io';

// Update the fetchTokenPrices function to use cache
async function fetchTokenPrices(tokenAddresses) {
  if (!tokenAddresses.length) return {};

  try {
    // Initialize cachedPrices with an empty object
    let cachedPrices = {};
    
    // First check cache
    try {
      cachedPrices = await getCachedTokenPrices(tokenAddresses);
    } catch (cacheError) {
      console.warn('Error fetching cached prices:', cacheError);
      cachedPrices = {};
    }
    
    const cachedAddresses = Object.keys(cachedPrices);
    
    // Find addresses not in cache
    const uncachedAddresses = tokenAddresses.filter(addr => !cachedAddresses.includes(addr));
    
    if (uncachedAddresses.length === 0) {
      console.log('All token prices found in cache');
      return cachedPrices;
    }

    // Fetch only uncached addresses from Moralis
    console.log(`Fetching ${uncachedAddresses.length} token prices from Moralis`);
    if (!MORALIS_API_KEY) {
      console.warn('MORALIS_API_KEY not configured');
      return cachedPrices;
    }

    const response = await axios.post(
      `${MORALIS_API_URL}/token/mainnet/prices`,
      { addresses: uncachedAddresses },
      {
        headers: {
          'Accept': 'application/json',
          'X-API-Key': MORALIS_API_KEY
        }
      }
    );

    // Log the raw price data from Moralis
    console.log('Moralis price API response:', JSON.stringify(response.data, null, 2));

    // Transform the response into a map
    const newPriceData = {};
    if (response.data && Array.isArray(response.data)) {
      response.data.forEach(token => {
        if (token.tokenAddress && token.usdPrice) {
          newPriceData[token.tokenAddress] = {
            usdPrice: token.usdPrice,
            name: token.name,
            symbol: token.symbol,
            logo: token.logo,
            priceChange24h: token.usdPrice24hrPercentChange
          };
        }
      });
    }

    // Cache the new price data
    try {
      await cacheTokenPrices(newPriceData);
    } catch (cacheError) {
      console.warn('Error caching new prices:', cacheError);
    }

    // Combine cached and new prices
    return {
      ...cachedPrices,
      ...newPriceData
    };
  } catch (error) {
    console.error('Error fetching Moralis token prices:', error);
    // Return empty object if both cache and API calls fail
    return {};
  }
}

// --- Real Swap Quote Endpoint using Moralis ---
app.post('/api/quote', async (req, res) => {
  try {
    const { fromToken, toToken, amount } = req.body;
    const inputAmount = Number(amount);
    if (!fromToken || !toToken || !amount) {
      return res.status(400).json({ error: 'Missing fromToken, toToken, or amount' });
    }
    // Use fetchTokenPrices to get USD prices for both tokens (by mint address)
    const priceMap = await fetchTokenPrices([fromToken, toToken]);
    const fromPrice = priceMap[fromToken]?.usdPrice;
    const toPrice = priceMap[toToken]?.usdPrice;
    if (!fromPrice || !toPrice) {
      return res.status(400).json({ error: 'Failed to fetch token prices from Moralis' });
    }
    // Calculate output amount (assume both tokens have 9 decimals for demo; adjust as needed)
    const outputAmount = (inputAmount * fromPrice / toPrice) * 1e9;
    const priceImpact = 0.01; // Placeholder
    const networkFee = 0.0001; // Placeholder
    const minimumReceived = outputAmount * 0.99 / 1e9; // 1% slippage, convert back to normal units
    res.json({
      inputAmount,
      outputAmount,
      priceImpact,
      networkFee,
      minimumReceived
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate real quote', details: e.message });
  }
});

// Add Doppler support
function loadDopplerEnv() {
  try {
    const output = child_process.execSync('doppler secrets download --no-file --format json').toString();
    const env = JSON.parse(output);
    Object.keys(env).forEach(key => {
      process.env[key] = env[key];
    });
  } catch (e) {
    console.error('Failed to load Doppler secrets:', e);
  }
}
loadDopplerEnv();

// --- Endpoint to get SOL price ---
app.get('/api/sol-price', async (req, res) => {
  try {
    if (!MORALIS_API_KEY) {
      return res.status(500).json({ error: 'MORALIS_API_KEY not configured' });
    }

    const response = await axios.get(
      'https://solana-gateway.moralis.io/token/mainnet/So11111111111111111111111111111111111111112/price',
      {
        headers: {
          'Accept': 'application/json',
          'X-API-Key': MORALIS_API_KEY
        }
      }
    );

    const solPrice = response.data?.usdPrice || 0;
    res.json({ price: solPrice });
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    res.status(500).json({ error: 'Failed to fetch SOL price', price: 0 });
  }
});

// --- Market Cap Management Endpoints ---

// Get market cap data for a specific token
app.get('/api/token/:mint/market-cap', async (req, res) => {
  try {
    const { mint } = req.params;
    if (!mint) {
      return res.status(400).json({ error: 'Missing mint address' });
    }

    // Get market cap data from database
    const { data, error } = await supabase
      .from('created_tokens')
      .select('market_cap, last_market_cap_update')
      .eq('mint_address', mint)
      .single();

    if (error) {
      console.error('Database error fetching market cap:', error);
      return res.status(500).json({ error: 'Failed to fetch market cap data' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Token not found' });
    }

    res.json({
      mint,
      marketCap: data.market_cap,
      lastUpdated: data.last_market_cap_update,
      price: null, // We'll need to fetch this separately if needed
      volume24h: null // We'll need to fetch this separately if needed
    });
  } catch (err) {
    console.error('Error fetching market cap:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update market cap data for a specific token
app.post('/api/token/:mint/market-cap', async (req, res) => {
  try {
    const { mint } = req.params;
    const { marketCap, price, volume24h } = req.body;

    if (!mint) {
      return res.status(400).json({ error: 'Missing mint address' });
    }

    if (marketCap === undefined && price === undefined && volume24h === undefined) {
      return res.status(400).json({ error: 'At least one field (marketCap, price, volume24h) is required' });
    }

    const updateData = {
      last_market_cap_update: new Date().toISOString()
    };

    if (marketCap !== undefined) updateData.market_cap = marketCap;

    // Update the token in database
    const { data, error } = await supabase
      .from('created_tokens')
      .update(updateData)
      .eq('mint_address', mint)
      .select()
      .single();

    if (error) {
      console.error('Database error updating market cap:', error);
      return res.status(500).json({ error: 'Failed to update market cap data' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Token not found' });
    }

    res.json({
      success: true,
      token: {
        mint: data.mint_address,
        marketCap: data.market_cap,
        lastUpdated: data.last_market_cap_update
      }
    });
  } catch (err) {
    console.error('Error updating market cap:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk update market cap data for multiple tokens
app.post('/api/tokens/market-cap/bulk-update', async (req, res) => {
  try {
    const { tokens } = req.body;

    if (!tokens || !Array.isArray(tokens)) {
      return res.status(400).json({ error: 'tokens array is required' });
    }

    const results = [];
    const errors = [];

    for (const tokenData of tokens) {
      try {
        const { mint, marketCap, price, volume24h } = tokenData;
        
        if (!mint) {
          errors.push({ mint: 'unknown', error: 'Missing mint address' });
          continue;
        }

        const updateData = {
          last_market_cap_update: new Date().toISOString()
        };

        if (marketCap !== undefined) updateData.market_cap = marketCap;

        const { data, error } = await supabase
          .from('created_tokens')
          .update(updateData)
          .eq('mint_address', mint)
          .select()
          .single();

        if (error) {
          errors.push({ mint, error: error.message });
        } else if (data) {
          results.push({
            mint: data.mint_address,
            marketCap: data.market_cap,
            lastUpdated: data.last_market_cap_update
          });
        }
      } catch (err) {
        errors.push({ mint: tokenData.mint || 'unknown', error: err.message });
      }
    }

    res.json({
      success: true,
      updated: results.length,
      failed: errors.length,
      results,
      errors
    });
  } catch (err) {
    console.error('Error bulk updating market caps:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all tokens that need market cap updates (older than 15 minutes)
app.get('/api/tokens/needing-market-cap-update', async (req, res) => {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('created_tokens')
      .select('mint_address, token_name, token_symbol, market_cap, last_market_cap_update')
      .or(`last_market_cap_update.is.null,last_market_cap_update.lt.${fifteenMinutesAgo}`)
      .eq('is_test', false); // Only real tokens, not test tokens

    if (error) {
      console.error('Database error fetching tokens needing update:', error);
      return res.status(500).json({ error: 'Failed to fetch tokens' });
    }

    res.json({
      tokens: data || [],
      count: data ? data.length : 0
    });
  } catch (err) {
    console.error('Error fetching tokens needing market cap update:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Database Migration Endpoint ---
app.post('/api/migrate/add-test-column', async (req, res) => {
  try {
    console.log('[MIGRATION] Starting migration to add is_test column');
    
    // Check if column already exists
    const { data: existingColumns, error: checkError } = await supabase
      .from('information_schema.columns')
      .select('column_name')
      .eq('table_name', 'created_tokens')
      .eq('column_name', 'is_test');
    
    if (checkError) {
      console.error('[MIGRATION] Error checking existing columns:', checkError);
      throw new Error('Failed to check existing columns');
    }
    
    if (existingColumns && existingColumns.length > 0) {
      console.log('[MIGRATION] is_test column already exists');
      return res.json({ 
        success: true, 
        message: 'is_test column already exists',
        alreadyExists: true 
      });
    }
    
    // Add the is_test column
    console.log('[MIGRATION] Adding is_test column...');
    const { error: alterError } = await supabase.rpc('exec_sql', {
      sql: 'ALTER TABLE created_tokens ADD COLUMN is_test BOOLEAN DEFAULT false'
    });
    
    if (alterError) {
      console.error('[MIGRATION] Error adding column:', alterError);
      throw new Error(`Failed to add is_test column: ${alterError.message}`);
    }
    
    // Update existing records to mark them as real tokens
    console.log('[MIGRATION] Updating existing records...');
    const { error: updateError } = await supabase
      .from('created_tokens')
      .update({ is_test: false })
      .is('is_test', null);
    
    if (updateError) {
      console.error('[MIGRATION] Error updating existing records:', updateError);
      // Don't throw here, as the column was added successfully
      console.warn('[MIGRATION] Warning: Could not update existing records');
    }
    
    // Make the column NOT NULL
    console.log('[MIGRATION] Making column NOT NULL...');
    const { error: notNullError } = await supabase.rpc('exec_sql', {
      sql: 'ALTER TABLE created_tokens ALTER COLUMN is_test SET NOT NULL'
    });
    
    if (notNullError) {
      console.error('[MIGRATION] Error making column NOT NULL:', notNullError);
      throw new Error(`Failed to make is_test NOT NULL: ${notNullError.message}`);
    }
    
    // Add indexes for better performance
    console.log('[MIGRATION] Adding indexes...');
    try {
      await supabase.rpc('exec_sql', {
        sql: 'CREATE INDEX IF NOT EXISTS idx_created_tokens_is_test ON created_tokens(is_test)'
      });
      
      await supabase.rpc('exec_sql', {
        sql: 'CREATE INDEX IF NOT EXISTS idx_created_tokens_user_test ON created_tokens(user_public_key, is_test)'
      });
    } catch (indexError) {
      console.warn('[MIGRATION] Warning: Could not create indexes:', indexError);
      // Don't fail the migration for index errors
    }
    
    console.log('[MIGRATION] Migration completed successfully');
    res.json({ 
      success: true, 
      message: 'is_test column added successfully',
      migration: 'add-test-column',
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('[MIGRATION] Migration failed:', err);
    res.status(500).json({ 
      error: 'Migration failed',
      details: err.message 
    });
  }
});

// --- Market Cap Scheduler Management ---

// Start market cap scheduler endpoint
app.post('/api/market-cap-scheduler/start', async (req, res) => {
  try {
    const { intervalMinutes = 1 } = req.body;
    
    // Import and start the scheduler
    const { marketCapScheduler } = require('./src/services/marketCap/scheduler');
    marketCapScheduler.start(intervalMinutes);
    
    res.json({ 
      success: true, 
      message: `Market cap scheduler started with ${intervalMinutes} minute intervals` 
    });
  } catch (err) {
    console.error('Error starting market cap scheduler:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stop market cap scheduler endpoint
app.post('/api/market-cap-scheduler/stop', async (req, res) => {
  try {
    const { marketCapScheduler } = require('./src/services/marketCap/scheduler');
    marketCapScheduler.stop();
    
    res.json({ 
      success: true, 
      message: 'Market cap scheduler stopped' 
    });
  } catch (err) {
    console.error('Error stopping market cap scheduler:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get market cap scheduler status endpoint
app.get('/api/market-cap-scheduler/status', async (req, res) => {
  try {
    const { marketCapScheduler } = require('./src/services/marketCap/scheduler');
    const lastJob = marketCapScheduler.getLastJobStatus();
    
    res.json({ 
      success: true,
      lastJob,
      isRunning: lastJob?.status === 'running'
    });
  } catch (err) {
    console.error('Error getting market cap scheduler status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger market cap update endpoint
app.post('/api/market-cap-scheduler/trigger-update', async (req, res) => {
  try {
    const { marketCapScheduler } = require('./src/services/marketCap/scheduler');
    const job = await marketCapScheduler.triggerUpdate();
    
    res.json({ 
      success: true,
      job
    });
  } catch (err) {
    console.error('Error triggering market cap update:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get token price status endpoint
app.get('/api/token-price/status', async (req, res) => {
  try {
    if (!tokenPriceService) {
      return res.status(503).json({ 
        error: 'Token price service not available' 
      });
    }

    const status = tokenPriceService.getStatus();
    res.json({ 
      success: true,
      status
    });
  } catch (err) {
    console.error('Error getting token price status:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get specific token price endpoint
app.get('/api/token-price/:tokenMint', async (req, res) => {
  try {
    if (!tokenPriceService) {
      return res.status(503).json({ 
        error: 'Token price service not available' 
      });
    }

    const { tokenMint } = req.params;
    const priceData = await tokenPriceService.getTokenPrice(tokenMint);
    
    if (!priceData) {
      return res.status(404).json({ 
        error: 'Token price not available' 
      });
    }

    res.json({ 
      success: true,
      tokenMint,
      priceData
    });
  } catch (err) {
    console.error('Error getting token price:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import and initialize market cap scheduler
let marketCapScheduler = null;
try {
  const { marketCapScheduler: scheduler } = require('./src/services/marketCap/scheduler');
  marketCapScheduler = scheduler;
  console.log('✅ Market cap scheduler imported successfully');
} catch (error) {
  console.warn('⚠️  Market cap scheduler not available:', error.message);
}

// Import token price service
let tokenPriceService = null;
try {
  const { tokenPriceService: tokenService } = require('./src/services/marketCap/tokenPriceService');
  tokenPriceService = tokenService;
  console.log('✅ Token price service imported successfully');
} catch (error) {
  console.warn('⚠️  Token price service not available:', error.message);
}

// --- Update token metadata endpoint ---
app.put('/api/token/:mint/metadata', async (req, res) => {
  try {
    const { mint } = req.params;
    const { name, symbol, image, decimals, description, launched_at, is_test } = req.body;
    
    if (!mint) return res.status(400).json({ error: 'Missing mint address' });
    
    // Update metadata in token_metadata table
    const { data, error } = await supabase
      .from('token_metadata')
      .upsert({
        mint,
        name: name || null,
        symbol: symbol || null,
        image: image || null,
        decimals: decimals || 9,
        description: description || '',
        launched_at: launched_at || null,
        is_test: is_test || false,
        last_updated: new Date().toISOString(),
      }, {
        onConflict: 'mint'
      })
      .select()
      .single();
    
    if (error) {
      console.error('[UPDATE-TOKEN-METADATA] Database error:', error);
      return res.status(500).json({ error: error.message });
    }
    
    res.json({
      success: true,
      metadata: data,
      message: 'Token metadata updated successfully'
    });
  } catch (err) {
    console.error('[UPDATE-TOKEN-METADATA] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Get token metadata and price by mint (for real tokens) ---
app.get('/api/token/:mint', async (req, res) => {
  try {
    const { mint } = req.params;
    if (!mint) return res.status(400).json({ error: 'Missing mint address' });

    // Check if this is a test token first
    const { data: testToken } = await supabase
      .from('created_tokens')
      .select('token_name, token_symbol, metadata')
      .eq('mint_address', mint)
      .eq('is_test', true)
      .single();

    if (testToken) {
      // Return test token metadata from database
      const meta = {
        mint,
        name: testToken.token_name,
        symbol: testToken.token_symbol,
        decimals: 9,
        image: testToken.metadata?.imageFile || '',
      };
      
      res.json({
        ...meta,
        usdPrice: null,
        priceChange24h: null,
      });
      return;
    }

    // Always fetch live metadata from Helius (no caching)
    const heliusMetaResp = await axios.post(
      `https://api.helius.xyz/v0/tokens/metadata?api-key=${process.env.HELIUS_API_KEY}`,
      { mintAccounts: [mint] }
    );
    const heliusMeta = heliusMetaResp.data[0] || {};
    console.log('[TOKEN-METADATA] Raw Helius response:', JSON.stringify(heliusMeta, null, 2));

    // Robust image extraction (matches batch logic)
    let image =
      heliusMeta.offChainData?.image ||
      heliusMeta.legacyMetadata?.logoURI ||
      (heliusMeta.onChainData?.data?.uri ? resolveIpfsUrl(heliusMeta.onChainData.data.uri) : '');

    // If image is a JSON metadata file (ends with .json), fetch and parse for actual image
    if (image && image.endsWith('.json')) {
      try {
        const metaResp = await axios.get(image);
        if (metaResp.data && metaResp.data.image) {
          image = resolveIpfsUrl(metaResp.data.image);
        }
      } catch (e) {
        console.warn('[TOKEN-METADATA] Could not fetch nested metadata for image:', image, e.message);
      }
    }

    const meta = {
      mint,
      name: heliusMeta.offChainData?.name || heliusMeta.legacyMetadata?.name || heliusMeta.onChainData?.data?.name || 'Unknown Token',
      symbol: heliusMeta.offChainData?.symbol || heliusMeta.legacyMetadata?.symbol || heliusMeta.onChainData?.data?.symbol || mint.slice(0, 4),
      decimals: heliusMeta.decimals || 9,
      image, // Always use 'image' field
    };

    // Fetch price from Moralis
    let usdPrice = null, priceChange24h = null;
    try {
      const priceResp = await axios.get(
        `https://solana-gateway.moralis.io/token/mainnet/${mint}/price`,
        { headers: { 'X-API-Key': process.env.MORALIS_API_KEY } }
      );
      usdPrice = priceResp.data?.usdPrice ?? null;
      priceChange24h = priceResp.data?.usdPrice24hrPercentChange ?? null;
    } catch (e) {
      console.warn('[TOKEN-METADATA] Could not fetch price from Moralis:', e.message);
    }

    res.json({
      ...meta,
      usdPrice,
      priceChange24h,
    });
  } catch (err) {
    console.error('[TOKEN-METADATA] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log('📊 Market Cap Scheduler Status:', marketCapScheduler ? 'Available' : 'Not Available');
  console.log('🔧 Available endpoints:');
  console.log('- POST /api/rpc/token-accounts');
  console.log('- GET /api/created-tokens (with market cap data)');
  console.log('- GET /api/market-cap-scheduler/status');
  
  if (marketCapScheduler) {
    const status = marketCapScheduler.getLastJobStatus();
    if (status) {
      console.log(`📈 Last market cap update: ${status.status} (${status.tokensUpdated} tokens updated)`);
    }
  }
});

// Enhanced supported tickers endpoint
app.get('/api/supported-tickers', async (req, res) => {
  try {
    const { includePrices = 'false', limit = 1000 } = req.query;
    let query = supabase
      .from('supported_tickers')
      .select('*')
      .order('last_updated', { ascending: false })
      .limit(parseInt(limit));
    const { data: tokens, error } = await query;
    if (error) throw error;

    if (includePrices === 'true' && tokens.length > 0) {
      const jupiterService = new JupiterTokenService();
      const mintAddresses = tokens.map(t => t.mint_address);
      const prices = await jupiterService.getTokenPrices(mintAddresses);
      const enrichedTokens = tokens.map(token => ({
        ...token,
        jupiter_price: prices[token.mint_address]?.price || null,
        price_24h_change: prices[token.mint_address]?.price_24h_change || null
      }));
      res.json({
        tickers: enrichedTokens,
        prices_included: true,
        total: enrichedTokens.length
      });
    } else {
      res.json({
        tickers: tokens,
        prices_included: false,
        total: tokens.length
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync endpoint for admin use
app.post('/api/supported-tickers/sync', async (req, res) => {
  try {
    const jupiterService = new JupiterTokenService();
    const syncedTokens = await jupiterService.syncTokenList();
    res.json({
      success: true,
      message: `Synced ${syncedTokens.length} tokens from Jupiter`,
      synced_count: syncedTokens.length,
      last_sync: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Jupiter sync scheduler
const jupiterScheduler = new JupiterSyncScheduler();
jupiterScheduler.start();

// --- Endpoint to update the status of a created token by mint address ---
app.patch('/api/created-tokens/:mint/status', async (req, res) => {
  const { mint } = req.params;
  const { status } = req.body;
  if (!mint) {
    return res.status(400).json({ error: 'Missing mint address' });
  }
  if (!status || !['pending', 'confirmed', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid or missing status. Must be one of: pending, confirmed, failed.' });
  }
  try {
    const { data, error } = await supabase
      .from('created_tokens')
      .update({ status })
      .eq('mint_address', mint)
      .select()
      .single();
    if (error) {
      return res.status(500).json({ error: 'Failed to update status', details: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json({ success: true, token: data });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});
