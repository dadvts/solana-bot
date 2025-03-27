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
const SOL_MINT = 'So11111111111111111111111111111111111111112';

let tradingCapitalSol = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT_SOL = 0.01;
const FEE_RESERVE_SOL = 0.001; // Reducido para operaciones recurrentes
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 30000;
const UPDATE_INTERVAL = 180000;
const MIN_MARKET_CAP = 100000;
const MAX_MARKET_CAP = 500000000;
const MIN_VOLUME = 25000;
const MIN_LIQUIDITY = 5000;
const INITIAL_TAKE_PROFIT = 1.25;
const SCALE_SELL_PORTION = 0.25;
const TARGET_INITIAL_SOL = 1;
const MAX_AGE_DAYS = 7;

let portfolio = {};
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
    try {
        const balance = await connection.getBalance(walletPubKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.log(`Error obteniendo saldo SOL: ${error.message}`);
        return 0;
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

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    try {
        const response = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium', {
            headers: { 'Accept': 'application/json' }
        });
        const pairs = response.data.pairs || [];
        console.log('Respuesta DexScreener:', pairs.length, 'pares encontrados');

        const volatilePairs = [];
        const maxPairsToProcess = 100;

        for (let i = 0; i < Math.min(pairs.length, maxPairsToProcess); i++) {
            const pair = pairs[i];
            if (
                pair.chainId !== 'solana' || 
                pair.quoteToken.address !== SOL_MINT || 
                pair.baseToken.address === SOL_MINT
            ) {
                continue;
            }

            const mc = pair.fdv || 0;
            const volume24h = pair.volume.h24 || 0;
            const liquidity = pair.liquidity.usd || 0;
            const ageInDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24) : 0;

            if (
                mc >= MIN_MARKET_CAP &&
                mc <= MAX_MARKET_CAP &&
                volume24h >= MIN_VOLUME &&
                liquidity >= MIN_LIQUIDITY &&
                ageInDays <= MAX_AGE_DAYS
            ) {
                try {
                    await jupiterApi.quoteGet({
                        inputMint: SOL_MINT,
                        outputMint: pair.baseToken.address,
                        amount: Math.floor(0.1 * LAMPORTS_PER_SOL),
                        slippageBps: 1200
                    });
                    volatilePairs.push({
                        address: pair.baseToken.address,
                        symbol: pair.baseToken.symbol || 'UNKNOWN',
                        liquidity,
                        volume24h
                    });
                } catch (error) {}
            }
        }

        volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
        volatileTokens = volatilePairs.slice(0, 5).map(t => t.address);
        console.log('Lista actualizada:', volatileTokens);
        if (volatileTokens.length === 0) console.log('No se encontraron tokens viables');
    } catch (error) {
        console.log('Error DexScreener:', error.message);
        volatileTokens = [];
    }
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapitalSol;

    for (const tokenMint of volatileTokens) {
        if (tokenMint === SOL_MINT || tokenMint === lastSoldToken) continue;
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: SOL_MINT,
                outputMint: tokenMint,
                amount: Math.floor(availableCapital * LAMPORTS_PER_SOL),
                slippageBps: 1200
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
    return bestToken;
}

async function buyToken(tokenPubKey, amountPerTrade) {
    try {
        const solBalance = await getWalletBalanceSol();
        const tradeAmount = Math.min(amountPerTrade * 0.95, solBalance - FEE_RESERVE_SOL);
        if (tradeAmount < MIN_TRADE_AMOUNT_SOL) throw new Error(`Monto insuficiente: ${tradeAmount} SOL`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: SOL_MINT,
            outputMint: tokenPubKey.toBase58(),
            amount: Math.floor(tradeAmount * LAMPORTS_PER_SOL),
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
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64')); // Corregido a base64
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
                investedSol: tradeAmount
            };
            tradingCapitalSol -= tradeAmount;
            console.log(`Compra: ${txid} | ${tokenAmount} ${tokenPubKey.toBase58()} | Precio: ${buyPrice} SOL | Capital: ${tradingCapitalSol} SOL`);
        }
    } catch (error) {
        console.log(`Error compra ${tokenPubKey.toBase58()}: ${error.message}`);
    }
}

async function sellToken(tokenPubKey, portion = 1) {
    const tokenMint = tokenPubKey.toBase58();
    if (!portfolio[tokenMint]) return 0;
    const { buyPrice, amount, decimals, initialSold, investedSol } = portfolio[tokenMint];
    const realBalance = await getTokenBalance(tokenMint);

    if (realBalance === 0) {
        delete portfolio[tokenMint];
        return 0;
    }

    const sellAmount = realBalance * portion;
    try {
        const solBalance = await getWalletBalanceSol();
        if (solBalance < FEE_RESERVE_SOL) throw new Error('Insuficiente SOL para fees');

        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: Math.floor(sellAmount * (10 ** decimals)),
            slippageBps: 1200
        });
        const solReceived = quote.outAmount / LAMPORTS_PER_SOL;
        if (solReceived < 0.001) throw new Error('Venta insignificante');

        const swapRequest = {
            quoteResponse: quote,
            userPublicKey: walletPubKey.toBase58(),
            wrapAndUnwrapSol: true
        };
        const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest, {
            headers: { 'Content-Type': 'application/json' }
        });
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64')); // Corregido a base64
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        const confirmation = await connection.confirmTransaction(txid, 'confirmed');
        
        if (!confirmation.value.err) {
            console.log(`Venta (${portion * 100}%): ${txid} | ${solReceived} SOL de ${tokenMint}`);
            portfolio[tokenMint].amount = await getTokenBalance(tokenMint);
            if (portfolio[tokenMint].amount === 0) {
                lastSoldToken = tokenMint;
                delete portfolio[tokenMint];
            } else if (portion < 1) {
                portfolio[tokenMint].initialSold = true;
            }

            if (tradingCapitalSol + savedSol < TARGET_INITIAL_SOL) {
                tradingCapitalSol += solReceived;
            } else {
                const profit = solReceived - (sellAmount * buyPrice);
                const reinvest = profit > 0 ? profit * 0.5 : 0;
                tradingCapitalSol += reinvest;
                savedSol += (solReceived - reinvest);
            }
            return solReceived;
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
            outputMint: SOL_MINT,
            amount: 10 ** decimals,
            slippageBps: 1200
        });
        return quote.outAmount / LAMPORTS_PER_SOL;
    } catch (error) {
        return null;
    }
}

async function syncPortfolio() {
    const existingTokens = Object.keys(portfolio);
    for (const token of existingTokens) {
        const balance = await getTokenBalance(token);
        if (balance === 0) delete portfolio[token];
    }
}

async function tradingBot() {
    console.log('Ciclo de trading...');
    const realBalanceSol = await getWalletBalanceSol();
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${tradingCapitalSol} SOL | Guardado: ${savedSol} SOL`);
    tradingCapitalSol = realBalanceSol;

    await syncPortfolio();

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalSol >= MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL) {
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalSol - FEE_RESERVE_SOL);
            else console.log('No se encontraron tokens viables para comprar');
        } else {
            console.log('Capital insuficiente para comprar más');
        }
    } else {
        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(token);
            if (currentPrice === null) continue;

            const { buyPrice, lastPrice, initialSold, investedSol } = portfolio[token];
            const growth = currentPrice / buyPrice;
            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;
            const growthPercent = (growth - 1) * 100;

            console.log(`${token}: Precio actual: ${currentPrice} SOL | Compra: ${buyPrice} SOL | Crecimiento: ${growthPercent.toFixed(2)}%`);

            if (growth <= 1) {
                console.log(`Stop-loss activado para ${token}`);
                await sellToken(new PublicKey(token));
            } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
                console.log(`Take-profit inicial (${INITIAL_TAKE_PROFIT * 100 - 100}%) para ${token}`);
                const portionToRecover = Math.min(1, investedSol / (currentPrice * portfolio[token].amount));
                await sellToken(new PublicKey(token), portionToRecover);
            } else if (initialSold && growth >= 1.5 && growthVsLast > 0) {
                console.log(`Escalando ganancias (x1.5) para ${token}`);
                await sellToken(new PublicKey(token), SCALE_SELL_PORTION);
            } else if (initialSold && (growthVsLast <= 0 || growth < 1.25)) {
                console.log(`Saliendo de ${token}: crecimiento estabilizado o < 25%`);
                await sellToken(new PublicKey(token));
            } else {
                portfolio[token].lastPrice = currentPrice;
            }
        }
    }
    console.log('Ciclo completado.');
}

async function startBot() {
    const solBalance = await getWalletBalanceSol();
    tradingCapitalSol = solBalance;
    console.log('Bot iniciado | Capital inicial:', tradingCapitalSol, 'SOL');

    // Inicializar portfolio con BabyGhibli
    const babyGhibliBalance = await getTokenBalance('Edw39XhQLw1GqcLBhibYf99W6w78WQMA4yZBbJzXvnJQ');
    if (babyGhibliBalance > 0) {
        portfolio['Edw39XhQLw1GqcLBhibYf99W6w78WQMA4yZBbJzXvnJQ'] = {
            buyPrice: 0.000002323,
            amount: babyGhibliBalance,
            lastPrice: 0.000002323,
            decimals: 6,
            initialSold: false,
            investedSol: 0.158
        };
        console.log(`Portfolio inicializado con ${babyGhibliBalance} BabyGhibli`);
    }

    await updateVolatileTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();