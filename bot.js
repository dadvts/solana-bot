const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const { getMint, getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, createCloseAccountInstruction } = splToken;
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const axios = require('axios');
const fs = require('fs').promises;
const Bottleneck = require('bottleneck');

// Verify @solana/spl-token version
const splTokenVersion = require('@solana/spl-token/package.json').version;
console.log('Versión de @solana/spl-token:', splTokenVersion);
if (splTokenVersion !== '0.3.8') {
    console.error('Error: Se requiere @solana/spl-token@0.3.8, pero se encontró', splTokenVersion);
    process.exit(1);
}

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
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

// Axios configuration with increased timeout
const axiosInstance = axios.create({
    timeout: 15000, // Increased from default 10s to 15s
    headers: { 'User-Agent': 'solana-bot/1.0' }
});

// Rate limiter for API calls
const limiter = new Bottleneck({ minTime: 200 });
const limitedQuoteGet = limiter.wrap(jupiterApi.quoteGet.bind(jupiterApi));
const limitedAxiosGet = limiter.wrap(async (url) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await axiosInstance.get(url);
        } catch (error) {
            console.log(`Intento ${attempt} fallido en Axios: ${error.message}`);
            if (attempt === 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 1000));
        }
    }
});

let tradingCapitalSol = 0;
let savedSol = 0;
const MIN_TRADE_AMOUNT_SOL = 0.0003;
const FEE_RESERVE_SOL = 0.0003;
const ESTIMATED_FEE_SOL = 0.0001;
const CRITICAL_THRESHOLD_SOL = 0.0002;
const CYCLE_INTERVAL = 3000;
const UPDATE_INTERVAL = 180000;
const MIN_MARKET_CAP = 20000;
const MAX_MARKET_CAP = 2000000;
const MIN_VOLUME = 20000;
const MIN_LIQUIDITY = 2000;
const MAX_AGE_DAYS = 7; // Increased from 1 to 7 days
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
        return tokenDecimalsCache[mintStr];
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const mint = await getMint(connection, new PublicKey(mintStr));
            tokenDecimalsCache[mintStr] = mint.decimals;
            await savePersistentData();
            return mint.decimals;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo decimales de ${mintStr}: ${error.message}`);
            if (attempt === retries) {
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
    try {
        const mintPubKey = new PublicKey(tokenMint);
        const ata = getAssociatedTokenAddressSync(mintPubKey, walletPubKey);
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const account = await getAccount(connection, ata, 'confirmed');
                const amount = BigInt(account.amount);
                const decimals = await getTokenDecimals(tokenMint);
                return Number(amount) / (10 ** decimals);
            } catch (error) {
                if (error.message.includes('TokenAccountNotFoundError') || error.message.includes('Account not found')) {
                    return 0;
                }
                console.log(`Intento ${attempt} fallido: ${error.message}`);
                if (attempt === retries) return 0;
                await new Promise(resolve => setTimeout(resolve, 2 ** attempt * 500));
            }
        }
    } catch (error) {
        console.log(`Error crítico en getTokenBalance para ${tokenMint}: ${error.message}`);
        return 0;
    }
}

async function closeEmptyATA(tokenMint) {
    try {
        const mintPubKey = new PublicKey(tokenMint);
        const ata = getAssociatedTokenAddressSync(mintPubKey, walletPubKey);
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
            try {
                const ata = pubkey.toBase58();
                const tokenAccountInfo = await connection.getAccountInfo(pubkey, 'confirmed');
                if (!tokenAccountInfo) {
                    console.log(`Ignorando ATA ${ata}: sin información de cuenta`);
                    continue;
                }
                const mint = new PublicKey(tokenAccountInfo.data.slice(0, 32)).toBase58();
                if (STABLECOINS.includes(mint)) {
                    console.log(`Ignorando stablecoin: ${mint}`);
                    continue;
                }
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
                    console.log(`Token detectado: ${mint} | Cantidad: ${balance} | Precio: ${price}`);
                } else {
                    console.log(`Ignorando ${mint}: saldo ${balance} menor al umbral de polvo`);
                    await closeEmptyATA(mint);
                }
            } catch (error) {
                console.log(`Error procesando cuenta para ATA ${pubkey.toBase58()}: ${error.message}`);
                continue;
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
            console.log(`Error DexScreener: ${error.message} | Detalles: ${error.response?.data || 'Sin detalles'}`);
            return;
        }

        if (pairs.length === 0) {
            console.log('Error: No se obtuvieron pares de DexScreener');
            return;
        }
        if (pairs.length < 10) {
            console.log('Advertencia: pocos pares obtenidos, pero manteniendo filtros originales...');
        }

        pairsCache = pairs;
        let filterStats = {
            chainId: 0,
            quoteToken: 0,
            baseToken: 0,
            dexId: 0,
            stablecoin: 0,
            blocked: 0,
            fdv: 0,
            volume: 0,
            liquidity: 0,
            age: 0,
            jupiter: 0
        };
        const volatilePairs = [];

        for (const pair of pairs.slice(0, 500)) {
            const tokenMint = pair.baseToken.address;

            // Initial filters
            if (pair.chainId !== 'solana') {
                console.log(`Excluyendo ${tokenMint}: chainId no es Solana`);
                filterStats.chainId++;
                continue;
            }
            if (pair.quoteToken.address !== SOL_MINT) {
                console.log(`Excluyendo ${tokenMint}: quoteToken no es SOL`);
                filterStats.quoteToken++;
                continue;
            }
            if (pair.baseToken.address === SOL_MINT) {
                console.log(`Excluyendo ${tokenMint}: baseToken es SOL`);
                filterStats.baseToken++;
                continue;
            }
            if (pair.dexId !== 'raydium') {
                console.log(`Excluyendo ${tokenMint}: dexId no es Raydium`);
                filterStats.dexId++;
                continue;
            }
            if (STABLECOINS.includes(tokenMint)) {
                console.log(`Excluyendo ${tokenMint}: es stablecoin`);
                filterStats.stablecoin++;
                continue;
            }
            if (blockedTokens.includes(tokenMint)) {
                console.log(`Excluyendo ${tokenMint}: está bloqueado`);
                filterStats.blocked++;
                continue;
            }

            // Parameter filters
            const fdv = pair.fdv || 0;
            const volume24h = pair.volume?.h24 || 0;
            const liquidity = pair.liquidity?.usd || 0;
            const ageDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24) : Infinity;

            if (fdv < MIN_MARKET_CAP || fdv > MAX_MARKET_CAP) {
                console.log(`Excluyendo ${tokenMint}: FDV=${fdv} (requerido ${MIN_MARKET_CAP}-${MAX_MARKET_CAP})`);
                filterStats.fdv++;
                continue;
            }
            if (volume24h < MIN_VOLUME) {
                console.log(`Excluyendo ${tokenMint}: Volumen=${volume24h} (requerido ${MIN_VOLUME})`);
                filterStats.volume++;
                continue;
            }
            if (liquidity < MIN_LIQUIDITY) {
                console.log(`Excluyendo ${tokenMint}: Liquidez=${liquidity} (requerido ${MIN_LIQUIDITY})`);
                filterStats.liquidity++;
                continue;
            }
            if (ageDays > MAX_AGE_DAYS) {
                console.log(`Excluyendo ${tokenMint}: Edad=${ageDays.toFixed(2)} días (requerido <${MAX_AGE_DAYS})`);
                filterStats.age++;
                continue;
            }

            // Relaxed Jupiter validation
            let jupiterValid = true;
            try {
                await limitedQuoteGet({
                    inputMint: SOL_MINT,
                    outputMint: tokenMint,
                    amount: Math.floor(MIN_TRADE_AMOUNT_SOL * LAMPORTS_PER_SOL),
                    slippageBps: 5000
                });
            } catch (error) {
                console.log(`Excluyendo ${tokenMint}: Falló validación de Jupiter: ${error.message}`);
                filterStats.jupiter++;
                jupiterValid = false;
                // Continue instead of skipping to allow tokens without strict Jupiter validation
            }

            volatilePairs.push({
                address: tokenMint,
                ageDays,
                liquidity,
                volume24h,
                jupiterValid
            });
            console.log(`Token viable: ${tokenMint} | Edad: ${ageDays.toFixed(2)} días | Liquidez: ${liquidity} USD | Volumen 24h: ${volume24h} USD | Jupiter: ${jupiterValid}`);
        }

        console.log(`Estadísticas de filtrado:`, {
            'No Solana': filterStats.chainId,
            'Quote no SOL': filterStats.quoteToken,
            'Base es SOL': filterStats.baseToken,
            'No Raydium': filterStats.dexId,
            Stablecoin: filterStats.stablecoin,
            Bloqueado: filterStats.blocked,
            'FDV fuera de rango': filterStats.fdv,
            'Volumen bajo': filterStats.volume,
            'Liquidez baja': filterStats.liquidity,
            'Edad excesiva': filterStats.age,
            'Falló Jupiter': filterStats.jupiter
        });

        volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
        volatileTokens = volatilePairs.slice(0, 10).map(t => t.address);
        console.log('Lista actualizada (mayor volumen):', volatileTokens);
    } catch (error) {
        console.log('Error actualizando tokens:', error.message);
        volatileTokens = [];
    }
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
        if (
            tokenMint === SOL_MINT ||
            soldTokensHistory[tokenMint] ||
            portfolio[tokenMint] ||
            (purchaseHistory[tokenMint]?.count || 0) >= MAX_PURCHASES_PER_TOKEN ||
            blockedTokens.includes(tokenMint) ||
            STABLECOINS.includes(tokenMint) ||
            (await getTokenBalance(tokenMint) > DUST_THRESHOLD)
        ) {
            console.log(`Excluyendo ${tokenMint}: ${tokenMint === SOL_MINT ? 'Es SOL' : soldTokensHistory[tokenMint] ? 'Recientemente vendido' : portfolio[tokenMint] ? 'En portfolio' : (purchaseHistory[tokenMint]?.count || 0) >= MAX_PURCHASES_PER_TOKEN ? 'Máximo de compras' : blockedTokens.includes(tokenMint) ? 'Bloqueado' : STABLECOINS.includes(tokenMint) ? 'Stablecoin' : 'Saldo existente'}`);
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
                blockedTokenTimestamps[tokenMint] = Date.now();
            }
        }
    }
    return bestToken;
}

async function getPriorityFee() {
    try {
        const recentFees = await connection.getRecentPrioritizationFees();
        const avgFee = recentFees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / recentFees.length;
        return Math.ceil(avgFee * 1.2) || 1000;
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
            if (solBalance < MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL + ESTIMATED_FEE_SOL) {
                console.log(`Compra pausada: saldo SOL insuficiente (${solBalance})`);
                return;
            }
            const maxTradeAmount = (solBalance - FEE_RESERVE_SOL - ESTIMATED_FEE_SOL) * 0.3;
            const tradeAmount = Math.min(amountPerTrade, Math.max(maxTradeAmount, MIN_TRADE_AMOUNT_SOL));

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
            }, 'confirmed');
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
                    console.log(`Compra exitosa: ${txid} | ${tokenAmount} ${tokenMint}`);
                    failedAttempts[tokenMint] = 0;
                    if (purchaseHistory[tokenMint].count >= MAX_PURCHASES_PER_TOKEN) {
                        blockedTokens.push(tokenMint);
                        blockedTokenTimestamps[tokenMint] = Date.now();
                    }
                    return;
                }
            }
        } catch (error) {
            console.log(`Intento ${attempt} fallido compra ${tokenMint}: ${error.message}`);
            if (attempt === MAX_TRANSACTION_RETRIES) {
                failedAttempts[tokenMint] = (failedAttempts[tokenMint] || 0) + 1;
                if (failedAttempts[tokenMint] >= MAX_FAILED_ATTEMPTS) {
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
    let sellAmount = (await getTokenBalance(tokenMint)) * portion;

    if (sellAmount < DUST_THRESHOLD * 10) {
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
        delete portfolio[tokenMint];
        purchaseHistory[tokenMint] = { count: 0, buyPrice: 0 };
        blockedTokens.push(tokenMint);
        blockedTokenTimestamps[tokenMint] = Date.now();
        await savePersistentData();
        await closeEmptyATA(tokenMint);
        return 0;
    }

    const solBalance = await getWalletBalanceSol();
    if (solBalance < ESTIMATED_FEE_SOL) return 0;

    const decimals = await getTokenDecimals(tokenMint);
    let attemptPortion = portion;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        try {
            const quote = await limitedQuoteGet({
                inputMint: tokenMint,
                outputMint: SOL_MINT,
                amount: Math.floor(sellAmount * attemptPortion * (10 ** decimals)),
                slippageBps: 5000
            });
            const solReceived = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
            if (solReceived < MIN_TRADE_AMOUNT_SOL) throw new Error(`Salida insuficiente: ${solReceived} SOL`);

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
            }, 'confirmed');
            if (!confirmation.value.err) {
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
            console.log(`Intento ${attempt} fallido vendiendo ${tokenMint}: ${error.message}`);
            portfolio[tokenMint].sellAttempts = (portfolio[tokenMint].sellAttempts || 0) + 1;
            if (attempt === MAX_TRANSACTION_RETRIES || portfolio[tokenMint].sellAttempts >= MAX_FAILED_ATTEMPTS) {
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
            return price;
        } catch (error) {
            console.log(`Intento ${attempt} fallido obteniendo precio de ${tokenMint}: ${error.message}`);
            if (attempt === retries) {
                const pair = pairsCache.find(p => p.baseToken.address === tokenMint);
                if (pair && pair.priceUsd) {
                    return pair.priceUsd / 170; // Assuming $170/SOL
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
        for (const token in portfolio) await sellToken(new PublicKey(token));
        return;
    }

    for (const token in portfolio) {
        const price = await getTokenPrice(token);
        if (price === 0) {
            await sellToken(new PublicKey(token));
        }
    }

    for (const token in portfolio) {
        const currentPrice = await getTokenPrice(token);
        const { buyPrice, lastPrice, initialSold, investedSol, purchaseTime, sellAttempts } = portfolio[token];
        const timeHeld = Date.now() - purchaseTime;

        if (timeHeld > MAX_HOLD_TIME || currentPrice === 0) {
            await sellToken(new PublicKey(token));
        } else if (currentPrice !== null) {
            const growth = currentPrice / buyPrice;
            const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;

            if (growth <= STOP_LOSS_THRESHOLD) {
                await sellToken(new PublicKey(token));
            } else if (!initialSold && growth >= INITIAL_TAKE_PROFIT) {
                const portionToRecover = investedSol > 0 ? Math.min(1, investedSol / (currentPrice * portfolio[token].amount)) : 0.25;
                await sellToken(new PublicKey(token), portionToRecover);
            } else if (initialSold && growth >= 1.5 && growthVsLast > 0) {
                await sellToken(new PublicKey(token), SCALE_SELL_PORTION);
            }
        }
    }

    if (Object.keys(portfolio).length >= MAX_PORTFOLIO_TOKENS) {
        console.log('Portfolio lleno, esperando ventas...');
        return;
    }

    await updateVolatileTokens();
    const bestToken = await selectBestToken();
    if (bestToken && tradingCapitalSol > MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL + ESTIMATED_FEE_SOL) {
        await buyToken(bestToken.token, MIN_TRADE_AMOUNT_SOL);
    } else {
        console.log('No se encontraron tokens viables para comprar');
    }
    console.log('Ciclo de trading completado.');
}

async function main() {
    console.log('Iniciando bot | Versión de Node.js:', process.version);
    await loadPersistentData();
    tradingCapitalSol = await getWalletBalanceSol();
    console.log(`Bot iniciado | Capital inicial: ${tradingCapitalSol} SOL`);
    console.log(`Dirección de la wallet: ${walletPubKey.toBase58()}`);
    blockedTokens = [];
    console.log('Blocked tokens limpiados al inicio');
    await scanWalletForTokens(true);
    await updateVolatileTokens();

    setInterval(tradingBot, CYCLE_INTERVAL);
}

main().catch(error => {
    console.error('Error en main:', error);
    process.exit(1);
});