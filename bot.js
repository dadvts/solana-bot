const { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getMint, getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
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
const MIN_TRADE_AMOUNT_SOL = 0.0005;
const FEE_RESERVE_SOL = 0.0015;
const CRITICAL_THRESHOLD_SOL = 0.00005;
const CYCLE_INTERVAL = 30000; // 30s
const UPDATE_INTERVAL = 180000; // 3min
const MIN_MARKET_CAP = 100000; // $100,000
const MAX_MARKET_CAP = 2000000; // $2,000,000
const MIN_VOLUME = 30000; // $30,000 en 24h
const MIN_LIQUIDITY = 15000; // $15,000
const MAX_AGE_DAYS = 30; // Aumentado a 30 días
const INITIAL_TAKE_PROFIT = 1.20; // +20%
const SCALE_SELL_PORTION = 0.25;
const TARGET_INITIAL_SOL = 0.05;
const STOP_LOSS_THRESHOLD = 0.95; // -5%
const MAX_HOLD_TIME = 60 * 60 * 1000; // 1 hora

let portfolio = {};
let volatileTokens = [];
let lastSoldToken = null;
let purchaseHistory = {};

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

async function getTokenBalance(tokenMint, retries = 5) {
    const mintPubKey = new PublicKey(tokenMint);
    const ata = await getAssociatedTokenAddress(mintPubKey, walletPubKey);
    console.log(`Calculada ATA: ${ata.toBase58()} para ${tokenMint}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`Intento ${attempt}: Consultando ATA ${ata.toBase58()}`);
            const account = await getAccount(connection, ata, 'confirmed');
            console.log(`Datos de cuenta: ${JSON.stringify(account)}`);
            if (!account.amount) throw new Error('No se encontró amount en la cuenta');
            const decimals = await getTokenDecimals(tokenMint);
            const balance = Number(account.amount) / (10 ** decimals);
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
            await new Promise(resolve => setTimeout(resolve, 2000));
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
            console.log(`Procesando ATA ${ata} para mint ${mint}`);
            const balance = await getTokenBalance(mint);
            if (balance > 0) {
                const decimals = await getTokenDecimals(mint);
                const price = (await getTokenPrice(mint)) || 0.000001;
                portfolio[mint] = {
                    buyPrice: price,
                    amount: balance,
                    lastPrice: price,
                    decimals,
                    initialSold: false,
                    investedSol: balance * price,
                    purchaseTime: Date.now()
                };
                console.log(`Token detectado: ${mint} | Cantidad: ${balance} | Precio: ${price}`);
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
        
        console.log('Primeros 5 pares:', JSON.stringify(pairs.slice(0, 5).map(p => ({
            address: p.baseToken.address,
            fdv: p.fdv,
            volume24h: p.volume?.h24,
            liquidity: p.liquidity?.usd,
            ageDays: p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / (1000 * 60 * 60 * 24)).toFixed(2) : 'N/A'
        })));

        const volatilePairs = [];
        for (const pair of pairs.slice(0, 200)) {
            if (
                pair.chainId !== 'solana' || 
                pair.quoteToken.address !== SOL_MINT || 
                pair.baseToken.address === SOL_MINT ||
                pair.dexId !== 'raydium'
            ) {
                console.log(`Filtrado inicial: ${pair.baseToken.address} no es SOL-Raydium`);
                continue;
            }

            const fdv = pair.fdv || 0;
            const volume24h = pair.volume?.h24 || 0;
            const liquidity = pair.liquidity?.usd || 0;
            const ageDays = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60 * 24) : Infinity;

            console.log(`Evaluando ${pair.baseToken.address}: FDV=${fdv}, Vol24h=${volume24h}, Liquidez=${liquidity}, Edad=${ageDays.toFixed(2)} días`);

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
                        amount: Math.floor(0.0005 * LAMPORTS_PER_SOL),
                        slippageBps: 1200
                    });
                    volatilePairs.push({
                        address: pair.baseToken.address,
                        volume24h: volume24h
                    });
                    console.log(`Token viable: ${pair.baseToken.address}`);
                } catch (error) {
                    console.log(`Token ${pair.baseToken.address} no comerciable en Jupiter: ${error.message}`);
                }
            } else {
                console.log(`Rechazado: ${pair.baseToken.address} no cumple criterios`);
            }
        }
        
        volatilePairs.sort((a, b) => b.volume24h - a.volume24h);
        volatileTokens = volatilePairs.slice(0, 5).map(t => t.address);
        console.log('Lista actualizada:', volatileTokens);
    } catch (error) {
        console.log('Error DexScreener:', error.message);
        volatileTokens = [];
    }
}

async function selectBestToken() {
    let bestToken = null;
    let highestReturn = 0;
    const availableCapital = tradingCapitalSol - FEE_RESERVE_SOL;

    for (const tokenMint of volatileTokens) {
        if (
            tokenMint === SOL_MINT || 
            tokenMint === lastSoldToken || 
            portfolio[tokenMint] || 
            (purchaseHistory[tokenMint] || 0) >= 2
        ) continue;
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
    const tokenMint = tokenPubKey.toBase58();
    purchaseHistory[tokenMint] = (purchaseHistory[tokenMint] || 0) + 1;
    try {
        const solBalance = await getWalletBalanceSol();
        const tradeAmount = Math.min(amountPerTrade, solBalance - FEE_RESERVE_SOL);
        if (tradeAmount < MIN_TRADE_AMOUNT_SOL) throw new Error(`Monto insuficiente: ${tradeAmount} SOL`);

        const decimals = await getTokenDecimals(tokenPubKey);
        const quote = await jupiterApi.quoteGet({
            inputMint: SOL_MINT,
            outputMint: tokenMint,
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
        const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest);
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        const confirmation = await connection.confirmTransaction(txid, 'confirmed', { timeout: 60000 });
        if (!confirmation.value.err) {
            const balance = await getTokenBalance(tokenMint);
            portfolio[tokenMint] = {
                buyPrice: buyPrice,
                amount: balance,
                lastPrice: buyPrice,
                decimals,
                initialSold: false,
                investedSol: tradeAmount,
                purchaseTime: Date.now()
            };
            tradingCapitalSol -= tradeAmount;
            console.log(`Compra: ${txid} | ${tokenAmount} ${tokenMint}`);
        }
    } catch (error) {
        console.log(`Error compra ${tokenMint}: ${error.message}`);
    }
}

async function sellToken(tokenPubKey, portion = 1) {
    const tokenMint = tokenPubKey.toBase58();
    if (!portfolio[tokenMint]) return 0;
    const { buyPrice, amount, decimals } = portfolio[tokenMint];
    const sellAmount = (await getTokenBalance(tokenMint)) * portion;

    try {
        const quote = await jupiterApi.quoteGet({
            inputMint: tokenMint,
            outputMint: SOL_MINT,
            amount: Math.floor(sellAmount * (10 ** decimals)),
            slippageBps: 1200
        });
        const solReceived = quote.outAmount / LAMPORTS_PER_SOL;

        const swapRequest = {
            quoteResponse: quote,
            userPublicKey: walletPubKey.toBase58(),
            wrapAndUnwrapSol: true
        };
        const response = await axios.post('https://quote-api.jup.ag/v6/swap', swapRequest);
        const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
        transaction.sign([keypair]);
        const txid = await connection.sendRawTransaction(transaction.serialize());
        const confirmation = await connection.confirmTransaction(txid, 'confirmed', { timeout: 60000 });
        if (!confirmation.value.err) {
            console.log(`Venta (${portion * 100}%): ${txid} | ${solReceived} SOL de ${tokenMint}`);
            portfolio[tokenMint].amount = await getTokenBalance(tokenMint);
            if (portfolio[tokenMint].amount === 0) {
                lastSoldToken = tokenMint;
                delete portfolio[tokenMint];
            } else if (portion < 1) {
                portfolio[tokenMint].initialSold = true;
            }
            tradingCapitalSol += solReceived;
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
            console.log(`Eliminando ${token} del portfolio: saldo 0`);
            delete portfolio[token];
        } else {
            portfolio[token].amount = balance;
            portfolio[token].lastPrice = (await getTokenPrice(token)) || portfolio[token].lastPrice;
            console.log(`Portfolio actualizado: ${token} con ${balance} tokens`);
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
        if (currentPrice === null) continue;

        const { buyPrice, lastPrice, initialSold, investedSol, purchaseTime } = portfolio[token];
        const growth = currentPrice / buyPrice;
        const growthVsLast = lastPrice > 0 ? (currentPrice - lastPrice) / lastPrice : Infinity;
        const timeHeld = Date.now() - purchaseTime;

        console.log(`${token}: Precio: ${currentPrice} | Crecimiento: ${(growth - 1) * 100}% | Tiempo: ${timeHeld / 1000}s`);

        if (timeHeld > MAX_HOLD_TIME) {
            console.log(`Tiempo máximo alcanzado para ${token}, vendiendo...`);
            await sellToken(new PublicKey(token));
        } else if (growth <= STOP_LOSS_THRESHOLD) {
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

    if (Object.keys(portfolio).length === 0 && tradingCapitalSol >= MIN_TRADE_AMOUNT_SOL + FEE_RESERVE_SOL) {
        const bestToken = await selectBestToken();
        if (bestToken) await buyToken(bestToken.token, tradingCapitalSol - FEE_RESERVE_SOL);
        else console.log('No se encontraron tokens viables para comprar');
    } else {
        console.log('Capital insuficiente para comprar más');
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
