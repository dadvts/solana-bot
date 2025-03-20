const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { Jupiter } = require('@jup-ag/core');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.default.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const portfolio = {};
let tradingCapital = 0.08; // Tu saldo real
let savedSol = 0;
const maxTrades = 1; // Solo 1 trade con 0.08 SOL
const MIN_TRADE_AMOUNT = 0.02; // Mínimo viable con fees

async function fetchTopTokens() {
    console.log('Fetching top tokens from Jupiter...');
    try {
        const response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=any&amount=80000000&slippage=0.5');
        const data = await response.json();
        const topPair = data.data
            .filter(quote => quote.liquidity > 1000000 && quote.priceImpactPc < 1) // Alta liquidez, bajo impacto
            .sort((a, b) => b.outAmount - a.outAmount)[0]; // Mejor retorno
        console.log('Top token found:', topPair ? topPair.outputMint : 'none');
        return topPair ? [{ token: new PublicKey(topPair.outputMint), price: topPair.outAmount / 1e6 }] : [];
    } catch (error) {
        console.log('Error obteniendo tokens:', error.message);
        return [];
    }
}

async function getTokenPrice(tokenPubKey) {
    console.log(`Getting price for ${tokenPubKey.toBase58()}...`);
    try {
        const response = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenPubKey.toBase58()}&amount=1000000`);
        const data = await response.json();
        return data.data[0].outAmount / 1e6; // Precio aproximado en SOL
    } catch (error) {
        console.log('Error al obtener precio:', error.message);
        return 1;
    }
}

async function buyToken(tokenPubKey, amountPerTrade) {
    console.log(`Comprando ${tokenPubKey.toBase58()} con ${amountPerTrade} SOL`);
    try {
        const jupiter = await Jupiter.load({ connection, cluster: 'mainnet-beta', user: keypair });
        const routes = await jupiter.computeRoutes({
            inputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
            outputMint: tokenPubKey,
            amount: Math.floor(amountPerTrade * 1e9), // 0.08 SOL en lamports
            slippageBps: 50 // 0.5% slippage
        });
        const tx = await jupiter.exchange(routes.routesInfos[0]);
        const signature = await tx.execute();
        const price = await getTokenPrice(tokenPubKey);
        console.log(`✅ Compra: ${signature} | Precio: $${price}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
        tradingCapital -= amountPerTrade;
    } catch (error) {
        console.log('❌ Error en compra:', error.message);
    }
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    console.log(`Vendiendo ${tokenPubKey.toBase58()} a $${currentPrice}`);
    try {
        const jupiter = await Jupiter.load({ connection, cluster: 'mainnet-beta', user: keypair });
        const routes = await jupiter.computeRoutes({
            inputMint: tokenPubKey,
            outputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
            amount: Math.floor(amount * currentPrice * 1e6), // Ajustar decimales según token
            slippageBps: 50
        });
        const tx = await jupiter.exchange(routes.routesInfos[0]);
        const signature = await tx.execute();
        const profit = (currentPrice / buyPrice - 1) * amount;
        console.log(`✅ Venta: ${signature}`);
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
    } catch (error) {
        console.log('❌ Error en venta:', error.message);
    }
}

async function tradingBot() {
    try {
        console.log('🤖 Iniciando ciclo de trading...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (tradingCapital < MIN_TRADE_AMOUNT) {
            console.log('🚫 Capital insuficiente para operar.');
            return;
        }
        const topTokens = await fetchTopTokens();
        if (topTokens.length === 0) {
            console.log('⚠️ No se encontraron tokens válidos.');
            return;
        }
        console.log('📡 Buscando mejores tokens...');
        console.log('Tokens obtenidos:', topTokens.length);

        const amountPerTrade = tradingCapital; // Usa todo el capital
        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades || tradingCapital < MIN_TRADE_AMOUNT) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(token, amountPerTrade);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(new PublicKey(token));
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.50 || currentPrice <= buyPrice * 0.90) {
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
    }, 60000); // Cada minuto
}

startBot();
