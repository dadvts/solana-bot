const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios'); // Para obtener datos de mercado

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const jupiterApi = createJupiterApiClient();
const portfolio = {};
let tradingCapital = 0.14; // Capital actual
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.02;

// Lista inicial de tokens volátiles con market cap >$1M
const volatileTokens = [
    'StepApp-3KDXpB2SZMfxSX8j6Z82TR461uvLphxWPho5XRHfLGL', // STEP
    'kinXdEcpDQeHPEuQnqmUgtYvK2sjDarPRCVCEnnExST', // KIN
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN', // SLND
];

async function fetchVolatileToken() {
    console.log('Buscando token volátil con alto volumen...');
    try {
        // Obtener datos de mercado desde CoinGecko (alternativa: CoinMarketCap API si tienes key)
        const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                ids: 'step-app,kin,solend', // IDs de CoinGecko para STEP, KIN, SLND
                order: 'volume_desc',
                per_page: 10,
                page: 1,
                sparkline: false
            }
        });
        const tokens = response.data.filter(token => 
            token.market_cap > 1000000 && token.total_volume > 500000
        );
        if (tokens.length === 0) throw new Error('No se encontraron tokens con volumen suficiente');
        
        const selectedToken = tokens[0]; // El de mayor volumen
        const tokenMint = volatileTokens.find(mint => 
            mint.includes(selectedToken.symbol.toUpperCase()) || mint === selectedToken.id
        );
        if (!tokenMint) throw new Error('Token no soportado en la lista');

        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112', // SOL
            outputMint: tokenMint,
            amount: Math.floor(tradingCapital * 1e9),
            slippageBps: 50
        });
        console.log('Quote received:', quote);
        return { token: new PublicKey(tokenMint), price: quote.outAmount / 1e6 };
    } catch (error) {
        console.log('Error buscando token:', error.message);
        return null;
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
        const tokenAmount = quote.outAmount / 1e6;
        console.log(`✅ Compra: ${txid} | Obtuviste: ${tokenAmount} ${tokenPubKey.toBase58()}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: amountPerTrade / tokenAmount, amount: tokenAmount };
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
            amount: Math.floor(amount * 1e6),
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
        const solReceived = quote.outAmount / 1e9;
        const profit = solReceived - (amount * buyPrice);
        console.log(`✅ Venta: ${txid} | Recibiste: ${solReceived} SOL`);
        tradingCapital += solReceived; // Reinvertir todo
        console.log(`📈 Ganancia: ${profit} SOL | Capital: ${tradingCapital} SOL`);
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

        if (Object.keys(portfolio).length === 0) {
            const token = await fetchVolatileToken();
            if (!token) {
                console.log('⚠️ No se encontró token válido.');
                return;
            }
            console.log('📡 Seleccionado token:', token.token.toBase58());
            await buyToken(token.token, tradingCapital);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        for (const token in portfolio) {
            const quote = await jupiterApi.quoteGet({
                inputMint: token,
                outputMint: 'So11111111111111111111111111111111111111112',
                amount: Math.floor(portfolio[token].amount * 1e6)
            });
            const currentPrice = quote.outAmount / 1e9 / portfolio[token].amount;
            const { buyPrice } = portfolio[token];
            console.log(`Precio actual: ${currentPrice} SOL | Precio compra: ${buyPrice} SOL`);
            if (currentPrice >= buyPrice * 1.20 || currentPrice <= buyPrice * 0.95) {
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