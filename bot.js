const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios');

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;
const jupiterApi = createJupiterApiClient({ basePath: 'https://quote-api.jup.ag' });

let tradingCapital = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.0001;
const FEE_RESERVE = 0.0025;
const CRITICAL_THRESHOLD = 0.0001;
const CYCLE_INTERVAL = 600000;
const UPDATE_INTERVAL = 720 * 60000;
const REINVEST_THRESHOLD = 1;

let portfolio = {
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx': {
        buyPrice: 0.000010125718206681775,
        amount: 13749.91503399,
        lastPrice: 0.000010125718206681775,
        decimals: 8
    }
};
let volatileTokens = [
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx',
    'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB',
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
];
let lastSoldToken = 'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx'; // Inicializado con ATLAS

async function getTokenDecimals(mintPubKey) {
    try {
        const mint = await getMint(connection, new PublicKey(mintPubKey));
        return mint.decimals;
    } catch (error) {
        return 6;
    }
}

async function getTokenBalance(tokenMint) {
    try {
        const ata = await getAssociatedTokenAddress(new PublicKey(tokenMint), walletPubKey);
        const account = await getAccount(connection, ata);
        const decimals = await getTokenDecimals(tokenMint);
        return Number(account.amount) / (10 ** decimals);
    } catch (error) {
        return 0;
    }
}

async function getWalletBalance() {
    const balance = await connection.getBalance(walletPubKey);
    return balance / LAMPORTS_PER_SOL;
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    console.log('Lista actual:', volatileTokens);
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapital - FEE_RESERVE;

    for (const tokenMint of volatileTokens) {
        if (tokenMint === 'So11111111111111111111111111111111111111112' || tokenMint === lastSoldToken) continue;
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: 'So11111111111111111111111111111111111111112',
                outputMint: tokenMint,
                amount: Math.floor(availableCapital * LAMPORTS_PER_SOL),
                slippageBps: 500
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const returnPerSol = tokenAmount / availableCapital;
            if (returnPerSol > highestReturn) {
                highestReturn = returnPerSol;
                bestToken = { token: new PublicKey(tokenMint), amount: tokenAmount, decimals };
            }
        } catch (error) {
            console.log(`Error evaluando ${tokenMint}: ${error.message}`);
        }
    }
    if (bestToken) console.log(`Mejor token seleccionado: ${bestToken.token.toBase58()}`);
    else console.log('No se encontró un token viable para comprar');
    return bestToken;
}

async function buyToken(tokenPubKey, amountPerTrade) {
    try {
        const liquidBalance = await getWalletBalance();
        const tradeAmount = Math.min(amountPerTrade, liquidBalance - FEE_RESERVE);
        if (tradeAmount < MIN_TRADE_AMOUNT) throw new Error(`Monto insuficiente: ${tradeAmount} SOL`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: 'So11111111111111111111111111111111111111112',
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(tradeAmount * LAMPORTS_PER_SOL),
            slippageBps: 500
        });
        const tokenAmount = quote.outAmount / (10 ** decimals);

        const swapRequest = {
            quoteResponse: quote,
            userPublicKey: walletPubKey.toBase58(),
            wrapAndUnwrapSol: true
        };
        const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest, {
            headers: { 'Content-Type': 'application/json' }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);

        portfolio[tokenPubKey.toBase58()] = {
            buyPrice: tradeAmount / tokenAmount,
            amount: tokenAmount,
            lastPrice: tradeAmount / tokenAmount,
            decimals
        };
        tradingCapital -= tradeAmount;
        console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Capital: ${tradingCapital} SOL`);
    } catch (error) {
        console.log(`Error en compra de ${tokenPubKey.toBase58()}: ${error.message}`);
        if (error.response) console.log('Respuesta:', JSON.stringify(error.response.data, null, 2));
    }
}

async function sellToken(tokenPubKey) {
    const tokenMint = tokenPubKey.toBase58();
    const { buyPrice, amount, decimals } = portfolio[tokenMint];
    const realBalance = await getTokenBalance(tokenMint);

    if (realBalance < amount) {
        portfolio[tokenMint].amount = realBalance;
        if (realBalance === 0) {
            delete portfolio[tokenMint];
            console.log(`No hay ${tokenMint} para vender`);
            return 0;
        }
    }

    try {
        const solBalance = await getWalletBalance();
        if (solBalance < FEE_RESERVE) throw new Error('Saldo SOL insuficiente para fees');

        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: Math.floor(portfolio[tokenMint].amount * (10 ** decimals)),
            slippageBps: 500
        });
        const swapRequest = {
            quoteResponse: quote,
            userPublicKey: walletPubKey.toBase58(),
            wrapAndUnwrapSol: true
        };
        const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest, {
            headers: { 'Content-Type': 'application/json' }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(txid);

        const solReceived = quote.outAmount / LAMPORTS_PER_SOL;
        console.log(`Venta: ${txid} | ${solReceived} SOL de ${tokenMint}`);
        lastSoldToken = tokenMint;
        delete portfolio[tokenMint];

        const totalSol = tradingCapital + savedSol;
        if (totalSol < REINVEST_THRESHOLD) {
            tradingCapital += solReceived;
        } else {
            const profit = solReceived - (amount * buyPrice);
            const reinvest = profit * 0.5;
            tradingCapital += reinvest;
            savedSol += (solReceived - reinvest);
            console.log(`Reinversión: ${reinvest} SOL | Guardado: ${savedSol} SOL`);
        }
        return solReceived;
    } catch (error) {
        console.log(`Error vendiendo ${tokenMint}: ${error.message}`);
        if (error.response) console.log('Respuesta:', JSON.stringify(error.response.data, null, 2));
        return 0;
    }
}

async function tradingBot() {
    console.log('Ciclo de trading...');
    const realBalance = await getWalletBalance();
    console.log(`Saldo real: ${realBalance} SOL | Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
    tradingCapital = realBalance;

    if (realBalance < CRITICAL_THRESHOLD && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapital >= MIN_TRADE_AMOUNT + FEE_RESERVE) {
            console.log('Intentando comprar un nuevo token...');
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapital - FEE_RESERVE);
            else console.log('No hay tokens disponibles para comprar');
        } else {
            console.log(`Capital insuficiente para comprar: ${tradingCapital} SOL`);
        }
    }

    for (const token in portfolio) {
        const decimals = portfolio[token].decimals;
        const quote = await jupiterApi.quoteGet({
            inputMint: token,
            outputMint: 'So11111111111111111111111111111111111111112',
            amount: Math.floor(portfolio[token].amount * (10 ** decimals)),
            slippageBps: 500
        });
        const currentPrice = (quote.outAmount / LAMPORTS_PER_SOL) / portfolio[token].amount;
        const { buyPrice, lastPrice } = portfolio[token];
        console.log(`${token}: Actual: ${currentPrice} | Compra: ${buyPrice} | Anterior: ${lastPrice}`);

        const growth = currentPrice / buyPrice;
        const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

        if (growth <= 0.99) {
            console.log(`Stop-loss: ${currentPrice} <= ${buyPrice * 0.99}`);
            await sellToken(new PublicKey(token));
        } else if (growth >= 1.075 && growthVsLast <= 0) {
            console.log(`Take-profit 7.5%: ${growth * 100}% estabilizado`);
            await sellToken(new PublicKey(token));
        } else if (growth > 1.075 && growthVsLast > 0) {
            console.log(`Crecimiento sostenido: ${growth * 100}% | Esperando...`);
            portfolio[token].lastPrice = currentPrice;
        } else {
            portfolio[token].lastPrice = currentPrice;
        }
    }
    console.log('Ciclo completado. Esperando próximo ciclo en 10 minutos...');
}

async function startBot() {
    tradingCapital = await getWalletBalance();
    console.log('Bot iniciado | Capital inicial:', tradingCapital, 'SOL');
    updateVolatileTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();