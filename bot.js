const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios');

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed'); // Cambiar a Helius si persisten 429
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;
const jupiterApi = createJupiterApiClient({ basePath: 'https://quote-api.jup.ag' });
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLECOINS = [
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // USDC
];

let tradingCapitalSol = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT_SOL = 0.005; // Reducido para permitir trades con bajo capital
const FEE_RESERVE_SOL = 0.0015; // Reducido para liberar capital
const ESTIMATED_FEE_SOL = 0.0001; // Aumentado para reflejar fees reales
const CRITICAL_THRESHOLD_SOL = 0.0001; // Aumentado para proteger capital
const CYCLE_INTERVAL = 5000;
const UPDATE_INTERVAL = 180000;
const MIN_MARKET_CAP = 30000;
const MAX_MARKET_CAP = 2000000;
const MIN_VOLUME = 30000;
const MIN_LIQUIDITY = 15000;
const MAX_AGE_DAYS = 3;
const INITIAL_TAKE_PROFIT = 1.05;
const SCALE_SELL_PORTION = 0.25;
const TARGET_INITIAL_SOL = 0.05;
const STOP_LOSS_THRESHOLD = 0.98;
const MAX_HOLD_TIME = 15 * 60 * 1000;
const DUST_THRESHOLD = 0.001;
const MAX_PURCHASES_PER_TOKEN = 2;
const MAX_FAILED_ATTEMPTS = 2;
const MAX_PORTFOLIO_TOKENS = 3;
const MAX_TRANSACTION_RETRIES = 3;
const BLOCKED_TOKEN_TIMEOUT = 24 * 60 * 60 * 1000; // 24 horas

let portfolio = {};
let volatileTokens = [];
let lastSoldToken = null;
let purchaseHistory = {};
let failedAttempts = {};
let blockedTokens = [];
let tokenDecimalsCache = {};
let blockedTokenTimestamps = {};

async function getTokenDecimals(mintPubKey, retries = 5) {
    const mintStr = mintPubKey.toString();
    if (tokenDecimalsCache[mintStr]) {
        console.log(`Usando decimales en caché para ${mintStr}: ${tokenDecimalsCache[mintStr]}`);
        return tokenDecimalsCache[mintStr];
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const mint = await getMint(connection, new PublicKey(mintPubKey));
            tokenDecimalsCache[mintStr] = mint.decimals;
            return mint.decimals;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo decimales de ${mintStr}: ${error.message}`);
            if (attempt === retries) {
                console.log(`Usando decimales por defecto (6) para ${mintStr}`);
                tokenDecimalsCache[mintStr] = 6;
                return 6;
            }
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000)); // Aumentado a 1000ms
        }
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

async function getTokenBalance(tokenMint, retries = 8) {
    const mintPubKey = new PublicKey(tokenMint);
    const ata = await getAssociatedTokenAddress(mintPubKey, walletPubKey);
    console.log(`Calculada ATA: ${ata.toBase58()} para ${tokenMint}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Intento ${attempt}: Consultando ATA ${ata.toBase58()}`);
            const account = await getAccount(connection, ata, 'confirmed');
            const amount = account.amount;
            console.log(`Datos de cuenta: amount=${amount.toString()}`);
            const decimals = await getTokenDecimals(tokenMint);
            const balance = Number(amount) / (10 ** decimals);
            console.log(`Saldo encontrado: ${balance} para ${tokenMint}`);
            return balance;
        } catch (error) {
            console.log(`Intento ${attempt} fallido: ${error.name} | ${error.message}`);
            if (error.message.includes('TokenAccountNotFoundError') || error.message.includes('Account not found')) {
                console.log(`ATA ${ata.toBase58()} no existe o está vacía`);
                return 0;
            }
            if (attempt === retries) {
                console.log(`No se pudo obtener saldo de ${tokenMint} tras ${retries} intentos`);
                return 0;
            }
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000));
        }
    }
}

async function scanWalletForTokens() {
    console.log('Escaneando wallet para tokens...');
    try {
        const response = await connection.getTokenAccountsByOwner(walletPubKey, { programId: TOKEN_PROGRAM_ID });
        const accounts = response.value || [];
        console.log(`Cuentas encontradas: ${accounts.length}`);
        
        portfolio = {};
        for (const { pubkey } of accounts) {
            const ata = pubkey.toBase58();
            const tokenAccountInfo = await connection.getAccountInfo(pubkey, 'confirmed');
            if (!tokenAccountInfo) continue;
            const mint = new PublicKey(tokenAccountInfo.data.slice(0, 32)).toBase58();
            if (STABLECOINS.includes(mint)) {
                console.log(`Ignorando stablecoin: ${mint}`);
                continue;
            }
            console.log(`Procesando ATA ${ata} para mint ${mint}`);
            const balance = await getTokenBalance(mint);
            if (balance > DUST_THRESHOLD) {
                const decimals = await getTokenDecimals(mint);
                const price = (await getTokenPrice(mint)) || 0.000001;
                portfolio[mint] = {
                    buyPrice: price,
                    amount: balance,
                    lastPrice: price,
                    decimals,
                    initialSold: false,
                    investedSol: balance * price,
                    purchaseTime: Date.now(),
                    sellAttempts: 0
                };
                console.log(`Token detectado: ${mint} | Cantidad: ${balance} | Precio: ${price} | Valor estimado: ${(balance * price * 170).toFixed(2)} USD`);
            } else {
                console.log(`Ignorando ${mint}: saldo ${balance} menor al umbral de polvo o valor nulo`);
            }
        }
    } catch (error) {
        console.log(`Error escaneando wallet: ${error.message}`);
    }
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles...');
    try {
        const response = await axios.get('https://api.dexscreener.com/latest/dex/search?q=raydium');
        const pairs = response.data.pairs || [];
        console.log(`Total de pares obtenidos: ${pairs.length}`);
        
        const volatilePairs = [];
        for (const pair of pairs.slice(0, 500)) { // Aumentado a 500
            if (
                pair.chainId !== 'solana' || 
                pair.quoteToken.address !== SOL_MINT || 
                pair.baseToken.address === SOL_MINT ||
                pair.dexId !== 'raydium' ||
                STABLECOINS.includes(pair.baseToken.address)
            ) continue;

            const fdv = pair.fdv || 0;
            const volume24h = pair.volume?.h24 || 0;
            const liquidity = pair.liquidity?.usd || 0;
            const ageDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24) : Infinity;

            if (
                fdv >= MIN_MARKET_CAP && 
                fdv <= MAX_MARKET_CAP && 
                volume24h >= MIN_VOLUME && 
                liquidity >= MIN_LIQUIDITY && 
                ageDays <= MAX_AGE_DAYS
            ) {
                try {
                    await jupiterApi.quoteGet({
                        inputMint: SOL_MINT,
                        outputMint: pair.baseToken.address,
                        amount: Math.floor(0.001 * LAMPORTS_PER_SOL),
                        slippageBps: 2000
                    });
                    volatilePairs.push({
                        address: pair.baseToken.address,
                        ageDays: ageDays,
                        liquidity
                    });
                    console.log(`Token viable: ${pair.baseToken.address} | Edad: ${ageDays.toFixed(2)} días | Liquidez: ${liquidity} USD`);
                } catch (error) {
                    console.log(`Token ${pair.baseToken.address} no comerciable en Jupiter: ${error.message}`);
                }
            }
        }
        
        volatilePairs.sort((a, b) => a.ageDays - b.ageDays);
        volatileTokens = volatilePairs.slice(0, 10).map(t => t.address);
        console.log('Lista actualizada (más nuevos):', volatileTokens);
    } catch (error) {
        console.log('Error DexScreener:', error.message);
        volatileTokens = [];
    }
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapitalSol - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL;

    // Limpiar blockedTokens vencidos
    const now = Date.now();
    blockedTokens = blockedTokens.filter(token => {
        if (blockedTokenTimestamps[token] && now - blockedTokenTimestamps[token] < BLOCKED_TOKEN_TIMEOUT) {
            return true;
        }
        console.log(`Desbloqueando ${token}: tiempo de bloqueo vencido`);
        delete blockedTokenTimestamps[token];
        return false;
    });

    for (const tokenMint of volatileTokens) {
        if (
            tokenMint === SOL_MINT || 
            tokenMint === lastSoldToken || 
            portfolio[tokenMint] || 
            (purchaseHistory[tokenMint] || 0) >= MAX_PURCHASES_PER_TOKEN ||
            blockedTokens.includes(tokenMint) ||
            STABLECOINS.includes(tokenMint)
        ) {
            console.log(`Excluyendo ${tokenMint}: SOL, vendido, en portfolio, límite de compras (${purchaseHistory[tokenMint] || 0}/${MAX_PURCHASES_PER_TOKEN}), bloqueado, o stablecoin`);
            continue;
        }
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: SOL_MINT,
                outputMint: tokenMint,
                amount: Math.floor(availableCapital * LAMPORTS_PER_SOL),
                slippageBps: 2000
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const returnPerSol = tokenAmount / availableCapital;
            if (returnPerSol > highestReturn) {
                highestReturn = returnPerSol;
                bestToken = { token: new PublicKey(tokenMint), amount: tokenAmount, decimals };
            }
        } catch (error) {
            console.log(`Error evaluando ${tokenMint}: ${error.message}`);
            failedAttempts[tokenMint] = (failedAttempts[tokenMint] || 0) + 1;
            if (failedAttempts[tokenMint] >= MAX_FAILED_ATTEMPTS) {
                console.log(`Bloqueando ${tokenMint} tras ${MAX_FAILED_ATTEMPTS} intentos fallidos`);
                blockedTokens.push(tokenMint);
                blockedTokenTimestamps[tokenMint] = Date.now();
            }
        }
    }
    return bestToken;
}

async function buyToken(tokenPubKey, amountPerTrade) {
    const tokenMint = tokenPubKey.toBase58();
    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        try {
            const solBalance = await getWalletBalanceSol();
            console.log(`Saldo disponible: ${solBalance} SOL`);
            const maxTradeAmount = (solBalance - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL) * 0.3;
            const tradeAmount = Math.min(amountPerTrade, Math.max(maxTradeAmount, MIN_TRADE_AMOUNT_SOL));
            console.log(`Intento ${attempt}: Monto calculado para trading: ${tradeAmount} SOL (reserva: ${FEE_RESERVE_SOL} SOL, fees estimados: ${ESTIMATED_FEE_SOL} SOL)`);
            if (tradeAmount + ESTIMATED_FEE_SOL + FEE_RESERVE_SOL > solBalance) throw new Error(`Saldo total insuficiente: ${solBalance} SOL, se necesitan ${tradeAmount + ESTIMATED_FEE_SOL + FEE_RESERVE_SOL} SOL`);

            const decimals = await getTokenDecimals(tokenPubKey);
            const quote = await jupiterApi.quoteGet({
                inputMint: SOL_MINT,
                outputMint: tokenMint,
                amount: Math.floor(tradeAmount * LAMPORTS_PER_SOL),
                slippageBps: 2000
            });
            const tokenAmount = quote.outAmount / (10 ** decimals);
            const buyPrice = tradeAmount / tokenAmount;

            const recentBlockhash = await connection.getLatestBlockhash('confirmed');
            const swapRequest = {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true,
                recentBlockhash: recentBlockhash.blockhash
            };
            const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest);
            const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
            transaction.sign([keypair]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: recentBlockhash.blockhash,
                lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
            }, 'confirmed', { timeout: 120000 });
            if (!confirmation.value.err) {
                const balance = await getTokenBalance(tokenMint);
                if (balance > DUST_THRESHOLD) {
                    purchaseHistory[tokenMint] = (purchaseHistory[tokenMint] || 0) + 1;
                    portfolio[tokenMint] = {
                        buyPrice: buyPrice,
                        amount: balance,
                        lastPrice: buyPrice,
                        decimals,
                        initialSold: false,
                        investedSol: tradeAmount,
                        purchaseTime: Date.now(),
                        sellAttempts: 0
                    };
                    tradingCapitalSol -= (tradeAmount + ESTIMATED_FEE_SOL);
                    console.log(`Compra exitosa: ${txid} | ${tokenAmount} ${tokenMint} | Compras totales: ${purchaseHistory[tokenMint]}/${MAX_PURCHASES_PER_TOKEN}`);
                    failedAttempts[tokenMint] = 0;
                    return;
                } else {
                    throw new Error(`Compra fallida: saldo insuficiente (${balance}) para ${tokenMint}`);
                }
            } else {
                throw new Error(`Compra fallida: transacción no confirmada para ${tokenMint}`);
            }
        } catch (error) {
            console.log(`Intento ${attempt} fallido compra ${tokenMint}: ${error.message}`);
            if (attempt === MAX_TRANSACTION_RETRIES) {
                console.log(`Compra de ${tokenMint} fallida tras ${MAX_TRANSACTION_RETRIES} intentos`);
                failedAttempts[tokenMint] = (failedAttempts[tokenMint] || 0) + 1;
                if (failedAttempts[tokenMint] >= MAX_FAILED_ATTEMPTS) {
                    console.log(`Bloqueando ${tokenMint} tras ${MAX_FAILED_ATTEMPTS} intentos fallidos`);
                    blockedTokens.push(tokenMint);
                    blockedTokenTimestamps[tokenMint] = Date.now();
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function sellToken(tokenPubKey, portion = 1) {
    const tokenMint = tokenPubKey.toBase58();
    if (!portfolio[tokenMint]) return 0;
    const { buyPrice, amount, decimals } = portfolio[tokenMint];
    const sellAmount = (await getTokenBalance(tokenMint)) * portion;

    if (sellAmount < DUST_THRESHOLD) {
        console.log(`Eliminando ${tokenMint} del portfolio: cantidad (${sellAmount}) menor al umbral de polvo`);
        delete portfolio[tokenMint];
        purchaseHistory[tokenMint] = 0;
        blockedTokens = blockedTokens.filter(t => t !== tokenMint);
        delete blockedTokenTimestamps[tokenMint];
        return 0;
    }

    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        try {
            console.log(`Intento ${attempt}: Vendiendo ${tokenMint} (${portion * 100}%)`);
            const quote = await jupiterApi.quoteGet({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: Math.floor(sellAmount * (10 ** decimals)),
                slippageBps: 2000
            });
            const solReceived = quote.outAmount / LAMPORTS_PER_SOL;

            const recentBlockhash = await connection.getLatestBlockhash('confirmed');
            const swapRequest = {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true,
                recentBlockhash: recentBlockhash.blockhash
            };
            const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest);
            const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
            transaction.sign([keypair]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: recentBlockhash.blockhash,
                lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
            }, 'confirmed', { timeout: 120000 });
            if (!confirmation.value.err) {
                console.log(`Venta exitosa: ${txid} | ${solReceived} SOL de ${tokenMint}`);
                portfolio[tokenMint].amount = await getTokenBalance(tokenMint);
                if (portfolio[tokenMint].amount < DUST_THRESHOLD) {
                    lastSoldToken = tokenMint;
                    delete portfolio[tokenMint];
                    purchaseHistory[tokenMint] = 0;
                    blockedTokens = blockedTokens.filter(t => t !== tokenMint);
                    delete blockedTokenTimestamps[tokenMint];
                } else if (portion < 1) {
                    portfolio[tokenMint].initialSold = true;
                }
                tradingCapitalSol += solReceived;
                portfolio[tokenMint].sellAttempts = 0;
                return solReceived;
            }
        } catch (error) {
            console.log(`Intento ${attempt} fallido vendiendo ${tokenMint}: ${error.message}`);
            portfolio[tokenMint].sellAttempts = (portfolio[tokenMint].sellAttempts || 0) + 1;
            if (attempt === MAX_TRANSACTION_RETRIES || portfolio[tokenMint].sellAttempts >= MAX_FAILED_ATTEMPTS) {
                console.log(`Eliminando ${tokenMint} del portfolio tras ${portfolio[tokenMint].sellAttempts} intentos fallidos de venta`);
                delete portfolio[tokenMint];
                purchaseHistory[tokenMint] = 0;
                blockedTokens.push(tokenMint);
                blockedTokenTimestamps[tokenMint] = Date.now();
                return 0;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return 0;
}

async function getTokenPrice(tokenMint, retries = 7) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await jupiterApi.quoteGet({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: 10 ** decimals,
                slippageBps: 2000
            });
            return quote.outAmount / LAMPORTS_PER_SOL;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo precio de ${tokenMint}: ${error.message}`);
            if (attempt === retries) {
                console.log(`No se pudo obtener precio de ${tokenMint} tras ${retries} intentos, asumiendo precio 0`);
                failedAttempts[tokenMint] = (failedAttempts[tokenMint] || 0) + 1;
                if (failedAttempts[tokenMint] >= MAX_FAILED_ATTEMPTS) {
                    console.log(`Bloqueando ${tokenMint} tras ${MAX_FAILED_ATTEMPTS} intentos fallidos`);
                    blockedTokens.push(tokenMint);
                    blockedTokenTimestamps[tokenMint] = Date.now();
                }
                return 0;
            }
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000));
        }
    }
}

async function syncPortfolio() {
    const existingTokens = Object.keys(portfolio);
    for (const token of existingTokens) {
        const balance = await getTokenBalance(token);
        if (balance < DUST_THRESHOLD) {
            console.log(`Eliminando ${token} del portfolio: saldo ${balance} menor al umbral de polvo`);
            delete portfolio[token];
            purchaseHistory[token] = 0;
            blockedTokens = blockedTokens.filter(t => t !== token);
            delete blockedTokenTimestamps[token];
        } else {
            portfolio[token].amount = balance;
            const price = await getTokenPrice(token);
            portfolio[token].lastPrice = price || portfolio[token].lastPrice;
            if (price === 0 && portfolio[token].sellAttempts >= MAX_FAILED_ATTEMPTS) {
                console.log(`Eliminando ${token} del portfolio: precio no disponible tras ${portfolio[token].sellAttempts} intentos`);
                delete portfolio[token];
                purchaseHistory[token] = 0;
                blockedTokens.push(token);
                blockedTokenTimestamps[token] = Date.now();
            } else {
                console.log(`Portfolio actualizado: ${token} con ${balance} tokens | Precio: ${portfolio[token].lastPrice}`);
            }
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

    for (const token in portfolio) {
        const currentPrice = await getTokenPrice(token);
        const { buyPrice, lastPrice, initialSold, investedSol, purchaseTime, sellAttempts } = portfolio[token];
        const timeHeld = Date.now() - purchaseTime;

        console.log(`${token}: Precio: ${currentPrice} | Tiempo: ${timeHeld / 1000}s | Intentos de venta: ${sellAttempts}`);

        if (timeHeld > MAX_HOLD_TIME || currentPrice === 0) {
            console.log(`Vendiendo ${token}: tiempo máximo alcanzado o precio no disponible`);
            await sellToken(new PublicKey(token));
        } else if (currentPrice !== null) {
            const growth = currentPrice / buyPrice;
            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

            console.log(`${token}: Crecimiento: ${(growth - 1) * 100}%`);

            if (growth <= STOP_LOSS_THRESHOLD) {
                console.log(`Stop-loss activado para ${token}`);
                await sellToken(new PublicKey(token));
            } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
                console.log(`Take-profit inicial para ${token}`);
                const portionToRecover = Math.min(1, investedSol / (currentPrice * portfolio[token].amount));
                await sellToken(new PublicKey(token), portionToRecover);
            } else if (initialSold && growth >= 1.3 && growthVsLast > 0) {
                console.log(`Escalando ganancias para ${token}`);
                await sellToken(new PublicKey(token), SCALE_SELL_PORTION);
            } else if (initialSold && (growthVsLast <= 0 || growth < 1.15)) {
                console.log(`Saliendo de ${token}: crecimiento estabilizado`);
                await sellToken(new PublicKey(token));
            } else {
                portfolio[token].lastPrice = currentPrice;
            }
        }
    }

    const availableCapital = tradingCapitalSol - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL;
    if (Object.keys(portfolio).length < MAX_PORTFOLIO_TOKENS && availableCapital >= MIN_TRADE_AMOUNT_SOL) {
        const bestToken = await selectBestToken();
        if (bestToken && !portfolio[bestToken.token.toBase58()]) {
            console.log(`Comprando token: ${bestToken.token.toBase58()} con ${availableCapital} SOL`);
            await buyToken(bestToken.token, availableCapital);
        } else {
            console.log('No se encontraron tokens viables para comprar');
        }
    } else {
        console.log(`No se puede comprar: Portfolio lleno (${Object.keys(portfolio).length}/${MAX_PORTFOLIO_TOKENS}) o capital insuficiente (${availableCapital} SOL)`);
    }
    console.log('Ciclo completado.');
}

async function startBot() {
    const solBalance = await getWalletBalanceSol();
    tradingCapitalSol = solBalance;
    console.log('Bot iniciado | Capital inicial:', tradingCapitalSol, 'SOL');
    console.log('Dirección de la wallet:', walletPubKey.toBase58());

    await updateVolatileTokens();
    await scanWalletForTokens();
    await tradingBot();
    setInterval(tradingBot, CYCLE_INTERVAL);
    setInterval(updateVolatileTokens, UPDATE_INTERVAL);
}

startBot();