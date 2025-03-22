const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
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
const portfolio = {
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx': {
        buyPrice: 0.14 / 13391.45752205,
        amount: 12600,
        lastPrice: 0.000010454425873321102
    },
    'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB': {
        buyPrice: 0.01274 / 180.612,
        amount: 180.612,
        lastPrice: 0.00007054
    }
};
let tradingCapital = 0.003949694; // Ajustado a tu saldo real
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.001; // Reducido para operar con poco SOL
const FEE_RESERVE = 0.0005;
const CRITICAL_THRESHOLD = 0.0005; // Reducido para evitar ventas prematuras
const CYCLE_INTERVAL = 600000;
const UPDATE_INTERVAL = 720 * 60000;

let volatileTokens = [
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', // ATLAS
    'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB', // GST
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // SAMO
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN',  // SLND
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'   // mSOL
];

async function getTokenDecimals(mintPubKey) {
    try {
        const mint = await getMint(connection, new PublicKey(mintPubKey));
        return mint.decimals;
    } catch (error) {
        console.log(`Error obteniendo decimales para ${mintPubKey}:`, error.message);
        return 6;
    }
}

async function updateVolatileTokens() {
    console.log('Manteniendo lista predefinida de tokens volátiles...');
    // Por ahora, usamos la lista estática para evitar problemas con DexScreener
    console.log('Lista actual:', volatileTokens);
}

async function getWalletBalance() {
    const balance = await connection.getBalance(walletPubKey);
    return balance / 1e9;
}

async function selectBestToken() {
    console.log('Analizando tokens volátiles...');
    let bestToken = null;
    let highestPricePerSol = 0;

    for (const tokenMint of volatileTokens) {
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: 'So11111111111111111111111111111111111111112',
                outputMint: tokenMint,
                amount: Math.floor((tradingCapital - FEE_RESERVE) * 1e9),
                slippageBps: 50
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const pricePerSol = tokenAmount / (tradingCapital - FEE_RESERVE);
            console.log(`Token: ${tokenMint} | Precio por SOL: ${pricePerSol} | Cantidad esperada: ${tokenAmount} | Decimales: ${decimals}`);
            if (pricePerSol > highestPricePerSol) {
                highestPricePerSol = pricePerSol;
                bestToken = { token: new PublicKey(tokenMint), price: tokenAmount, decimals };
            }
        } catch (error) {
            console.log(`Error con ${tokenMint}:`, error.message);
        }
    }

    if (!bestToken) {
        console.log('No se encontró token válido para comprar.');
        return null;
    }
    console.log('Mejor token seleccionado:', bestToken.token.toBase58(), '| Cantidad:', bestToken.price, '| Decimales:', bestToken.decimals);
    return bestToken;
}

async function buyToken(tokenPubKey, amountPerTrade) {
    console.log(`Comprando ${tokenPubKey.toBase58()} con ${amountPerTrade} SOL`);
    try {
        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(amountPerTrade * 1e9),
            slippageBps: 50
        });
        const tokenAmount = quote.outAmount / (10 ** decimals);
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
        console.log(`Compra: ${txid} | Obtuviste: ${tokenAmount} ${tokenPubKey.toBase58()}`);
        portfolio[tokenPubKey.toBase58()] = { 
            buyPrice: amountPerTrade / tokenAmount, 
            amount: tokenAmount, 
            lastPrice: amountPerTrade / tokenAmount,
            decimals
        };
        tradingCapital -= amountPerTrade;
        console.log(`Capital restante tras compra: ${tradingCapital} SOL`);
    } catch (error) {
        console.log('Error en compra:', error.message);
    }
}

async function sellToken(tokenPubKey) {
    const { buyPrice, amount, lastPrice, decimals } = portfolio[tokenPubKey.toBase58()];
    console.log(`Vendiendo ${tokenPubKey.toBase58()} (${amount} tokens)`);
    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: tokenPubKey.toBase58(),
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: Math.floor(amount * (10 ** decimals)),
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
        console.log(`Venta: ${txid} | Recibiste: ${solReceived} SOL`);

        const totalSol = tradingCapital + savedSol;
        if (totalSol >= 0.3) {
            const netProfit = profit;
            tradingCapital += (netProfit * 0.5);
            savedSol += (netProfit * 0.5);
            console.log(`Umbral de 0.3 SOL alcanzado. Reinversión: ${netProfit * 0.5} SOL | Guardado: ${netProfit * 0.5} SOL`);
        } else {
            tradingCapital += solReceived;
            console.log(`Ganancia: ${profit} SOL | Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        }
        delete portfolio[tokenPubKey.toBase58()];
    } catch (error) {
        console.log('Error en venta:', error.message);
    }
}

async function tradingBot() {
    try {
        console.log('Iniciando ciclo de trading...');
        const realBalance = await getWalletBalance();
        console.log(`Saldo real: ${realBalance} SOL | Capital registrado: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (realBalance < tradingCapital) {
            console.log('Saldo real menor al registrado. Actualizando...');
            tradingCapital = realBalance;
        }

        if (realBalance < CRITICAL_THRESHOLD && Object.keys(portfolio).length > 0) {
            console.log('Capital crítico detectado. Vendiendo todo...');
            for (const token in portfolio) {
                await sellToken(new PublicKey(token));
            }
            return;
        }

        console.log(`Portfolio actual: ${JSON.stringify(portfolio)}`);

        if (tradingCapital < MIN_TRADE_AMOUNT + FEE_RESERVE && Object.keys(portfolio).length === 0) {
            console.log('Capital insuficiente para operar (incluyendo fees).');
            return;
        }

        if (Object.keys(portfolio).length === 0 && tradingCapital >= MIN_TRADE_AMOUNT + FEE_RESERVE) {
            const token = await selectBestToken();
            if (!token) return;
            const tradeAmount = tradingCapital - FEE_RESERVE;
            await buyToken(token.token, tradeAmount);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        for (const token in portfolio) {
            const decimals = portfolio[token].decimals || await getTokenDecimals(token);
            const quote = await jupiterApi.quoteGet({
                inputMint: token,
                outputMint: 'So11111111111111111111111111111111111111112',
                amount: Math.floor(portfolio[token].amount * (10 ** decimals))
            });
            const currentPrice = (quote.outAmount / 1e9) / portfolio[token].amount;
            const { buyPrice, lastPrice } = portfolio[token];
            console.log(`Token: ${token} | Precio actual: ${currentPrice} SOL | Precio compra: ${buyPrice} SOL | Precio anterior: ${lastPrice} SOL`);

            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

            if (currentPrice <= buyPrice * 0.99) { // Ajustado temporalmente para forzar venta
                console.log(`Stop-loss activado: ${currentPrice} <= ${buyPrice * 0.99}`);
                await sellToken(new PublicKey(token));
            } else if (currentPrice >= buyPrice * 1.05) { // Ajustado temporalmente
                if (growthVsLast <= 0) {
                    console.log(`Venta por ganancia estabilizada: ${currentPrice} >= ${buyPrice * 1.05}, crecimiento: ${(growthVsLast * 100).toFixed(2)}%`);
                    await sellToken(new PublicKey(token));
                } else {
                    console.log(`Tendencia alcista detectada (${(growthVsLast * 100).toFixed(2)}% vs anterior). Esperando...`);
                }
            } else {
                portfolio[token].lastPrice = currentPrice;
                console.log(`Precio actualizado. Sin acción tomada.`);
            }
        }

        console.log('Ciclo de trading completado.');
    } catch (error) {
        console.error('Error en el ciclo:', error.message);
    }
}

function startBot() {
    console.log('Bot starting...');
    updateVolatileTokens();
    tradingBot();
    setInterval(() => {
        console.log('Nuevo ciclo de trading iniciando...');
        tradingBot();
    }, CYCLE_INTERVAL);
    setInterval(() => {
        console.log('Actualizando lista de tokens...');
        updateVolatileTokens();
    }, UPDATE_INTERVAL);
}

startBot();