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
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

let tradingCapitalUsdt = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT_USDT = 0.1;
const FEE_RESERVE_SOL = 0.005;
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 600000;
const UPDATE_INTERVAL = 1800000;
const REINVEST_THRESHOLD_USDT = 100;
const MAX_MARKET_CAP = 1000000;
const RECENT_DAYS = 30;

let portfolio = {
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': {
        buyPrice: 1.74,
        amount: 9.680922,
        lastPrice: 1.7450203606639945,
        decimals: 6
    }
};
let volatileTokens = [];
let lastSoldToken = null;

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

async function getWalletBalanceSol() {
    const balance = await connection.getBalance(walletPubKey);
    return balance / LAMPORTS_PER_SOL;
}

async function getWalletBalanceUsdt() {
    return await getTokenBalance(USDT_MINT);
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    try {
        const dexResponse = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana');
        console.log('Respuesta DexScreener:', dexResponse.data.pairs.length, 'pares encontrados');
        console.log('Pares crudos:', dexResponse.data.pairs.slice(0, 5));
        const recentThreshold = Date.now() - (RECENT_DAYS * 24 * 60 * 60 * 1000);
        const dexTokens = dexResponse.data.pairs
            .filter(pair => pair.chainId === 'solana' && 
                pair.quoteToken.address === USDT_MINT && 
                pair.volume.h24 > 5000 && 
                pair.fdv < MAX_MARKET_CAP && 
                pair.pairCreatedAt > recentThreshold)
            .sort((a, b) => b.volume.h24 - a.volume.h24)
            .map(pair => ({ address: pair.baseToken.address, symbol: pair.baseToken.symbol }));

        console.log('DexTokens filtrados:', dexTokens);

        const volatileWithHype = [];
        for (const token of dexTokens.slice(0, 5)) {
            const xPosts = await searchXPosts(token.symbol);
            if (xPosts.length > 5) {
                volatileWithHype.push(token.address);
            }
        }
        console.log('Tokens con hype:', volatileWithHype);

        volatileTokens = volatileWithHype.length > 0 ? volatileWithHype : dexTokens.map(t => t.address).slice(0, 10);
        if (volatileTokens.length === 0) {
            console.log('No hay tokens viables, usando lista de respaldo manual');
            volatileTokens = ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'];
        }
        console.log('Lista actualizada:', volatileTokens);
    } catch (error) {
        console.log('Error actualizando tokens:', error.message);
        volatileTokens = ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'];
    }
}

async function searchXPosts(symbol) {
    console.log('X_API_TOKEN:', process.env.X_API_TOKEN ? 'Configurado' : 'No configurado');
    try {
        const query = `${symbol} crypto OR token -inurl:(login OR signup)`;
        const posts = await axios.get(`https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50`, {
            headers: { 'Authorization': `Bearer ${process.env.X_API_TOKEN}` }
        });
        console.log(`Posts encontrados para ${symbol}: ${posts.data.data?.length || 0}`);
        return posts.data.data || [];
    } catch (error) {
        console.log(`Error buscando ${symbol} en X: ${error.response?.status || error.message}`);
        return [];
    }
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapitalUsdt;

    for (const tokenMint of volatileTokens) {
        if (tokenMint === USDT_MINT || tokenMint === lastSoldToken) continue;
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: USDT_MINT,
                outputMint: tokenMint,
                amount: Math.floor(availableCapital * (10 ** 6)),
                slippageBps: 500
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const returnPerUsdt = tokenAmount / availableCapital;
            if (returnPerUsdt > highestReturn) {
                highestReturn = returnPerUsdt;
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
        const liquidBalanceUsdt = await getWalletBalanceUsdt();
        const solBalance = await getWalletBalanceSol();
        if (solBalance < FEE_RESERVE_SOL) throw new Error('Saldo SOL insuficiente para fees');
        const tradeAmount = Math.min(amountPerTrade * 0.95, liquidBalanceUsdt);
        if (tradeAmount < MIN_TRADE_AMOUNT_USDT) throw new Error(`Monto insuficiente: ${tradeAmount} USDT`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: USDT_MINT,
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(tradeAmount * (10 ** 6)),
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
        tradingCapitalUsdt -= tradeAmount;
        console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Capital: ${tradingCapitalUsdt} USDT`);
    } catch (error) {
        console.log(`Error en compra de ${tokenPubKey.toBase58()}: ${error.message}`);
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
        const solBalance = await getWalletBalanceSol();
        if (solBalance < FEE_RESERVE_SOL) throw new Error('Saldo SOL insuficiente para fees');

        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: USDT_MINT,
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

        const usdtReceived = quote.outAmount / (10 ** 6);
        console.log(`Venta: ${txid} | ${usdtReceived} USDT de ${tokenMint}`);
        lastSoldToken = tokenMint;
        delete portfolio[tokenMint];

        const totalUsdt = tradingCapitalUsdt + usdtReceived;
        if (totalUsdt < REINVEST_THRESHOLD_USDT) {
            tradingCapitalUsdt += usdtReceived;
        } else {
            const profit = usdtReceived - (amount * buyPrice);
            const reinvest = profit * 0.5;
            tradingCapitalUsdt += reinvest;
            savedSol += (usdtReceived - reinvest) / 130;
            console.log(`Reinversión: ${reinvest} USDT | Guardado: ${savedSol} SOL`);
        }
        return usdtReceived;
    } catch (error) {
        console.log(`Error vendiendo ${tokenMint}: ${error.message}`);
        return 0;
    }
}

async function tradingBot() {
    console.log('Ciclo de trading...');
    const realBalanceSol = await getWalletBalanceSol();
    const realBalanceUsdt = await getWalletBalanceUsdt();
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${realBalanceUsdt} USDT | Guardado: ${savedSol} SOL`);
    tradingCapitalUsdt = realBalanceUsdt;

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalUsdt >= MIN_TRADE_AMOUNT_USDT && realBalanceSol >= FEE_RESERVE_SOL) {
            console.log('Intentando comprar un nuevo token...');
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalUsdt);
            else console.log('No hay tokens disponibles para comprar');
        } else {
            console.log(`Capital insuficiente: ${tradingCapitalUsdt} USDT o SOL: ${realBalanceSol}`);
        }
    }

    for (const token in portfolio) {
        const decimals = portfolio[token].decimals;
        const quote = await jupiterApi.quoteGet({
            inputMint: token,
            outputMint: USDT_MINT,
            amount: Math.floor(portfolio[token].amount * (10 ** decimals)),
            slippageBps: 500
        });
        const currentPrice = (quote.outAmount / (10 ** 6)) / portfolio[token].amount;
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
    const solBalance = await getWalletBalanceSol();
    tradingCapitalUsdt = await getWalletBalanceUsdt();
    console.log('Bot iniciado | Capital inicial:', tradingCapitalUsdt, 'USDT | SOL:', solBalance);
    await updateVolatileTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();