const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios'); // Nueva dependencia

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const jupiterApi = createJupiterApiClient({ basePath: 'https://quote-api.jup.ag' });
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
let tradingCapital = 0.003949694;
let savedSol = 0;
const MIN_TRADE_AMOUNT = 0.001;
const FEE_RESERVE = 0.0002;
const CRITICAL_THRESHOLD = 0.0005;
const CYCLE_INTERVAL = 600000;
const UPDATE_INTERVAL = 720 * 60000;

let volatileTokens = [
    'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', // ATLAS
    'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB', // GST
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
    '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // STSOL
    'SLNDpmoWTVXwSgMazM3M4Y5e8tFZwPdQXW3xatPDhyN'  // SLND
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

async function getTokenBalance(tokenMint) {
    try {
        const mintPubKey = new PublicKey(tokenMint);
        const ata = await getAssociatedTokenAddress(mintPubKey, walletPubKey);
        const account = await getAccount(connection, ata);
        const decimals = await getTokenDecimals(tokenMint);
        const balance = Number(account.amount) / (10 ** decimals);
        console.log(`Saldo real de ${tokenMint}: ${balance} tokens`);
        return balance;
    } catch (error) {
        console.log(`No se encontró cuenta para ${tokenMint} o error:`, error.message);
        return 0;
    }
}

async function updateVolatileTokens() {
    console.log('Lista de tokens volátiles estática mantenida por ahora...');
    console.log('Lista actual:', volatileTokens);
}

async function getWalletBalance() {
    const balance = await connection.getBalance(walletPubKey);
    return balance / LAMPORTS_PER_SOL;
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
                amount: Math.floor((tradingCapital - FEE_RESERVE) * LAMPORTS_PER_SOL),
                slippageBps: 500
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const pricePerSol = tokenAmount / (tradingCapital - FEE_RESERVE);
            console.log(`Token: ${tokenMint} | Precio por SOL: ${pricePerSol} | Cantidad esperada: ${tokenAmount} | Decimales: ${decimals}`);
            if (pricePerSol > highestPricePerSol) {
                highestPricePerSol = pricePerSol;
                bestToken = { token: new PublicKey(tokenMint), price: tokenAmount, decimals };
            }
        } catch (error) {
            console.log(`Error con ${tokenMint}:`, error.message, error.stack);
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
            amount: Math.floor(amountPerTrade * LAMPORTS_PER_SOL),
            slippageBps: 500
        });
        const tokenAmount = quote.outAmount / (10 ** decimals);
        const swap = await jupiterApi.swapPost({
            swapRequest: {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true,
                destinationWallet: walletPubKey.toBase58()
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
        console.log('Error en compra:', error.message, error.stack);
    }
}

async function sellToken(tokenPubKey, retries = 3) {
    const tokenMint = tokenPubKey.toBase58();
    const { buyPrice, amount, lastPrice, decimals } = portfolio[tokenMint];
    console.log(`Vendiendo ${tokenMint} (${amount} tokens)`);

    const realBalance = await getTokenBalance(tokenMint);
    if (realBalance < amount) {
        console.log(`Saldo real (${realBalance}) menor que el registrado (${amount}). Actualizando...`);
        portfolio[tokenMint].amount = realBalance;
        if (realBalance === 0) {
            console.log('No hay tokens para vender. Eliminando del portafolio.');
            delete portfolio[tokenMint];
            return;
        }
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const solBalance = await getWalletBalance();
            if (solBalance < FEE_RESERVE) {
                console.log('Saldo de SOL insuficiente para cubrir fees. Abortando venta.');
                return;
            }
            console.log('Obteniendo cotización...');
            const quote = await jupiterApi.quoteGet({
                inputMint: tokenMint,
                outputMint: 'So11111111111111111111111111111111111111112',
                amount: Math.floor(portfolio[tokenMint].amount * (10 ** decimals)),
                slippageBps: 500
            });
            console.log('Cotización obtenida:', JSON.stringify(quote, null, 2));

            console.log('Generando transacción de swap manualmente con axios...');
            const swapRequest = {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true,
                destinationWallet: walletPubKey.toBase58()
            };
            console.log('Solicitud enviada a swapPost:', JSON.stringify(swapRequest, null, 2));
            const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log('Respuesta cruda de swapPost:', JSON.stringify(response.data, null, 2));

            console.log('Deserializando y firmando transacción...');
            const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
            transaction.sign([keypair]);
            console.log('Enviando transacción...');
            const txid = await connection.sendRawTransaction(transaction.serialize());
            console.log('Confirmando transacción...');
            await connection.confirmTransaction(txid);
            const solReceived = quote.outAmount / LAMPORTS_PER_SOL;
            const profit = solReceived - (portfolio[tokenMint].amount * buyPrice);
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
            delete portfolio[tokenMint];
            await new Promise(resolve => setTimeout(resolve, 2000));
            return;
        } catch (error) {
            console.log(`Intento ${attempt} fallido. Error en venta:`, error.message);
            console.log('Stack trace:', error.stack);
            if (error.response) {
                console.log('Código de estado HTTP:', error.response.status);
                console.log('Datos de la respuesta:', JSON.stringify(error.response.data, null, 2));
            } else {
                console.log('No hay respuesta HTTP disponible. Error completo:', JSON.stringify(error, null, 2));
            }
            if (attempt < retries) {
                console.log(`Reintentando en 5 segundos...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                console.log('Todos los intentos fallaron. Abortando venta.');
            }
        }
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
                amount: Math.floor(portfolio[token].amount * (10 ** decimals)),
                slippageBps: 500
            });
            const currentPrice = (quote.outAmount / LAMPORTS_PER_SOL) / portfolio[token].amount;
            const { buyPrice, lastPrice } = portfolio[token];
            console.log(`Token: ${token} | Precio actual: ${currentPrice} SOL | Precio compra: ${buyPrice} SOL | Precio anterior: ${lastPrice} SOL`);

            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

            if (currentPrice <= buyPrice * 0.99) {
                console.log(`Stop-loss activado: ${currentPrice} <= ${buyPrice * 0.99}`);
                await sellToken(new PublicKey(token));
            } else if (currentPrice >= buyPrice * 1.05) {
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
        console.error('Error en el ciclo:', error.message, error.stack);
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
