const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.default.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed'); // Mainnet
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const portfolio = {};
let tradingCapital = 0.3; // Ajustable según tu saldo
let savedSol = 0;
const maxTrades = 2;

async function fetchTopTokens() {
    console.log('Fetching top tokens from Raydium...');
    try {
        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const allPairs = await response.json();
        console.log('Pairs fetched:', allPairs.length);
        const filteredPairs = allPairs
            .slice(0, 10) // Limitar para Render
            .filter(pair => pair.volume_24h > 500000 && Math.abs(pair.price_change_24h || 0) > 0.15)
            .slice(0, maxTrades)
            .map(pair => ({
                token: new PublicKey(pair.base_token),
                price: pair.price || 1
            }));
        console.log('Filtered tokens:', filteredPairs.length);
        return filteredPairs;
    } catch (error) {
        console.log('Error obteniendo tokens:', error.message);
        return [];
    }
}

async function getTokenPrice(tokenPubKey) {
    console.log(`Getting price for ${tokenPubKey.toBase58()}...`);
    try {
        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const pairs = await response.json();
        const pair = pairs.find(p => p.base_token === tokenPubKey.toBase58());
        return pair ? pair.price : 1;
    } catch (error) {
        console.log('Error al obtener precio:', error.message);
        return 1;
    }
}

async function buyToken(tokenPubKey, amountPerTrade) {
    const price = await getTokenPrice(tokenPubKey);
    console.log(`Simulando compra ${tokenPubKey.toBase58()} a $${price} con ${amountPerTrade} SOL`);
    portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    tradingCapital -= amountPerTrade;
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;
    console.log(`Simulando venta ${tokenPubKey.toBase58()} a $${currentPrice} (compra: $${buyPrice})`);
    if (profit > 0) {
        const halfProfit = profit / 2;
        savedSol += halfProfit;
        tradingCapital += halfProfit + amount;
        console.log(`📈 Ganancia: ${profit} SOL | Guardado: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
    } else {
        tradingCapital += profit + amount;
        console.log(`📉 Pérdida: ${profit} SOL | Capital: ${tradingCapital} SOL`);
    }
    delete portfolio[tokenPubKey.toBase58()];
}

async function tradingBot() {
    try {
        console.log('🤖 Iniciando ciclo de trading...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (tradingCapital < 0.01) {
            console.log('🚫 Capital insuficiente para operar.');
            return;
        }
        const topTokens = await fetchTopTokens();
        console.log('📡 Buscando mejores tokens...');
        console.log('Tokens obtenidos:', topTokens.length);

        const amountPerTrade = tradingCapital / maxTrades; // Ajusta según capital disponible
        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(token, amountPerTrade);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000));
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
        console.error('❌ Error en el ciclo:', error.message);
    }
}

function startBot() {
    console.log('🚀 Bot starting...');
    tradingBot();
    setInterval(() => {
        console.log('🔄 Nuevo ciclo iniciando...');
        tradingBot();
    }, 600000);
}

startBot();