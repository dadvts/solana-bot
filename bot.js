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
const FEE_RESERVE_SOL = 0.01;
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 30000; // 30 segundos
const UPDATE_INTERVAL = 180000; // 3 min
const MIN_MARKET_CAP = 500000; // 0.5M USD
const MAX_MARKET_CAP = 100000000; // 100M USD
const MIN_VOLUME = 500000; // 500k USD (24h)
const MIN_VOLUME_TO_MC_RATIO = 1; // Volumen/MC > 1
const MIN_LIQUIDITY = 10000; // 10k USD
const INITIAL_TAKE_PROFIT = 1.25; // 25%
const SCALE_SELL_PORTION = 0.25; // 25% por escalón
const TARGET_INITIAL_USDT = 180; // ~1 SOL

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
            }
        } catch (error) {
            console.log(`Error comprando SOL: ${error.message}`);
        }
    }
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    try {
        const response = await axios.get('https://api.dexscreener.com/latest/dex/search?q=USDT', {
            headers: { 'Accept': 'application/json' }
        });
        const pairs = response.data.pairs || [];
        console.log('Respuesta DexScreener:', pairs.length, 'pares encontrados');

        const volatilePairs = [];
        const maxPairsToProcess = 100;

        for (let i = 0; i < Math.min(pairs.length, maxPairsToProcess); i++) {
            const pair = pairs[i];
            if (pair.chainId !== 'solana' || pair.quoteToken.address !== USDT_MINT) continue;

            const mc = pair.fdv || 0;
            const volume24h = pair.volume.h24 || 0;
            const liquidity = pair.liquidity.usd || 0;
            const ageInDays = pair.createdAt ? (Date.now() - new Date(pair.createdAt).getTime()) / (1000 * 60 * 60 * 24) : Infinity;

            console.log(`Par ${pair.baseToken.symbol}/USDT | MC: ${mc} | Vol: ${volume24h} | Liq: ${liquidity} | Edad: ${ageInDays.toFixed(1)} días`);

            if (
                mc >= MIN_MARKET_CAP &&
                mc <= MAX_MARKET_CAP &&
                (volume24h >= MIN_VOLUME || (mc > 0 && volume24h / mc >= MIN_VOLUME_TO_MC_RATIO)) &&
                liquidity >= MIN_LIQUIDITY &&
                ageInDays <= 30
            ) {
                volatilePairs.push({
                    address: pair.baseToken.address,
                    symbol: pair.baseToken.symbol || 'UNKNOWN',
                    liquidity
                });
                console.log(`Token viable: ${pair.baseToken.symbol} (${pair.baseToken.address})`);
            } else {
                console.log(`Rechazado: ${pair.baseToken.symbol} no cumple criterios`);
            }

            if (volatilePairs.length > 5) {
                volatilePairs.sort((a, b) => b.liquidity - a.liquidity);
                volatilePairs.pop();
            }
        }

        volatilePairs.sort((a, b) => b.liquidity - a.liquidity);
        volatileTokens = volatilePairs.map(t => t.address);
        console.log('Lista actualizada:', volatileTokens);

        if (volatileTokens.length === 0) {
            console.log('No se encontraron tokens volátiles viables');
            volatileTokens = [];
        }
    } catch (error) {
        console.log('Error DexScreener:', error.message);
        volatileTokens = [];
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
        const tradeAmount = Math.min(amountPerTrade * 0.95, liquidBalanceUsdt);
        if (tradeAmount < MIN_TRADE_AMOUNT_USDT) throw new Error(`Monto insuficiente: ${tradeAmount} USDT`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: USDT_MINT,
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(tradeAmount * (10 ** 6)),
            slippageBps: 1200
        });
        const tokenAmount = quote.outAmount / (10 ** decimals);
        const buyPrice = tradeAmount / tokenAmount;

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
                buyPrice,
                amount: tokenAmount,
                lastPrice: buyPrice,
                decimals,
                initialSold: false,
                investedUsdt: tradeAmount
            };
            tradingCapitalUsdt -= tradeAmount;
            console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Precio: ${buyPrice} USDT | Capital: ${tradingCapitalUsdt} USDT`);
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
    const { buyPrice, amount, decimals, initialSold, investedUsdt } = portfolio[tokenMint];
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

        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: USDT_MINT,
            amount: Math.floor(sellAmount * (10 ** decimals)),
            slippageBps: 1200
        });
        const usdtReceived = quote.outAmount / (10 ** 6);
        if (usdtReceived < 0.01) throw new Error('Venta insignificante');

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
            portfolio[tokenMint].amount = await getTokenBalance(tokenMint);
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
                const reinvest = profit > 0 ? profit * 0.5 : 0;
                tradingCapitalUsdt += reinvest;
                savedUsdt += (usdtReceived - reinvest);
                console.log(`Reinversión: ${reinvest} USDT | Guardado: ${savedUsdt} USDT`);
            }
            return usdtReceived;
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
            amount: 10 ** decimals,
            slippageBps: 1200
        });
        return quote.outAmount / (10 ** 6);
    } catch (error) {
        console.log(`Error obteniendo precio de ${tokenMint}: ${error.message}`);
        return null;
    }
}

async function syncPortfolio() {
    const existingTokens = Object.keys(portfolio);
    for (const token of existingTokens) {
        const balance = await getTokenBalance(token);
        if (balance === 0) {
            delete portfolio[token];
            console.log(`Eliminado ${token} de portfolio (saldo 0)`);
        }
    }
}

async function tradingBot() {
    console.log('Ciclo de trading...');
    const realBalanceSol = await getWalletBalanceSol();
    const realBalanceUsdt = await getWalletBalanceUsdt();
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${realBalanceUsdt} USDT | Guardado: ${savedUsdt} USDT`);
    tradingCapitalUsdt = realBalanceUsdt;

    await syncPortfolio();

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalUsdt >= MIN_TRADE_AMOUNT_USDT && realBalanceSol >= FEE_RESERVE_SOL) {
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalUsdt);
            else console.log('No se encontraron tokens viables para comprar');
        } else {
            console.log('Esperando capital suficiente o tokens en portfolio...');
        }
    } else {
        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(token);
            if (currentPrice === null) continue;

            const { buyPrice, lastPrice, initialSold, investedUsdt } = portfolio[token];
            const growth = currentPrice / buyPrice;
            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;
            const growthPercent = (growth - 1) * 100;

            console.log(`${token}: Actual: ${currentPrice} | Compra: ${buyPrice} | Anterior: ${lastPrice} | Crecimiento: ${growthPercent.toFixed(2)}%`);

            if (growth <= 1) {
                console.log(`Stop-loss: ${currentPrice} <= ${buyPrice}`);
                await sellToken(new PublicKey(token));
            } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
                console.log(`Recuperando capital (${INITIAL_TAKE_PROFIT * 100 - 100}%): ${growthPercent.toFixed(2)}%`);
                const portionToRecover = Math.min(1, investedUsdt / (currentPrice * portfolio[token].amount));
                await sellToken(new PublicKey(token), portionToRecover);
            } else if (initialSold && growth >= 1.5 && growthVsLast > 0) {
                console.log(`Escalando ganancias (x1.5): ${growthPercent.toFixed(2)}%`);
                await sellToken(new PublicKey(token), SCALE_SELL_PORTION);
            } else if (initialSold && (growthVsLast <= 0 || growth < 1.25)) {
                console.log(`Saliendo: ${growthPercent.toFixed(2)}% (estabilizado o < 25%)`);
                await sellToken(new PublicKey(token));
            } else {
                console.log(`Esperando: Crecimiento ${growthPercent.toFixed(2)}%`);
                portfolio[token].lastPrice = currentPrice;
            }
        }
    }
    console.log('Ciclo completado. Esperando próximo ciclo en 30 segundos...');
}

async function startBot() {
    const solBalance = await getWalletBalanceSol();
    tradingCapitalUsdt = await getWalletBalanceUsdt();
    console.log('Bot iniciado | Capital inicial:', tradingCapitalUsdt, 'USDT | SOL:', solBalance);
    if (Math.abs(tradingCapitalUsdt - 19.98) > 0.01 || Math.abs(solBalance - 0.026276) > 0.0001) {
        console.log('¡Advertencia! Saldos iniciales no coinciden con 19.98 USDT y 0.026276 SOL');
    }
    await updateVolatileTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();