const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const jupiterApi = createJupiterApiClient();
const portfolio = {};
let tradingCapital = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.02;
const INITIAL_INVESTMENT = 0.14;
const TARGET_THRESHOLD = 0.3;
const CYCLE_INTERVAL = 600000;
const UPDATE_INTERVAL = 720 * 60000;

// Lista inicial (fallback)
let volatileTokens = [
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', // ATLAS
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // SAMO
    'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB', // GST
    'StepApp-3KDXpB2SZMfxSX8j6Z82TR461uvLphxWPho5XRHfLGL', // STEP
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN'  // SLND
];

// Estado inicial con tu compra
portfolio['ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx'] = {
    buyPrice: INITIAL_INVESTMENT / 1339145.752205, // ~1.0454e-7 SOL/ATLAS
    amount: 1339145.752205,
    lastPrice: 1.0415398456093406e-7 // Último ciclo
};

async function updateVolatileTokens() {
    console.log('Actualizando lista de tokens volátiles con DexScreener...');
    try {
        const response = await axios.get('https://api.dexscreener.com/latest/dex/search', {
            params: {
                q: 'sol', // Buscar pares con SOL como base o quote
                chainIds: 'solana'
            }
        });
        const pairs = response.data.pairs || [];
        console.log(`Total pares obtenidos: ${pairs.length}`);

        const solanaTokens = pairs
            .filter(pair => {
                const marketCap = pair.fdv; // Fully Diluted Valuation
                const volume = pair.volume.h24;
                return marketCap >= 1000000 && marketCap <= 100000000 && volume >= 50000;
            })
            .map(pair => pair.baseToken.address)
            .filter((address, index, self) => address && address.length === 44 && self.indexOf(address) === index); // Eliminar duplicados

        console.log(`Tokens de Solana filtrados: ${solanaTokens.length}`);
        if (solanaTokens.length > 0) {
            volatileTokens = solanaTokens.slice(0, 10);
            console.log('Lista actualizada:', volatileTokens);
        } else {
            console.log('No se encontraron tokens válidos de Solana. Usando lista previa.');
            volatileTokens = volatileTokens.slice(1).concat(volatileTokens[0]);
            console.log('Lista rotada (fallback):', volatileTokens);
        }
    } catch (error) {
        console.log('Error actualizando con DexScreener:', error.message);
        volatileTokens = volatileTokens.slice(1).concat(volatileTokens[0]);
        console.log('Lista rotada (fallback):', volatileTokens);
    }
}

async function selectBestToken() {
    console.log('Analizando tokens volátiles...');
    let bestToken = null;
    let highestPricePerSol = 0;

    for (const tokenMint of volatileTokens) {
        try {
            const quote = await jupiterApi.quoteGet({
                inputMint: 'So11111111111111111111111111111111111111112',
                outputMint: tokenMint,
                amount: Math.floor(tradingCapital * 1e9),
                slippageBps: 50
            });
            const tokenAmount = quote.outAmount / 1e6;
            const pricePerSol = tokenAmount / tradingCapital;
            console.log(`Token: ${tokenMint} | Precio por SOL: ${pricePerSol}`);
            if (pricePerSol > highestPricePerSol) {
                highestPricePerSol = pricePerSol;
                bestToken = { token: new PublicKey(tokenMint), price: tokenAmount };
            }
        } catch (error) {
            console.log(`Error con ${tokenMint}:`, error.message);
        }
    }

    if (!bestToken) {
        console.log('⚠️ No se encontró token válido.');
        return null;
    }
    console.log('Mejor token seleccionado:', bestToken.token.toBase58());
    return bestToken;
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
        portfolio[tokenPubKey.toBase58()] = { 
            buyPrice: amountPerTrade / tokenAmount, 
            amount: tokenAmount, 
            lastPrice: 0 
        };
        tradingCapital -= amountPerTrade;
    } catch (error) {
        console.log('❌ Error en compra:', error.message);
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

        const totalSol = tradingCapital + savedSol;
        if (totalSol >= TARGET_THRESHOLD) {
            const netProfit = profit;
            tradingCapital += (netProfit * 0.5);
            savedSol += (netProfit * 0.5);
            console.log(`📈 Umbral de ${TARGET_THRESHOLD} SOL alcanzado previamente. Reinversión: ${netProfit * 0.5} SOL | Guardado: ${netProfit * 0.5} SOL`);
        } else {
            tradingCapital += solReceived;
            console.log(`📈 Ganancia: ${profit} SOL | Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        }
        delete portfolio[tokenPubKey.toBase58()]);
    } catch (error) {
        console.log('❌ Error en venta:', error.message);
    }
}

async function tradingBot() {
    try {
        console.log('🤖 Iniciando ciclo de trading...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (tradingCapital < MIN_TRADE_AMOUNT && Object.keys(portfolio).length === 0) {
            console.log('🚫 Capital insuficiente y sin tokens para vender.');
            return;
        }

        if (Object.keys(portfolio).length === 0 && tradingCapital >= MIN_TRADE_AMOUNT) {
            const token = await selectBestToken();
            if (!token) return;
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
            const { buyPrice, lastPrice } = portfolio[token];
            console.log(`Token: ${token} | Precio actual: ${currentPrice} SOL | Precio compra: ${buyPrice} SOL | Precio anterior: ${lastPrice} SOL`);

            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

            if (currentPrice <= buyPrice * 0.97) { // Stop-loss -3%
                await sellToken(new PublicKey(token));
            } else if (currentPrice >= buyPrice * 1.075) { // Ganancia ≥7.5%
                if (growthVsLast <= 0) { // Crecimiento igual o menor que el anterior
                    await sellToken(new PublicKey(token));
                } else {
                    console.log(`Tendencia alcista detectada (${(growthVsLast * 100).toFixed(2)}% vs anterior). Esperando...`);
                }
            }
            portfolio[token].lastPrice = currentPrice;
        }

        console.log('✔️ Ciclo de trading completado.');
    } catch (error) {
        console.error('❌ Error en el ciclo:', error.message);
    }
}

function startBot() {
    console.log('🚀 Bot starting...');
    updateVolatileTokens();
    tradingBot();
    setInterval(() => {
        console.log('🔄 Nuevo ciclo de trading iniciando...');
        tradingBot();
    }, CYCLE_INTERVAL);
    setInterval(() => {
        console.log('🔄 Actualizando lista de tokens...');
        updateVolatileTokens();
    }, UPDATE_INTERVAL);
}

startBot();