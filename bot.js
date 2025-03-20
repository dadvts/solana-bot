const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const jupiterApi = createJupiterApiClient();
const portfolio = {};
let tradingCapital = 0.08; // Tu saldo real
let savedSol = 0;
const maxTrades = 1;
const MIN_TRADE_AMOUNT = 0.02;

async function fetchTopTokens() {
    console.log('Fetching top tokens from Jupiter API...');
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112', // SOL
            outputMint: '7xKXtzSsc1uPucxW9VpjeXCqiYxnmX2rcza7GW2aM5R', // RAY (ejemplo volátil)
            amount: Math.floor(tradingCapital * 1e9),
            slippageBps: 50
        });
        return [{ token: new PublicKey(quote.routePlan[0].swapInfo.outputMint), price: quote.outAmount / 1e9 }];
    } catch (error) {
        console.log('Error obteniendo tokens:', error.message);
        return [];
    }
}

async function buyToken(tokenPubKey, amountPerTrade) {
    console.log(`Comprando ${tokenPubKey.toBase58()} con ${amountPerTrade} SOL`);
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(amountPerTrade * 1e9),
            slippageBps: 50
        });
        const swap = await jupiterApi.swapPost({
            swapRequest: {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true
            }
        });
        const tx = await connection.sendRawTransaction(Buffer.from(swap.swapTransaction, 'base64'));
        await connection.confirmTransaction(tx);
        console.log(`✅ Compra: ${tx} | Precio: ${quote.outAmount / 1e9} SOL`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: quote.outAmount / 1e9, amount: amountPerTrade };
        tradingCapital -= amountPerTrade;
    } catch (error) {
        console.log('❌ Error en compra:', error.message);
    }
}

async function sellToken(tokenPubKey) {
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    console.log(`Vendiendo ${tokenPubKey.toBase58()}`);
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: tokenPubKey.toBase58(),
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: Math.floor(amount / buyPrice * 1e9),
            slippageBps: 50
        });
        const swap = await jupiterApi.swapPost({
            swapRequest: {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true
            }
        });
        const tx = await connection.sendRawTransaction(Buffer.from(swap.swapTransaction, 'base64'));
        await connection.confirmTransaction(tx);
        const currentPrice = quote.outAmount / 1e9;
        const profit = (currentPrice / buyPrice - 1) * amount;
        console.log(`✅ Venta: ${tx}`);
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

        const amountPerTrade = tradingCapital;
        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades || tradingCapital < MIN_TRADE_AMOUNT) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(token, amountPerTrade);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        for (