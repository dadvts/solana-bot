const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.default.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const portfolio = {};
let tradingCapital = 0.3;
let savedSol = 0;
const maxTrades = 2;
let cachedPairs = null;
let lastFetchTime = 0;
const CACHE_DURATION = 600000;

async function fetchTopTokens() {
    try {
        const now = Date.now();
        if (!cachedPairs || now - lastFetchTime > CACHE_DURATION) {
            console.log('Fetching new token pairs...');
            const response = await fetch('https://api.raydium.io/v2/main/pairs');
            cachedPairs = (await response.json()).slice(0, 100); // Limitar a 100 pares
            lastFetchTime = now;
            console.log('Pairs fetched:', cachedPairs.length);
        } else {
            console.log('Using cached pairs:', cachedPairs.length);
        }

        console.log('Filtering pairs...');
        const filteredPairs = cachedPairs
            .filter(pair =>
                pair.volume_24h > 500000 &&
                pair.price * pair.liquidity / pair.price > 1000000 &&
                Math.abs(pair.price_change_24h || 0) > 0.15
            )
            .sort((a, b) => Math.abs(b.price_change_24h || 0) - Math.abs(a.price_change_24h || 0))
            .slice(0, maxTrades)
            .map(pair => ({
                token: new PublicKey(pair.base_token),
                price: pair.price
            }));

        console.log('Filtered tokens:', filteredPairs.length);
        return filteredPairs;
    } catch (error) {
        console.error('Error fetching tokens:', error.message);
        return [];
    }
}

async function getTokenPrice(tokenPubKey) {
    try {
        if (!cachedPairs) await fetchTopTokens();
        const pair = cachedPairs.find(p => p.base_token === tokenPubKey.toBase58());
        return pair ? pair.price : 1;
    } catch (error) {
        console.error('Error getting price:', error.message);
        return 1;
    }
}

async function buyToken(tokenPubKey) {
    const price = await getTokenPrice(tokenPubKey);
    const amountPerTrade = tradingCapital / maxTrades;
    console.log(`Buying ${tokenPubKey.toBase58()} at $${price} with ${amountPerTrade} SOL`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amountPerTrade * 1e9),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Purchase successful: ${signature}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    } catch (error) {
        console.error('❌ Purchase error:', error.message);
    }
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;
    console.log(`Selling ${tokenPubKey.toBase58()} at $${currentPrice} (bought at $${buyPrice})`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amount * 1e9 * (currentPrice / buyPrice)),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Sale successful: ${signature}`);

        if (profit > 0) {
            const halfProfit = profit / 2;
            savedSol += halfProfit;
            tradingCapital += halfProfit;
            console.log(`📈 Profit: ${profit} SOL | Saved: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
        } else if (profit < 0) {
            tradingCapital += profit;
            console.log(`📉 Loss: ${profit} SOL | Capital: ${tradingCapital} SOL`);
        }

        delete portfolio[tokenPubKey.toBase58()];
    } catch (error) {
        console.error('❌ Sale error:', error.message);
    }
}

async function tradingBot() {
    try {
        console.log('🤖 Starting trading cycle...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Saved: ${savedSol} SOL`);

        if (tradingCapital < 0.01) {
            console.log('🚫 Insufficient capital. Retrying in the next cycle.');
            return;
        }

        const topTokens = await fetchTopTokens();
        console.log('📡 Searching for top tokens...');
        console.log(`Tokens fetched: ${topTokens.length}`);

        let trades = 0;
        const buyPromises = [];

        for (const { token } of topTokens) {
            if (trades >= maxTrades) break;
            if (!portfolio[token.toBase58()]) {
                buyPromises.push(buyToken(token));
                trades++;
            }
        }

        await Promise.all(buyPromises);
        console.log('📈 All buy orders executed.');

        const sellPromises = [];
        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(new PublicKey(token));
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.30 || currentPrice <= buyPrice * 0.95) {
                sellPromises.push(sellToken(new PublicKey(token)));
            }
        }

        await Promise.all(sellPromises);
        console.log('📉 All sell orders executed.');

        console.log('✔️ Trading cycle completed.');
    } catch (error) {
        console.error('❌ Error in trading cycle:', error.message);
        console.log('🔄 Retrying in the next cycle...');
    }
}

function startBot() {
    console.log('🚀 Bot starting...');
    tradingBot();
    setInterval(() => {
        console.log('🔄 Starting new cycle...');
        tradingBot();
    }, 600000); // 10 minutes
}

startBot();
