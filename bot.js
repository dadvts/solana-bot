const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, createCloseAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios');
const fs = require('fs').promises;
const Bottleneck = require('bottleneck');

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed'); // Cambiar a Helius si persisten 429: 'https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY'
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error('Error: PRIVATE_KEY no está configurada en las variables de entorno');
    process.exit(1);
}
const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;
const jupiterApi = createJupiterApiClient({ basePath: 'https://quote-api.jup.ag' });
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLECOINS = [
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // USDC
];

// Rate limiting para APIs
const limiter = new Bottleneck({ minTime: 200 }); // 5 solicitudes por segundo
const limitedQuoteGet = limiter.wrap(jupiterApi.quoteGet.bind(jupiterApi));
const limitedAxiosGet = limiter.wrap(axios.get.bind(axios));

let tradingCapitalSol = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT_SOL = 0.0005;
const FEE_RESERVE_SOL = 0.0005;
const ESTIMATED_FEE_SOL = 0.0001;
const CRITICAL_THRESHOLD_SOL = 0.0003;
const CYCLE_INTERVAL = 3000;
const UPDATE_INTERVAL = 180000;
const MIN_MARKET_CAP = 20000;
const MAX_MARKET_CAP = 2000000;
const MIN_VOLUME = 20000;
let MIN_LIQUIDITY = 2000;
let MAX_AGE_DAYS = 1;
const INITIAL_TAKE_PROFIT = 1.3;
const SCALE_SELL_PORTION = 0.25;
const TARGET_INITIAL_SOL = 0.05;
const STOP_LOSS_THRESHOLD = 0.98;
const MAX_HOLD_TIME = 15 * 60 * 1000;
const DUST_THRESHOLD = 0.001;
const MAX_PURCHASES_PER_TOKEN = 1;
const MAX_FAILED_ATTEMPTS = 2;
const MAX_PORTFOLIO_TOKENS = 5;
const MAX_TRANSACTION_RETRIES = 5;
const BLOCKED_TOKEN_TIMEOUT = 24 * 60 * 60 * 1000;
const SOLD_TOKEN_TIMEOUT = 24 * 60 * 60 * 1000;

let portfolio = {};
let volatileTokens = [];
let lastSoldToken = null;
let soldTokensHistory = {};
let purchaseHistory = {};
let failedAttempts = {};
let blockedTokens = [];
let tokenDecimalsCache = {};
let blockedTokenTimestamps = {};
let tokenAccountsCache = null;
let lastTokenAccountsUpdate = 0;
let pairsCache = [];

async function loadPersistentData() {
    try {
        const purchaseData = await fs.readFile('purchaseHistory.json', 'utf8');
        purchaseHistory = JSON.parse(purchaseData);
        console.log('Datos de purchaseHistory cargados');
    } catch (error) {
        console.log('No se encontró purchaseHistory.json, inicializando vacío');
    }
    try {
        const decimalsData = await fs.readFile('decimalsCache.json', 'utf8');
        tokenDecimalsCache = JSON.parse(decimalsData);
        console.log('Datos de decimalsCache cargados');
    } catch (error) {
        console.log('No se encontró decimalsCache.json, inicializando vacío');
    }
}

async function savePersistentData() {
    try {
        await fs.writeFile('purchaseHistory.json', JSON.stringify(purchaseHistory, null, 2));
        await fs.writeFile('decimalsCache.json', JSON.stringify(tokenDecimalsCache, null, 2));
        console.log('Datos persistentes guardados');
    } catch (error) {
        console.log(`Error guardando datos persistentes: ${error.message}`);
    }
}

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
            await savePersistentData();
            return mint.decimals;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo decimales de ${mintStr}: ${error.message}`);
            if (attempt === retries) {
                console.log(`Usando decimales por defecto (6) para ${mintStr}`);
                tokenDecimalsCache[mintStr] = 6;
                await savePersistentData();
                return 6;
            }
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000));
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
            const amount = BigInt(account.amount);
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
            if (error.message.includes('429 Too Many Requests')) {
                console.log(`Error 429, reintentando tras ${2 ** attempt * 500}ms`);
                await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 500));
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
}

async function closeEmptyATA(tokenMint) {
    try {
        const mintPubKey = new PublicKey(tokenMint);
        const ata = await getAssociatedTokenAddress(mintPubKey, walletPubKey);
        const balance = await getTokenBalance(tokenMint);
        if (balance === 0) {
            console.log(`Cerrando ATA vacía para ${tokenMint}: ${ata.toBase58()}`);
            const instruction = createCloseAccountInstruction(ata, walletPubKey, walletPubKey);
            const recentBlockhash = await connection.getLatestBlockhash('confirmed');
            const transaction = new VersionedTransaction();
            transaction.add(instruction);
            transaction.recentBlockhash = recentBlockhash.blockhash;
            transaction.sign([keypair]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: recentBlockhash.blockhash,
                lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
            }, 'confirmed');
            if (!confirmation.value.err) {
                console.log(`ATA cerrada exitosamente: ${txid}`);
            }
        }
    } catch (error) {
        console.log(`Error cerrando ATA para ${tokenMint}: ${error.message}`);
    }
}

async function scanWalletForTokens(force = false) {
    console.log('Escaneando wallet para tokens...');
    if (!force && tokenAccountsCache && Date.now() - lastTokenAccountsUpdate < UPDATE_INTERVAL) {
        console.log('Usando caché de cuentas de tokens');
        return;
    }
    try {
        const response = await connection.getTokenAccountsByOwner(walletPubKey, { programId: TOKEN_PROGRAM_ID });
        const accounts = response.value || [];
        console.log(`Cuentas encontradas: ${accounts.length}`);
        
        tokenAccountsCache = accounts;
        lastTokenAccountsUpdate = Date.now();
        
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
                console.log(`Ignorando ${mint}: saldo ${balance} menor al umbral de polvo`);
                await closeEmptyATA(mint);
            }
        }
    } catch (error) {
        console.log(`Error escaneando wallet: ${error.message}`);
    }
}

async function updateVolatileTokens() {
    console.log('Actualizando tokens volátiles desde DexScreener...');
    try {
        let pairs = [];
        try {
            const response = await limitedAxiosGet('https://api.dexscreener.com/latest/dex/search?q=raydium');
            pairs = response.data.pairs || [];
            console.log(`Total de pares obtenidos de DexScreener: ${pairs.length}`);
        } catch (error) {
            console.log(`Error DexScreener: ${error.message}`);
            return;
        }

        if (pairs.length < 10) {
            console.log('Advertencia: pocos pares obtenidos, relajando filtros...');
            MIN_LIQUIDITY = 1000;
            MAX_AGE_DAYS = 2;
        } else {
            MIN_LIQUIDITY = 2000;
            MAX_AGE_DAYS = 1;
        }

        pairsCache = pairs;
        const volatilePairs = [];
        for (const pair of pairs.slice(0, 500)) {
            if (
                pair.chainId !== 'solana' || 
                pair.quoteToken.address !== SOL_MINT || 
                pair.baseToken.address === SOL_MINT ||
                pair.dexId !== 'raydium' ||
                STABLECOINS.includes(pair.baseToken.address) ||
                blockedTokens.includes(pair.baseToken.address)
            ) {
                if (blockedTokens.includes(pair.baseToken.address)) {
                    console.log(`Excluyendo ${pair.baseToken.address}: bloqueado`);
                }
                continue;
            }

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
                    const quote = await limitedQuoteGet({
                        inputMint: SOL_MINT,
                        outputMint: pair.baseToken.address,
                        amount: Math.floor(0.0005 * LAMPORTS_PER_SOL),
                        slippageBps: 5000
                    });
                    volatilePairs.push({
                        address: pair.baseToken.address,
                        ageDays: ageDays,
                        liquidity,
                        volume24h
                    });
                    console.log(`Token viable: ${pair.baseToken.address} | Edad: ${ageDays.toFixed(2)} días | Liquidez: ${liquidity} USD | Volumen 24h: ${volume24h} USD`);
                } catch (error) {
                    console.log(`Token ${pair.baseToken.address} no comerciable en Jupiter: ${error.message}`);
                }
            }
        }
        
        volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
        volatileTokens = volatilePairs.slice(0, 10).map(t => t.address);
        console.log('Lista actualizada (mayor volumen):', volatileTokens);
    } catch (error) {
        console.log('Error actualizando tokens:', error.message);
        volatileTokens = [];
    }
}

async function isLiquidityLocked(tokenMint) {
    // TODO: Implementar chequeo de liquidez bloqueada usando @raydium-io/raydium-sdk
    // Ejemplo: npm install @raydium-io/raydium-sdk
    console.log(`Placeholder: Verificando liquidez bloqueada para ${tokenMint}`);
    return true; // Asumir que está bloqueada por ahora
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapitalSol - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL;
    const now = Date.now();

    blockedTokens = blockedTokens.filter(token => {
        if (blockedTokenTimestamps[token] && now - blockedTokenTimestamps[token] < BLOCKED_TOKEN_TIMEOUT) {
            return true;
        }
        console.log(`Desbloqueando ${token}: tiempo de bloqueo vencido`);
        delete blockedTokenTimestamps[token];
        return false;
    });

    soldTokensHistory = Object.fromEntries(
        Object.entries(soldTokensHistory).filter(([_, timestamp]) => now - timestamp < SOLD_TOKEN_TIMEOUT)
    );

    for (const tokenMint of volatileTokens) {
        const pair = pairsCache.find(p => p.baseToken.address === tokenMint);
        const ageDays = pair?.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24) : Infinity;
        console.log(`Evaluando ${tokenMint}: SOL=${tokenMint === SOL_MINT}, Vendido=${soldTokensHistory[tokenMint]}, Portfolio=${!!portfolio[tokenMint]}, Compras=${purchaseHistory[tokenMint]?.count || 0}/${MAX_PURCHASES_PER_TOKEN}, Bloqueado=${blockedTokens.includes(tokenMint)}, Stablecoin=${STABLECOINS.includes(tokenMint)}, Saldo=${await getTokenBalance(tokenMint)}, Capital=${availableCapital}, Edad=${ageDays.toFixed(2)} días`);
        
        if (
            tokenMint === SOL_MINT || 
            soldTokensHistory[tokenMint] || 
            portfolio[tokenMint] || 
            (purchaseHistory[tokenMint]?.count || 0) >= MAX_PURCHASES_PER_TOKEN ||
            blockedTokens.includes(tokenMint) ||
            STABLECOINS.includes(tokenMint) ||
            (await getTokenBalance(tokenMint) > DUST_THRESHOLD) ||
            ageDays > MAX_AGE_DAYS ||
            !(await isLiquidityLocked(tokenMint))
        ) {
            console.log(`Excluyendo ${tokenMint}: ${tokenMint === SOL_MINT ? 'Es SOL' : soldTokensHistory[tokenMint] ? 'Recientemente vendido' : portfolio[tokenMint] ? 'En portfolio' : (purchaseHistory[tokenMint]?.count || 0) >= MAX_PURCHASES_PER_TOKEN ? 'Máximo de compras alcanzado' : blockedTokens.includes(tokenMint) ? 'Bloqueado' : STABLECOINS.includes(tokenMint) ? 'Stablecoin' : (await getTokenBalance(tokenMint) > DUST_THRESHOLD) ? 'Saldo existente' : ageDays > MAX_AGE_DAYS ? 'Edad superior a 1 día' : 'Liquidez no bloqueada'}`);
            if (ageDays > MAX_AGE_DAYS && !blockedTokens.includes(tokenMint)) {
                console.log(`Bloqueando ${tokenMint}: edad superior a ${MAX_AGE_DAYS} días`);
                blockedTokens.push(tokenMint);
                blockedTokenTimestamps[tokenMint] = now;
            }
            continue;
        }

        const currentPrice = await getTokenPrice(tokenMint);
        if (purchaseHistory[tokenMint] && currentPrice < purchaseHistory[tokenMint].buyPrice) {
            console.log(`Excluyendo ${tokenMint}: precio actual (${currentPrice}) menor que precio de compra (${purchaseHistory[tokenMint].buyPrice})`);
            continue;
        }

        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await limitedQuoteGet({
                inputMint: SOL_MINT,
                outputMint: tokenMint,
                amount: Math.floor(availableCapital * LAMPORTS_PER_SOL),
                slippageBps: 5000
            });
            const tokenAmount = Number(BigInt(quote.outAmount)) / (10 ** decimals);
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
                blockedTokenTimestamps[tokenMint] = now;
            }
        }
    }
    return bestToken;
}

async function getPriorityFee() {
    try {
        const recentFees = await connection.getRecentPrioritizationFees();
        const avgFee = recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length;
        return Math.ceil(avgFee * 1.2) || 1000; // 0.000001 SOL como mínimo
    } catch (error) {
        console.log(`Error obteniendo priority fees: ${error.message}`);
        return 1000;
    }
}

async function buyToken(tokenPubKey, amountPerTrade) {
    const tokenMint = tokenPubKey.toBase58();
    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        try {
            const solBalance = await getWalletBalanceSol();
            console.log(`Saldo disponible: ${solBalance} SOL`);
            if (solBalance < MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL + ESTIMATED_FEE_SOL) {
                console.log(`Compra pausada: saldo SOL insuficiente (${solBalance} < ${MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL + ESTIMATED_FEE_SOL})`);
                return;
            }
            const maxTradeAmount = (solBalance - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL) * 0.3;
            const tradeAmount = Math.min(amountPerTrade, Math.max(maxTradeAmount, MIN_TRADE_AMOUNT_SOL));
            console.log(`Intento ${attempt}: Monto calculado para trading: ${tradeAmount} SOL (reserva: ${FEE_RESERVE_SOL} SOL, fees estimados: ${ESTIMATED_FEE_SOL} SOL)`);
            if (tradeAmount + ESTIMATED_FEE_SOL + FEE_RESERVE_SOL > solBalance) throw new Error(`Saldo total insuficiente: ${solBalance} SOL, se necesitan ${tradeAmount + ESTIMATED_FEE_SOL + FEE_RESERVE_SOL} SOL`);

            const decimals = await getTokenDecimals(tokenPubKey);
            const quote = await limitedQuoteGet({
                inputMint: SOL_MINT,
                outputMint: tokenMint,
                amount: Math.floor(tradeAmount * LAMPORTS_PER_SOL),
                slippageBps: 5000
            });
            const tokenAmount = Number(BigInt(quote.outAmount)) / (10 ** decimals);
            if (tokenAmount < DUST_THRESHOLD) throw new Error(`Cantidad de tokens insuficiente: ${tokenAmount}`);
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
            transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await getPriorityFee() }));
            transaction.sign([keypair]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: recentBlockhash.blockhash,
                lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
            }, 'confirmed', { timeout: 180000 });
            if (!confirmation.value.err) {
                const balance = await getTokenBalance(tokenMint);
                if (balance > DUST_THRESHOLD) {
                    purchaseHistory[tokenMint] = {
                        count: (purchaseHistory[tokenMint]?.count || 0) + 1,
                        buyPrice
                    };
                    await savePersistentData();
                    portfolio[tokenMint] = {
                        buyPrice,
                        amount: balance,
                        lastPrice: buyPrice,
                        decimals,
                        initialSold: false,
                        investedSol: tradeAmount,
                        purchaseTime: Date.now(),
                        sellAttempts: 0
                    };
                    tradingCapitalSol -= (tradeAmount + ESTIMATED_FEE_SOL);
                    console.log(`Compra exitosa: ${txid} | ${tokenAmount} ${tokenMint} | Usando pool de ${quote.routePlan[0]?.swapInfo?.ammLabel || 'desconocido'} | Compras totales: ${purchaseHistory[tokenMint].count}/${MAX_PURCHASES_PER_TOKEN}`);
                    failedAttempts[tokenMint] = 0;
                    if (purchaseHistory[tokenMint].count >= MAX_PURCHASES_PER_TOKEN) {
                        console.log(`Bloqueando ${tokenMint}: máximo de compras alcanzado`);
                        blockedTokens.push(tokenMint);
                        blockedTokenTimestamps[tokenMint] = Date.now();
                    }
                    return;
                } else {
                    throw new Error(`Compra fallida: saldo insuficiente (${balance}) para ${tokenMint}`);
                }
            } else {
                throw new Error(`Compra fallida: transacción no confirmada para ${tokenMint}`);
            }
        } catch (error) {
            console.log(`Intento ${attempt} fallido compra ${tokenMint}: ${error.message} | Detalles: ${error.response?.data || 'Sin detalles'}`);
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
    if (!portfolio[tokenMint]) {
        console.log(`No se puede vender ${tokenMint}: no está en el portfolio`);
        return 0;
    }
    let sellAmount = (await getTokenBalance(tokenMint)) * portion;

    if (sellAmount < DUST_THRESHOLD * 10) {
        console.log(`Ignorando venta de ${tokenMint}: cantidad (${sellAmount}) demasiado baja`);
        delete portfolio[tokenMint];
        purchaseHistory[tokenMint] = { count: 0, buyPrice: 0 };
        blockedTokens.push(tokenMint);
        blockedTokenTimestamps[tokenMint] = Date.now();
        await savePersistentData();
        await closeEmptyATA(tokenMint);
        return 0;
    }

    const pair = pairsCache.find(p => p.baseToken.address === tokenMint);
    if (!pair || pair.liquidity.usd < MIN_LIQUIDITY) {
        console.log(`Ignorando venta de ${tokenMint}: liquidez insuficiente (${pair?.liquidity.usd || 0} USD)`);
        delete portfolio[tokenMint];
        purchaseHistory[tokenMint] = { count: 0, buyPrice: 0 };
        blockedTokens.push(tokenMint);
        blockedTokenTimestamps[tokenMint] = Date.now();
        await savePersistentData();
        await closeEmptyATA(tokenMint);
        return 0;
    }

    const solBalance = await getWalletBalanceSol();
    if (solBalance < ESTIMATED_FEE_SOL) {
        console.log(`No se puede vender ${tokenMint}: saldo SOL insuficiente (${solBalance} < ${ESTIMATED_FEE_SOL})`);
        return 0;
    }

    const decimals = await getTokenDecimals(tokenMint);
    let attemptPortion = portion;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        try {
            console.log(`Intento ${attempt}: Vendiendo ${tokenMint} (${attemptPortion * 100}%) | Cantidad: ${sellAmount * attemptPortion}`);
            const quote = await limitedQuoteGet({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: Math.floor(sellAmount * attemptPortion * (10 ** decimals)),
                slippageBps: 5000
            });
            const solReceived = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
            if (solReceived < MIN_TRADE_AMOUNT_SOL) {
                console.log(`Ignorando venta de ${tokenMint}: salida insuficiente (${solReceived} SOL < ${MIN_TRADE_AMOUNT_SOL} SOL)`);
                throw new Error(`Salida insuficiente: ${solReceived} SOL`);
            }

            const recentBlockhash = await connection.getLatestBlockhash('confirmed');
            const swapRequest = {
                quoteResponse: quote,
                userPublicKey: walletPubKey.toBase58(),
                wrapAndUnwrapSol: true,
                recentBlockhash: recentBlockhash.blockhash
            };
            const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest);
            const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
            transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await getPriorityFee() }));
            transaction.sign([keypair]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            const confirmation = await connection.confirmTransaction({
                signature: txid,
                blockhash: recentBlockhash.blockhash,
                lastValidBlockHeight: recentBlockhash.lastValidBlockHeight
            }, 'confirmed', { timeout: 180000 });
            if (!confirmation.value.err) {
                console.log(`Venta exitosa: ${txid} | ${solReceived} SOL de ${tokenMint} | Usando pool de ${quote.routePlan[0]?.swapInfo?.ammLabel || 'desconocido'}`);
                portfolio[tokenMint].amount = await getTokenBalance(tokenMint);
                if (portfolio[tokenMint].amount < DUST_THRESHOLD) {
                    lastSoldToken = tokenMint;
                    soldTokensHistory[tokenMint] = Date.now();
                    delete portfolio[tokenMint];
                    purchaseHistory[tokenMint] = { count: 0, buyPrice: 0 };
                    blockedTokens.push(tokenMint);
                    blockedTokenTimestamps[tokenMint] = Date.now();
                    await savePersistentData();
                    await closeEmptyATA(tokenMint);
                } else if (attemptPortion < 1) {
                    portfolio[tokenMint].initialSold = true;
                }
                tradingCapitalSol += solReceived;
                portfolio[tokenMint].sellAttempts = 0;
                return solReceived;
            }
        } catch (error) {
            console.log(`Intento ${attempt} fallido vendiendo ${tokenMint}: ${error.message} | Detalles: ${error.response?.data || 'Sin detalles'}`);
            portfolio[tokenMint].sellAttempts = (portfolio[tokenMint].sellAttempts || 0) + 1;
            if (attempt === MAX_TRANSACTION_RETRIES || portfolio[tokenMint].sellAttempts >= MAX_FAILED_ATTEMPTS) {
                console.log(`Eliminando ${tokenMint} del portfolio tras ${portfolio[tokenMint].sellAttempts} intentos fallidos de venta`);
                delete portfolio[tokenMint];
                purchaseHistory[tokenMint] = { count: 0, buyPrice: 0 };
                blockedTokens.push(tokenMint);
                blockedTokenTimestamps[tokenMint] = Date.now();
                await savePersistentData();
                await closeEmptyATA(tokenMint);
                return 0;
            }
            attemptPortion *= 0.5;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return 0;
}

async function getTokenPrice(tokenMint, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const decimals = await getTokenDecimals(tokenMint);
            const quote = await limitedQuoteGet({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: BigInt(10 ** decimals),
                slippageBps: 5000
            });
            const price = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
            if (price * (10 ** decimals) * 170 > 10000000) {
                console.log(`Precio irreal para ${tokenMint}: ${price} SOL, asumiendo 0`);
                return 0;
            }
            return price;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo precio de ${tokenMint}: ${error.message}`);
            if (attempt === retries) {
                try {
                    const pair = pairsCache.find(p => p.baseToken.address === tokenMint);
                    if (pair && pair.priceUsd && pair.fdv < 10000000) {
                        console.log(`Usando precio de DexScreener para ${tokenMint}: ${pair.priceUsd / 170} SOL`);
                        return pair.priceUsd / 170;
                    }
                } catch (dexError) {
                    console.log(`Error DexScreener para ${tokenMint}: ${dexError.message}`);
                }
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
            purchaseHistory[token] = { count: 0, buyPrice: 0 };
            blockedTokens.push(token);
            blockedTokenTimestamps[token] = Date.now();
            await savePersistentData();
            await closeEmptyATA(token);
        } else {
            portfolio[token].amount = balance;
            const price = await getTokenPrice(token);
            portfolio[token].lastPrice = price || portfolio[token].lastPrice;
            if (price === 0 && portfolio[token].sellAttempts >= MAX_FAILED_ATTEMPTS) {
                console.log(`Eliminando ${token} del portfolio: precio no disponible tras ${portfolio[token].sellAttempts} intentos`);
                delete portfolio[token];
                purchaseHistory[token] = { count: 0, buyPrice: 0 };
                blockedTokens.push(token);
                blockedTokenTimestamps[token] = Date.now();
                await savePersistentData();
                await closeEmptyATA(token);
            } else {
                console.log(`Portfolio actualizado: ${token} con ${balance} tokens | Precio: ${portfolio[token].lastPrice}`);
            }
        }
    }
}

async function tradingBot() {
    console.log('Ciclo de trading iniciado...');
    const realBalanceSol = await getWalletBalanceSol();
    console.log(`Saldo real: ${realBalanceSol} SOL | Capital: ${tradingCapitalSol} SOL | Guardado: ${savedSol} SOL`);
    console.log(`Portfolio: ${JSON.stringify(Object.keys(portfolio))}`);
    tradingCapitalSol = realBalanceSol;

    await syncPortfolio();

    if (realBalanceSol < CRITICAL_THRESHOLD_SOL && Object.keys(portfolio).length > 0) {
        console.log('Capital crítico: vendiendo todo...');
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    for (const token in portfolio) {
        const price = await getTokenPrice(token);
        if (price === 0) {
            console.log(`Vendiendo ${token}: precio no disponible`);
            await sellToken(new PublicKey(token));
        }
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
                const portionToRecover = investedSol > 0 ? Math.min(1, investedSol / (currentPrice * portfolio[token].amount)) : 0.25;
                await sellToken(new PublicKey(token), portionToRecover);
            } else if (initialSold && growth >= 1.5 && growthVsLast > 0) {
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
    if (Object.keys(portfolio).length >= MAX_PORTFOLIO_TOKENS) {
        console.log(`No se puede comprar: Portfolio lleno (${Object.keys(portfolio).length}/${MAX_PORTFOLIO_TOKENS})`);
    } else if (availableCapital < MIN_TRADE_AMOUNT_SOL) {
        console.log(`No se puede comprar: Capital insuficiente (${availableCapital} SOL < ${MIN_TRADE_AMOUNT_SOL} SOL)`);
    } else {
        const bestToken = await selectBestToken();
        if (bestToken && !portfolio[bestToken.token.toBase58()]) {
            console.log(`Comprando token: ${bestToken.token.toBase58()} con ${availableCapital} SOL`);
            await buyToken(bestToken.token, availableCapital);
        } else {
            console.log('No se encontraron tokens viables para comprar');
        }
    }
    console.log('Ciclo de trading completado.');
}

async function startBot() {
    console.log(`Iniciando bot | Versión de Node.js: ${process.version}`);
    try {
        await loadPersistentData();
        const solBalance = await getWalletBalanceSol();
        tradingCapitalSol = solBalance;
        console.log('Bot iniciado | Capital inicial:', tradingCapitalSol, 'SOL');
        console.log('Dirección de la wallet:', walletPubKey.toBase58());

        blockedTokens = [];
        blockedTokenTimestamps = {};
        console.log('Blocked tokens limpiados al inicio');

        await updateVolatileTokens();
        await scanWalletForTokens(true);
        await tradingBot();
        setInterval(tradingBot, CYCLE_INTERVAL);
        setInterval(updateVolatileTokens, UPDATE_INTERVAL);
    } catch (error) {
        console.error(`Error crítico iniciando bot: ${error.message}`);
        console.error(error.stack);
        setTimeout(startBot, 30000);
    }
}

startBot();