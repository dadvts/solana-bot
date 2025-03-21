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
const portfolio = {};
let tradingCapital = 0; // Actualizado tras la compra
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.02;
const CYCLE_INTERVAL = 900000; // 15 minutos en ms

// Lista viva de tokens (inicial)
let volatileTokens = [
    'StepApp-3KDXpB2SZMfxSX8j6Z82TR461uvLphxWPho5XRHfLGL', // STEP
    'kinXdEcpDQeHPEuQnqmUgtYvK2sjDarPRCVCEnnExST', // KIN
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN', // SLND
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', // ATLAS
    'poLisWXnNRwC6oBu1vHciRGY3KG3J4Gnc57HbDQNDDKL' // POLIS
];

// Estado inicial tras tu compra
portfolio['ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx'] = {
    buyPrice: 0.14 / 1339145.752205, // ~1.0454e-7 SOL/ATLAS
    amount: 1339145.752205
};

async function updateVolatileTokens() {
    console.log('Actualizando lista de tokens volátiles...');
    const newTokens = [];
    try {
        const candidates = volatileTokens.concat(getRandomTokens(5));
        for (const tokenMint of candidates) {
            const quote = await jupiterApi.quoteGet({
                inputMint: 'So11111111111111111111111111111111111111112',
                outputMint: tokenMint,
                amount: Math.floor(0.1 * 1e9), // Prueba con 0.1 SOL
                slippageBps: 50
            });
            const tokenAmount = quote.outAmount / 1e6;
            const pricePerSol = tokenAmount / 0.1;
            const marketCapEstimate = pricePerSol * 40000000; // Aproximación
            if (marketCapEstimate > 1000000 && marketCapEstimate < 100000000) {
                newTokens.push(tokenMint);
            }
        }
        if (newTokens.length > 0) {
            volatileTokens = newTokens.slice(0, 10);
            console.log('Lista actualizada:', volatileTokens);
        } else {
            console.log('No se encontraron nuevos tokens válidos. Manteniendo lista actual.');
        }
    } catch (error) {
        console.log('Error actualizando tokens:', error.message);
    }
}

function getRandomTokens(count) {
    const knownTokens = [
        '7xKXtzSsc1uPucxW9VpjeXCqiYxnmX2rcza7GW2aM5R', // RAY
        'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt', // SRM
        'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' // ORCA
    ];
    return knownTokens.sort(() => 0.5 - Math.random()).slice(0, count);
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
        tradingCapital += solReceived;
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
        if (tradingCapital < MIN_TRADE_AMOUNT && Object.keys(portfolio).length === 0) {
            console.log('🚫 Capital insuficiente y sin tokens para vender.');
            return;
        }

        await updateVolatileTokens();

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
            const { buyPrice } = portfolio[token];
            console.log(`Token: ${token} | Precio actual: ${currentPrice} SOL | Precio compra: ${buyPrice} SOL`);
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
    }, CYCLE_INTERVAL);
}

startBot();