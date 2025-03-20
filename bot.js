const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.default.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.default ? bs58.default.decode(PRIVATE_KEY) : bs58.decode(PRIVATE_KEY));

const walletPubKey = keypair.publicKey;

const portfolio = {};
let tradingCapital = 0.3; // ~$50 en SOL
let savedSol = 0;
const maxTrades = 2;

async function fetchTopTokens() {
    try {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Espera 5s para evitar bloqueos
        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const pairs = await response.json();
        console.log('Pairs fetched:', pairs.length);
        
        return pairs
            .filter(pair => 
                pair.volume_24h > 500000 && 
                pair.price * pair.liquidity / pair.price > 1000000 && 
                Math.abs(pair.price_change_24h || 0) > 0.15
            )
            .sort((a, b) => Math.abs(b.price_change_24h || 0) - Math.abs(a.price_change_24h || 0))
            .slice(0, maxTrades)
            .map(pair => ({
                token: new PublicKey(pair.base_token),
                price: pair.price
            }));
    } catch (error) {
        console.log('Error obteniendo tokens:', error);
        return [];
    }
}

async function getTokenPrice(tokenPubKey) {
    try {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Espera 3s para evitar spam a la API
        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const pairs = await response.json();
        const pair = pairs.find(p => p.base_token === tokenPubKey.toBase58());
        return pair ? pair.price : 1;
    } catch (error) {
        console.log('Error obteniendo precio:', error);
        return 1;
    }
}

async function buyToken(tokenPubKey) {
    const price = await getTokenPrice(tokenPubKey);
    const amountPerTrade = tradingCapital / maxTrades;
    console.log(`Comprando ${tokenPubKey.toBase58()} a $${price} con ${amountPerTrade} SOL`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amountPerTrade * 1e9),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`Compra exitosa: ${signature}`);
        portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    } catch (error) {
        console.log('Error en la compra:', error);
    }
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;
    console.log(`Vendiendo ${tokenPubKey.toBase58()} a $${currentPrice} (compra: $${buyPrice})`);

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: walletPubKey,
            toPubkey: tokenPubKey,
            lamports: Math.floor(amount * 1e9 * (currentPrice / buyPrice)),
        })
    );

    try {
        const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
        console.log(`Venta exitosa: ${signature}`);
        if (profit > 0) {
            const halfProfit = profit / 2;
            savedSol += halfProfit;
            tradingCapital += halfProfit;
            console.log(`Ganancia: ${profit} SOL | Guardado: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
        } else {
            tradingCapital += profit;
            console.log(`Pérdida: ${profit} SOL | Capital: ${tradingCapital} SOL`);
        }
        delete portfolio[tokenPubKey.toBase58()];
    } catch (error) {
        console.log('Error en la venta:', error);
    }
}

async function tradingBot() {
    console.log('Iniciando ciclo de trading...');
    console.log(`Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);

    if (tradingCapital < 0.01) {
        console.log('Capital insuficiente. Deteniendo bot.');
        return;
    }

    const topTokens = await fetchTopTokens();
    console.log('Tokens seleccionados:', topTokens.length);

    for (const { token } of topTokens) {
        if (!portfolio[token.toBase58()] && Object.keys(portfolio).length < maxTrades) {
            await buyToken(token);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Pausa entre compras
        }
    }

    for (const token in portfolio) {
        const currentPrice = await getTokenPrice(new PublicKey(token));
        const { buyPrice } = portfolio[token];

        if (currentPrice >= buyPrice * 1.30 || currentPrice <= buyPrice * 0.95) {
            await sellToken(new PublicKey(token));
        }
    }

    console.log('Ciclo de trading completado.');
    setTimeout(tradingBot, 600000); // Espera 10 min antes de iniciar otro ciclo
}

function startBot() {
    console.log('Bot iniciando...');
    tradingBot();
}

startBot();
