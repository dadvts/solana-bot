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
    console.log("Fetching tokens...");
    try {
        const now = Date.now();
        if (!cachedPairs || now - lastFetchTime > CACHE_DURATION) {
            console.log('Fetching new token pairs...');
            const response = await fetch('https://api.raydium.io/v2/main/pairs');
            cachedPairs = (await response.json()).slice(0, 50); // Limitar a 50 pares
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
        console.log('Error al obtener precio:', error);
        return 1;
    }
}

async function buyToken(tokenPubKey) {
    const price = await getTokenPrice(tokenPubKey);
    const amountPerTrade = tradingCapital / maxTrades;
    console.log(`Comprando ${tokenPubKey.toBase58()} a $${price} con ${amountPerTrade} SOL`);
    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amountPerTrade * 1e9),
        })
    );
    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Compra: ${signature}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    } catch (error) {
        console.log('❌ Error compra:', error.message);
    }
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;
    console.log(`Vendiendo ${tokenPubKey.toBase58()} a $${currentPrice} (compra: $${buyPrice})`);
    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amount * 1e9 * (currentPrice / buyPrice)),
        })
    );
    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Venta: ${signature}`);
        if (profit > 0) {
            const halfProfit = profit / 2;
            savedSol += halfProfit;
            tradingCapital += halfProfit;
            console.log(`📈 Ganancia: ${profit} SOL | Guardado: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
        } else if (profit < 0) {
            tradingCapital += profit;
            console.log(`📉 Pérdida: ${profit} SOL | Capital: ${tradingCapital} SOL`);
        }
        delete portfolio[tokenPubKey.toBase58()];
    } catch (error) {
        console.log('❌ Error venta:', error.message);
    }
}

async function tradingBot() {
    try {
        console.log('🤖 Iniciando ciclo de trading...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (tradingCapital < 0.01) {
            console.log('🚫 Capital insuficiente. Reintentando en el próximo ciclo.');
            return;
        }
        const topTokens = await fetchTopTokens();
        console.log('📡 Buscando mejores tokens...');
        console.log('Tokens obtenidos:', topTokens.length);

        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(token);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa de 2 segundos entre compras
            }
        }

        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(new PublicKey(token));
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.30 || currentPrice <= buyPrice * 0.95) {
                await sellToken(new PublicKey(token));
            }
        }

        console.log('✔️ Ciclo de trading completado.');
    } catch (error) {
        console.error('❌ Error en el ciclo de trading:', error.message);
        console.log('🔄 Reintentando en el próximo ciclo...');
    }
}

function startBot() {
    console.log('🚀 Bot starting...');
    tradingBot();
    setInterval(() => {
        console.log('🔄 Nuevo ciclo iniciando...');
        tradingBot();
    }, 1200000); // 20 minutos en lugar de 10 minutos
}

startBot();

