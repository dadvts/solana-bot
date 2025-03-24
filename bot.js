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
const URKO_MINT = 'AXGmqhcKcPC4bC7vNpxGtu5oEwoEEnyeQUdw9YwYWF1q';

let tradingCapitalUsdt = 0;
let savedUsdt = 0;
const MIN_TRADE_AMOUNT_USDT = 0.1;
const FEE_RESERVE_SOL = 0.01;
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 120000; // 2 min
const UPDATE_INTERVAL = 300000; // 5 min
const MAX_MARKET_CAP = 500000;
const MIN_VOLUME = 500000;
const MIN_VOLUME_TO_MC_RATIO = 2;
const INITIAL_TAKE_PROFIT = 1.5;
const MOONBAG_PORTION = 0.5;
const MAX_PRICE_IMPACT = 0.1;
const TARGET_INITIAL_USDT = 130;

let portfolio = {};
let volatileTokens = [];
let lastSoldToken = null;

async function getTokenDecimals(mintPubKey) {
    try {
        const mint = await getMint(connection, new PublicKey(mintPubKey));
        return mint.decimals;
    } catch (error) {
        console.log(`Error obteniendo decimales de ${mintPubKey}: ${error.message}`);
        return 6;
    }
}

async function getWalletBalanceSol() {
    try {
        const balance = await connection.getBalance(walletPubKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.log(`Error obteniendo saldo SOL: ${error.message}`);
        return 0;
    }
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
        try {
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
            const confirmation = await connection.confirmTransaction(txid, 'confirmed');
            if (!confirmation.value.err) {
                tradingCapitalUsdt -= amountToSwap;
                console.log(`SOL comprado: ${txid} | Nuevo saldo SOL: ${await getWalletBalanceSol()}`);
            } else {
                console.log(`Fallo al comprar SOL: ${txid}`);
            }
        } catch (error) {
            console.log(`Error comprando SOL: ${error.message}`);
        }
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
        const confirmation = await connection.confirmTransaction(txid, 'confirmed');
        if (!confirmation.value.err) {
            portfolio[tokenPubKey.toBase58()] = {
                buyPrice: tradeAmount / tokenAmount,
                amount: tokenAmount,
                lastPrice: tradeAmount / tokenAmount,
                decimals,
                initialSold: false
            };
            tradingCapitalUsdt -= tradeAmount;
            console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Capital: ${tradingCapitalUsdt} USDT`);
        } else {
            console.log(`Fallo al comprar ${tokenPubKey.toBase58()}: ${txid}`);
        }
    } catch (error) {
        console.log(`Error compra ${tokenPubKey.toBase58()}: ${error.message}`);
    }
}

async function sellToken(tokenPubKey, portion = 1) {
    const tokenMint = tokenPubKey.toBase58();
    if (!portfolio[tokenMint]) {
        console.log(`Token ${tokenMint} no está en el portfolio`);
        return 0;
    }
    const { buyPrice, amount, decimals, initialSold } = portfolio[tokenMint];
    const realBalance = await getTokenBalance(tokenMint);

    if (realBalance === 0) {
        delete portfolio[tokenMint];
        console.log(`No hay ${tokenMint} para vender`);
        return 0;
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
        const usdtReceived = quote.outAmount / (10 ** 6);
        if (usdtReceived < 0.01) throw new Error('Venta insignificante, posible error de precio');

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
        const confirmation = await connection.confirmTransaction(txid, 'confirmed');
        
        if (!confirmation.value.err) {
            console.log(`Venta (${portion * 100}%): ${txid} | ${usdtReceived} USDT de ${tokenMint}`);
            portfolio[tokenMint].amount = await getTokenBalance(tokenMint); // Actualiza saldo real
            if (portfolio[tokenMint].amount === 0) {
                lastSoldToken = tokenMint;
                delete portfolio[tokenMint];
            } else if (portion < 1) {
                portfolio[tokenMint].initialSold = true;
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
        } else {
            console.log(`Fallo al vender ${tokenMint}: ${txid}`);
            return 0;
        }
    } catch (error) {
        console.log(`Error vendiendo ${tokenMint}: ${error.message}`);
        return 0;
    }
}

async function getTokenPrice(tokenMint) {
    try {
        const decimals = await getTokenDecimals(tokenMint);
        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: USDT_MINT,
            amount: 10 ** decimals, // 1 unidad del token
            slippageBps: 1200
        });
        const price = quote.outAmount / (10 ** 6); // Precio en USDT por 1 token
        return price;
    } catch (error) {
        console.log(`Error obteniendo precio de ${tokenMint}: ${error.message}`);
        return null;
    }
}

async function syncPortfolio() {
    const urkoBalance = await getTokenBalance(URKO_MINT);
    if (urkoBalance > 0 && !portfolio[URKO_MINT]) {
        const decimals = await getTokenDecimals(URKO_MINT);
        const currentPrice = await getTokenPrice(URKO_MINT) || 0.0001305451557422612; // Fallback al último precio conocido
        portfolio[URKO_MINT] = {
            buyPrice: 0.00012972645498285213,
            amount: urkoBalance,
            lastPrice: currentPrice,
            decimals,
            initialSold: false
        };
        console.log(`URKO sincronizado en portfolio: ${urkoBalance} tokens`);
    }
}

async function tradingBot() {
    console.log('Ciclo de trading...');
    const realBalanceSol = await getWalletBalanceSol();
    const realBalanceUsdt = await getWalletBalanceUsdt();
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${realBalanceUsdt} USDT | Guardado: ${savedUsdt} USDT`);
    tradingCapitalUsdt = realBalanceUsdt;

    await syncPortfolio(); // Sincroniza URKO si está en la wallet

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalUsdt >= MIN_TRADE_AMOUNT_USDT && realBalanceSol >= FEE_RESERVE_SOL) {
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalUsdt);
        } else {
            console.log('Esperando capital suficiente o tokens en portfolio...');
        }
    } else {
        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(token);
            if (currentPrice === null) continue;

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