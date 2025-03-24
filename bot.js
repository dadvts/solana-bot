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
const SOL_MINT = 'So11111111111111111111111111111111111111112';

let tradingCapitalUsdt = 0;
let savedUsdt = 0;
const MIN_TRADE_AMOUNT_USDT = 0.1;
const FEE_RESERVE_SOL = 0.01; // Mínimo 0.01 SOL
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 120000; // 2 min
const UPDATE_INTERVAL = 300000; // 5 min
const MAX_MARKET_CAP = 500000; // 500k$
const MIN_VOLUME = 500000; // 500k$
const MIN_VOLUME_TO_MC_RATIO = 2;
const INITIAL_TAKE_PROFIT = 1.5; // 50%
const MOONBAG_PORTION = 0.5;
const MAX_PRICE_IMPACT = 0.1; // 10%
const TARGET_INITIAL_USDT = 130; // 1 SOL equivalente

let portfolio = {
    'AXGmqhcKcPC4bC7vNpxGtu5oEwoEEnyeQUdw9YwYWF1q': {
        buyPrice: 0.00012972645498285213,
        amount: 123969.22,
        lastPrice: 0.0001305451557422612,
        decimals: 6,
        initialSold: false
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

async function getWalletBalanceSol() {
    const balance = await connection.getBalance(walletPubKey);
    return balance / LAMPORTS_PER_SOL;
}

async function getWalletBalanceUsdt() {
    return await getTokenBalance(USDT_MINT);
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

async function ensureSolForFees() {
    const solBalance = await getWalletBalanceSol();
    if (solBalance < FEE_RESERVE_SOL && tradingCapitalUsdt > 5) {
        console.log('Comprando SOL para fees...');
        const amountToSwap = 5;
        const quote = await jupiterApi.quoteGet({
            inputMint: USDT_MINT,
            outputMint: SOL_MINT,
            amount: Math.floor(amountToSwap * (10 ** 6)),
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
        tradingCapitalUsdt -= amountToSwap;
        console.log(`SOL comprado: ${txid} | Nuevo saldo SOL: ${await getWalletBalanceSol()}`);
    }
}

async function fetchPumpFunTokens() {
    try {
        const response = await axios.get('https://frontend-api.pump.fun/mints?sort=market_cap&order=DESC&offset=0&limit=50');
        const tokens = response.data
            .filter(token => token.market_cap_usd < 60000 && token.volume_24h > 5000)
            .map(token => ({ address: token.mint, symbol: token.symbol }));
        console.log('Pump.fun tokens filtrados:', tokens);
        return tokens.map(t => t.address);
    } catch (error) {
        console.log('Error fetching Pump.fun tokens:', error.message);
        return [];
    }
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    const pumpFunTokens = await fetchPumpFunTokens();
    try {
        const dexResponse = await axios.get('https://api.dexscreener.com/latest/dex/tokens/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
        console.log('Respuesta DexScreener:', dexResponse.data.pairs.length, 'pares encontrados');
        const dexTokens = dexResponse.data.pairs
            .filter(pair => pair.chainId === 'solana' && 
                pair.quoteToken.address === USDT_MINT && 
                pair.volume.h1 > MIN_VOLUME && 
                pair.fdv < MAX_MARKET_CAP && 
                (pair.volume.h1 / pair.fdv) > MIN_VOLUME_TO_MC_RATIO)
            .sort((a, b) => (b.volume.h1 / b.fdv) - (a.volume.h1 / a.fdv))
            .map(pair => ({ address: pair.baseToken.address, symbol: pair.baseToken.symbol, liquidity: pair.liquidity.usd }));

        console.log('DexScreener tokens filtrados:', dexTokens);
        volatileTokens = [...pumpFunTokens, ...dexTokens.map(t => t.address)].slice(0, 10);
        if (volatileTokens.length === 0) volatileTokens = ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'];
        console.log('Lista actualizada:', volatileTokens);
    } catch (error) {
        console.log('Error DexScreener:', error.message);
        volatileTokens = pumpFunTokens.length > 0 ? pumpFunTokens : ['4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'];
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
                slippageBps: 1200
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
    if (bestToken) console.log(`Mejor token: ${bestToken.token.toBase58()}`);
    return bestToken;
}

async function buyToken(tokenPubKey, amountPerTrade) {
    try {
        const liquidBalanceUsdt = await getWalletBalanceUsdt();
        const solBalance = await getWalletBalanceSol();
        if (solBalance < FEE_RESERVE_SOL) await ensureSolForFees();
        const dexPair = (await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenPubKey.toBase58()}`)).data.pairs[0];
        const liquidityUsd = dexPair?.liquidity?.usd || 10000;
        const tradeAmount = Math.min(amountPerTrade * 0.95, liquidBalanceUsdt, liquidityUsd * MAX_PRICE_IMPACT);
        if (tradeAmount < MIN_TRADE_AMOUNT_USDT) throw new Error(`Monto insuficiente: ${tradeAmount} USDT`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const slippageBps = liquidityUsd < 100000 ? 1500 : 1200;
        const quote = await jupiterApi.quoteGet({
            inputMint: USDT_MINT,
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(tradeAmount * (10 ** 6)),
            slippageBps
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
            decimals,
            initialSold: false
        };
        tradingCapitalUsdt -= tradeAmount;
        console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Capital: ${tradingCapitalUsdt} USDT`);
    } catch (error) {
        console.log(`Error compra ${tokenPubKey.toBase58()}: ${error.message}`);
    }
}

async function sellToken(tokenPubKey, portion = 1) {
    const tokenMint = tokenPubKey.toBase58();
    const { buyPrice, amount, decimals, initialSold } = portfolio[tokenMint];
    const realBalance = await getTokenBalance(tokenMint);

    if (realBalance < amount) {
        portfolio[tokenMint].amount = realBalance;
        if (realBalance === 0) {
            delete portfolio[tokenMint];
            console.log(`No hay ${tokenMint} para vender`);
            return 0;
        }
    }

    const sellAmount = realBalance * portion;
    try {
        const solBalance = await getWalletBalanceSol();
        if (solBalance < FEE_RESERVE_SOL) await ensureSolForFees();

        const dexPair = (await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`)).data.pairs[0];
        const liquidityUsd = dexPair?.liquidity?.usd || 10000;
        const slippageBps = portion < 1 ? 2000 : 1200;

        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: USDT_MINT,
            amount: Math.floor(sellAmount * (10 ** decimals)),
            slippageBps
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
        console.log(`Venta (${portion * 100}%): ${txid} | ${usdtReceived} USDT de ${tokenMint}`);

        if (portion < 1) {
            portfolio[tokenMint].amount -= sellAmount;
            portfolio[tokenMint].initialSold = true;
        } else {
            lastSoldToken = tokenMint;
            delete portfolio[tokenMint];
        }

        if (tradingCapitalUsdt + savedUsdt < TARGET_INITIAL_USDT) {
            tradingCapitalUsdt += usdtReceived;
        } else {
            const profit = usdtReceived - (sellAmount * buyPrice);
            const reinvest = profit * 0.5;
            tradingCapitalUsdt = Math.max(TARGET_INITIAL_USDT, tradingCapitalUsdt + reinvest);
            savedUsdt += (usdtReceived - reinvest);
            console.log(`Reinversión: ${reinvest} USDT | Guardado: ${savedUsdt} USDT`);
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
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${realBalanceUsdt} USDT | Guardado: ${savedUsdt} USDT`);
    tradingCapitalUsdt = realBalanceUsdt;

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalUsdt >= MIN_TRADE_AMOUNT_USDT && realBalanceSol >= FEE_RESERVE_SOL) {
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalUsdt);
        }
    }

    for (const token in portfolio) {
        const decimals = portfolio[token].decimals;
        const quote = await jupiterApi.quoteGet({
            inputMint: token,
            outputMint: USDT_MINT,
            amount: Math.floor(portfolio[token].amount * (10 ** decimals)),
            slippageBps: 1200
        });
        const currentPrice = (quote.outAmount / (10 ** 6)) / portfolio[token].amount;
        const { buyPrice, lastPrice, initialSold } = portfolio[token];
        console.log(`${token}: Actual: ${currentPrice} | Compra: ${buyPrice} | Anterior: ${lastPrice}`);

        const growth = currentPrice / buyPrice;
        const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

        if (currentPrice <= buyPrice) {
            console.log(`Stop-loss: ${currentPrice} <= ${buyPrice}`);
            await sellToken(new PublicKey(token));
        } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
            console.log(`Take-profit inicial ${INITIAL_TAKE_PROFIT * 100 - 100}%: ${growth * 100}%`);
            await sellToken(new PublicKey(token), 1 - MOONBAG_PORTION);
        } else if (initialSold && (growthVsLast <= 0 || growth < 1.4)) {
            console.log(`Moonbag venta: ${growth * 100}% (estabilizado o < 40%)`);
            await sellToken(new PublicKey(token));
        } else {
            portfolio[token].lastPrice = currentPrice;
        }
    }
    console.log('Ciclo completado. Esperando próximo ciclo en 2 minutos...');
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