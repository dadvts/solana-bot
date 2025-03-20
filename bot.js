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
const maxTrades = 1;
const MIN_TRADE_AMOUNT = 0.02;

async function fetchTopTokens(jupiter) {
    console.log('Fetching top tokens from Jupiter...');
    try {
        const routes = await jupiter.computeRoutes({
            inputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
            outputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC como ejemplo
            amount: Math.floor(tradingCapital * 1e9), // 0.08 SOL
            slippageBps: 50
        });
        const topRoute = routes.routesInfos
            .filter(route => route.liquidity > 1000000 && route.priceImpactPc < 1)
            .sort((a, b) => b.outAmount - a.outAmount)[0];
        console.log('Top token found:', topRoute ? topRoute.outputMint.toBase58() : 'none');
        return topRoute ? [{ token: topRoute.outputMint, price: topRoute.outAmount / 1e9 }] : [];
    } catch (error) {
        console.log('Error obteniendo tokens:', error.message);
        return [];
    }
}

async function buyToken(jupiter, tokenPubKey, amountPerTrade) {
    console.log(`Comprando ${tokenPubKey.toBase58()} con ${amountPerTrade} SOL`);
    try {
        const routes = await jupiter.computeRoutes({
            inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
            outputMint: tokenPubKey,
            amount: Math.floor(amountPerTrade * 1e9),
            slippageBps: 50
        });
        const tx = await jupiter.exchange(routes.routesInfos[0]);
        const signature = await tx.execute();
        const price = routes.routesInfos[0].outAmount / 1e9;
        console.log(`✅ Compra: ${signature} | Precio: ${price} SOL`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
        tradingCapital -= amountPerTrade;
    } catch (error) {
        console.log('❌ Error en compra:', error.message);
    }
}

async function sellToken(jupiter, tokenPubKey) {
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    console.log(`Vendiendo ${tokenPubKey.toBase58()}`);
    try {
        const routes = await jupiter.computeRoutes({
            inputMint: tokenPubKey,
            outputMint: new PublicKey('So11111111111111111111111111111111111111112'),
            amount: Math.floor(amount / buyPrice * 1e9), // Ajustar según token
            slippageBps: 50
        });
        const currentPrice = routes.routesInfos[0].outAmount / 1e9;
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
        const jupiter = await Jupiter.load({ connection, cluster: 'mainnet-beta', user: keypair });
        const topTokens = await fetchTopTokens(jupiter);
        if (topTokens.length === 0) {
            console.log('⚠️ No se encontraron tokens válidos.');
            return;
        }
        console.log('📡 Buscando mejores tokens...');
        console.log('Tokens obtenidos:', topTokens.length);

        const amountPerTrade = tradingCapital;
        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades || tradingCapital < MIN_TRADE_AMOUNT) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(jupiter, token, amountPerTrade);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        for (const token in portfolio) {
            const currentPrice = await jupiter.computeRoutes({
                inputMint: new PublicKey(token),
                outputMint: new PublicKey('So11111111111111111111111111111111111111112'),
                amount: Math.floor(portfolio[token].amount / portfolio[token].buyPrice * 1e9)
            }).then(routes => routes.routesInfos[0].outAmount / 1e9);
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.50 || currentPrice <= buyPrice * 0.90) {
                await sellToken(jupiter, new PublicKey(token));
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
    }, 60000);
}

startBot();