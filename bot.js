const { 
    Connection, 
    Keypair, 
    PublicKey, 
    Transaction, 
    SystemProgram, 
    sendAndConfirmTransaction 
} = require('@solana/web3.js');
const bs58 = require('bs58').default;
const fetch = require('node-fetch');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

// Configuración de conexión a Solana
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Verificar PRIVATE_KEY
if (!process.env.PRIVATE_KEY) {
    console.error("⚠️  Error: PRIVATE_KEY no está definido en las variables de entorno.");
    process.exit(1);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

let tradingCapital = 0.3; // Capital de trading (en SOL)
let savedSol = 0;
const maxTrades = 2;
const portfolio = {}; // Tokens en cartera

async function fetchTopTokens() {
    try {
        console.log("📡 Buscando mejores tokens...");
        const response = await fetch('https://api.raydium.io/v2/main/pairs', { method: 'GET' });
        const pairs = await response.json();

        // Filtrar tokens con buenas métricas
        const topTokens = pairs
            .filter(pair => pair.volume_24h > 500000 && (pair.price * pair.liquidity) > 1000000)
            .sort((a, b) => Math.abs(b.price_change_24h || 0) - Math.abs(a.price_change_24h || 0))
            .slice(0, maxTrades)
            .map(pair => ({
                token: new PublicKey(pair.base_token),
                price: pair.price
            }));

        console.log(`✅ Tokens seleccionados: ${topTokens.length}`);
        return topTokens;
    } catch (error) {
        console.error("❌ Error obteniendo tokens:", error);
        return [];
    }
}

async function getTokenPrice(tokenPubKey) {
    try {
        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const pairs = await response.json();
        const pair = pairs.find(p => p.base_token === tokenPubKey.toBase58());
        return pair ? pair.price : 1;
    } catch (error) {
        console.error("❌ Error obteniendo precio:", error);
        return 1;
    }
}

async function buyToken(tokenPubKey) {
    const price = await getTokenPrice(tokenPubKey);
    const amountPerTrade = tradingCapital / maxTrades;
    console.log(`🛒 Comprando ${tokenPubKey.toBase58()} a $${price} con ${amountPerTrade} SOL`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amountPerTrade * 1e9),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Compra realizada: ${signature}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    } catch (error) {
        console.error("❌ Error en compra:", error);
    }
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;

    console.log(`📉 Vendiendo ${tokenPubKey.toBase58()} a $${currentPrice} (compra: $${buyPrice})`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amount * 1e9 * (currentPrice / buyPrice)),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`✅ Venta realizada: ${signature}`);

        // Ajuste de capital
        if (profit > 0) {
            const halfProfit = profit / 2;
            savedSol += halfProfit;
            tradingCapital += halfProfit;
        } else {
            tradingCapital += profit; // Resta pérdida
        }

        console.log(`💰 Balance actualizado: Capital ${tradingCapital} SOL | Guardado ${savedSol} SOL`);
        delete portfolio[tokenPubKey.toBase58()];
    } catch (error) {
        console.error("❌ Error en venta:", error);
    }
}

async function tradingBot() {
    console.log('🚀 Iniciando ciclo de trading...');
    console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);

    if (tradingCapital < 0.01) {
        console.log('⚠️  Capital insuficiente. Deteniendo bot.');
        return;
    }

    const topTokens = await fetchTopTokens();
    console.log(`🔎 Tokens filtrados: ${topTokens.length}`);

    for (const { token } of topTokens) {
        if (!portfolio[token.toBase58()] && Object.keys(portfolio).length < maxTrades) {
            await buyToken(token);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Pequeña pausa para no sobrecargar
        }
    }

    for (const token in portfolio) {
        const currentPrice = await getTokenPrice(new PublicKey(token));
        const { buyPrice } = portfolio[token];
        if (currentPrice >= buyPrice * 1.30 || currentPrice <= buyPrice * 0.95) {
            await sellToken(new PublicKey(token));
        }
    }

    console.log('✅ Ciclo completado.');
}

// Iniciar bot con intervalos más largos para reducir consumo de RAM
function startBot() {
    console.log('🤖 Bot iniciando...');
    tradingBot();
    setInterval(() => {
        console.log('🔄 Iniciando nuevo ciclo...');
        tradingBot();
    }, 900000); // ⏳ Cada 15 minutos (antes era 10)
}

startBot();

