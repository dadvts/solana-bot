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
const MIN_TRADE_AMOUNT_SOL = 0.01; // 0.01 SOL mínimo por trade
const FEE_RESERVE_SOL = 0.01;
const CRITICAL_THRESHOLD_SOL = 0.0001;
const CYCLE_INTERVAL = 30000; // 30 segundos
const UPDATE_INTERVAL = 180000; // 3 min
const MIN_MARKET_CAP = 100000; // 100k USD
const MAX_MARKET_CAP = 500000000; // 500M USD
const MIN_VOLUME = 100000; // 100k USD (24h)
const MIN_LIQUIDITY = 10000; // 10k USD
const INITIAL_TAKE_PROFIT = 1.25; // 25%
const SCALE_SELL_PORTION = 0.25; // 25% por escalón
const TARGET_INITIAL_SOL = 1; // 1 SOL como objetivo inicial
const MAX_AGE_DAYS = 7; // Tokens < 7 días

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
    console.log('Actualizando tokens volátiles (inspirado en https://dexscreener.com/solana?rankBy=trendingScoreH1&order=desc)...');
    try {
        const response = await axios.get('https://public-api.birdeye.so/public/tokenlist?sort_by=v24hUSD&sort_type=desc', {
            headers: { 'X-API-KEY': 'your_birdeye_api_key_if_needed' } // Gratuita por ahora, no requiere key
        });
        const tokens = response.data.data.tokens || [];
        console.log('Respuesta Birdeye:', tokens.length, 'tokens encontrados');

        const volatilePairs = [];
        const maxTokensToProcess = 100;

        for (let i = 0; i < Math.min(tokens.length, maxTokensToProcess); i++) {
            const token = tokens[i];
            if (token.address === SOL_MINT) {
                console.log(`Ignorado: ${token.symbol} (es SOL)`);
                continue;
            }

            const mc = token.mc || 0;
            const volume24h = token.v24hUSD || 0;
            const liquidity = token.liquidity || 0;
            const ageInDays = token.lastTradeUnixTime ? (Date.now() / 1000 - token.lastTradeUnixTime) / (60 * 60 * 24) : 0;

            console.log(`Token ${token.symbol} | MC: ${mc} | Vol: ${volume24h} | Liq: ${liquidity} | Edad: ${ageInDays.toFixed(1)} días`);

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
                        outputMint: token.address,
                        amount: Math.floor(0.1 * LAMPORTS_PER_SOL),
                        slippageBps: 1200
                    });
                    volatilePairs.push({
                        address: token.address,
                        symbol: token.symbol || 'UNKNOWN',
                        liquidity,
                        volume24h
                    });
                    console.log(`Token viable: ${token.symbol} (${token.address})`);
                } catch (error) {
                    console.log(`Rechazado: ${token.symbol} (sin ruta a SOL)`);
                }
            } else {
                console.log(`Rechazado: ${token.symbol} no cumple criterios`);
            }

            if (volatilePairs.length > 5) {
                volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
                volatilePairs.pop();
            }
        }

        volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
        volatileTokens = volatilePairs.map(t => t.address);
        console.log('Lista actualizada:', volatileTokens);

        if (volatileTokens.length === 0) {
            console.log('No se encontraron tokens volátiles viables');
            volatileTokens = [];
        }
    } catch (error) {
        console.log('Error Birdeye:', error.message);
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
    if (bestToken) console.log(`Mejor token: ${bestToken.token.toBase58()}`);
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
    if (!portfolio[tokenMint]) {
        console.log(`Token ${tokenMint} no está en el portfolio`);
        return 0;
    }
    const { buyPrice, amount, decimals, initialSold, investedSol } = portfolio[tokenMint];
    const realBalance = await getTokenBalance(tokenMint);

    if (realBalance === 0) {
        delete portfolio[tokenMint];
        console.log(`No hay ${tokenMint} para vender`);
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
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
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
                console.log(`Reinversión: ${reinvest} SOL | Guardado: ${savedSol} SOL`);
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
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${tradingCapitalSol} SOL | Guardado: ${savedSol} SOL`);
    tradingCapitalSol = realBalanceSol;

    await syncPortfolio();

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Umbral crítico SOL: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    if (Object.keys(portfolio).length === 0) {
        if (tradingCapitalSol >= MIN_TRADE_AMOUNT_SOL) {
            const bestToken = await selectBestToken();
            if (bestToken) await buyToken(bestToken.token, tradingCapitalSol);
            else console.log('No se encontraron tokens viables para comprar');
        } else {
            console.log('Esperando capital suficiente o tokens en portfolio...');
        }
    } else {
        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(token);
            if (currentPrice === null) continue;

            const { buyPrice, lastPrice, initialSold, investedSol } = portfolio[token];
            const growth = currentPrice / buyPrice;
            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;
            const growthPercent = (growth - 1) * 100;

            console.log(`${token}: Actual: ${currentPrice} | Compra: ${buyPrice} | Anterior: ${lastPrice} | Crecimiento: ${growthPercent.toFixed(2)}%`);

            if (growth <= 1) {
                console.log(`Stop-loss: ${currentPrice} <= ${buyPrice}`);
                await sellToken(new PublicKey(token));
            } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
                console.log(`Recuperando capital (${INITIAL_TAKE_PROFIT * 100 - 100}%): ${growthPercent.toFixed(2)}%`);
                const portionToRecover = Math.min(1, investedSol / (currentPrice * portfolio[token].amount));
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
    tradingCapitalSol = solBalance;
    console.log('Bot iniciado | Capital inicial:', tradingCapitalSol, 'SOL');

    await updateVolatileTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();