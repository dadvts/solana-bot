const { Connection, Keypair, PublicKey, Transaction } = require('@solana/web3.js');
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
            outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            amount: Math.floor(tradingCapital * 1e9),
            slippageBps: 50
        });
        console.log('Quote received:', quote);
        return [{ token: new PublicKey(quote.routePlan[0].swapInfo.outputMint), price: quote.outAmount / 1e9 }];
    } catch (error) {
        console.log('Error obteniendo tokens:', error.message, error.response ? error.response.data : '');
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
        const transaction = Transaction.from(Buffer.from(swap.swapTransaction, 'base64'));
        transaction.sign(keypair);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);
        console.log(`✅ Compra: ${txid} | Precio: ${quote.outAmount / 1e9} SOL`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: quote.outAmount / 1e9, amount: amountPerTrade };
        tradingCapital -= amountPerTrade;
    } catch (error) {
        console.log('❌ Error en compra:', error.message);
        if (error.getLogs) {
            const logs = await error.getLogs(connection);
            console.log('Logs de error:', logs);
        }
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
        const transaction = Transaction.from(Buffer.from(swap.swapTransaction, 'base64'));
        transaction.sign(keypair);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);
        const currentPrice = quote.outAmount / 1e9;
        const profit = (currentPrice / buyPrice - 1) * amount;
        console.log(`✅ Venta: ${txid}`);
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
        if (error.getLogs) {
            const logs = await error.getLogs(connection);
            console.log('Logs de error:', logs);
        }
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

        for (const token in portfolio) {
            const quote = await jupiterApi.quoteGet({
                inputMint: token,
                outputMint: 'So11111111111111111111111111111111111111112',
                amount: Math.floor(portfolio[token].amount / portfolio[token].buyPrice * 1e9)
            });
            const currentPrice = quote.outAmount / 1e9;
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
    }, 60000);
}

startBot();