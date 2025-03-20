const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const jupiterApi = createJupiterApiClient();
const portfolio = {
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { buyPrice: 0.08 / 10.23, amount: 10.23 } // USDT comprado
};
let tradingCapital = 0; // Tras la compra inicial
let savedSol = 0;
const maxTrades = 1;
const MIN_TRADE_AMOUNT = 0.02;

async function fetchTopTokens() {
    console.log('Fetching top tokens from Jupiter API...');
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112', // SOL
            outputMint: '7xKXtzSsc1uPucxW9VpjeXCqiYxnmX2rcza7GW2aM5R', // RAY (volátil)
            amount: Math.floor(tradingCapital * 1e9),
            slippageBps: 50
        });
        console.log('Quote received:', quote);
        return [{ token: new PublicKey(quote.routePlan[0].swapInfo.outputMint), price: quote.outAmount / 1e6 }]; // RAY usa 6 decimales
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
        const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);
        const tokenAmount = quote.outAmount / 1e6; // Cantidad en tokens (ej. RAY)
        console.log(`✅ Compra: ${txid} | Obtuviste: ${tokenAmount} ${tokenPubKey.toBase58()}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: amountPerTrade / tokenAmount, amount: tokenAmount }; // Precio en SOL por token
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
    console.log(`Vendiendo ${tokenPubKey.toBase58()} (${amount} tokens)`);
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: tokenPubKey.toBase58(),
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: Math.floor(amount * 1e6), // Convertir a lamports (USDT/RAY usan 6 decimales)
            slippageBps: 50
        });
        const swap = await jupiterApi.swapPost({
            swapRequest: {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true
            }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);
        const solReceived = quote.outAmount / 1e9; // SOL recibido
        const profit = solReceived - (amount * buyPrice);
        console.log(`✅ Venta: ${txid} | Recibiste: ${solReceived} SOL`);
        if (profit > 0) {
            const halfProfit = profit / 2;
            savedSol += halfProfit;
            tradingCapital += halfProfit + (amount * buyPrice);
            console.log(`📈 Ganancia: ${profit} SOL | Guardado: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
        } else {
            tradingCapital += profit + (amount * buyPrice);
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
            console.log('🚫 Capital insuficiente para operar. Vendiendo tokens existentes...');
        } else {
            const topTokens = await fetchTopTokens();
            if (topTokens.length === 0) {
                console.log('⚠️ No se encontraron tokens válidos.');
            } else {
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
            }
        }

        for (const token in portfolio) {
            const quote = await jupiterApi.quoteGet({
                inputMint: token,
                outputMint: 'So11111111111111111111111111111111111111112',
                amount: Math.floor(portfolio[token].amount * 1e6) // Tokens a lamports
            });
            const currentPrice = quote.outAmount / 1e9 / portfolio[token].amount; // SOL por token
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.50 || currentPrice <= buyPrice * 0.90 || tradingCapital < MIN_TRADE_AMOUNT) {
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