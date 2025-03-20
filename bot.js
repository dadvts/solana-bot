const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');

console.log('bs58 loaded:', bs58);
console.log('bs58.decode exists:', typeof bs58.default.decode);

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const keypair = Keypair.fromSecretKey(bs58.default.decode(PRIVATE_KEY));
const walletPubKey = keypair.publicKey;

const portfolio = {};
let tradingCapital = 0.3; // Ajusta al saldo real cuando lo tengas
let savedSol = 0;
const maxTrades = 1;
const MIN_TRADE_AMOUNT = 0.01;

async function getTokenPrice(tokenPubKey) {
    // Simulamos obtener el precio de un token con un valor fijo
    console.log(`Simulando obtención de precio para ${tokenPubKey.toBase58()}...`);
    return 1.0; // Precio fijo
}

async function buyToken(tokenPubKey, amountPerTrade) {
    const price = await getTokenPrice(tokenPubKey);
    console.log(`Simulando compra ${tokenPubKey.toBase58()} a $${price} con ${amountPerTrade} SOL`);
    portfolio[tokenPubKey.toBase58()] = { buyPrice: price, amount: amountPerTrade };
    tradingCapital -= amountPerTrade;
}

async function sellToken(tokenPubKey) {
    const currentPrice = await getTokenPrice(tokenPubKey);
    const { buyPrice, amount } = portfolio[tokenPubKey.toBase58()];
    const profit = (currentPrice / buyPrice - 1) * amount;
    console.log(`Simulando venta ${tokenPubKey.toBase58()} a $${currentPrice} (compra: $${buyPrice})`);
    if (profit > 0) {
        const halfProfit = profit / 2;
        savedSol += halfProfit;
        tradingCapital += halfProfit + amount;
        console.log(`📈 Ganancia: ${profit} SOL | Guardado: ${savedSol} SOL | Capital: ${tradingCapital} SOL`);
    } else {
        tradingCapital += profit + amount;
        console.log(`📉 Pérdida: ${profit} SOL | Capital: ${tradingCapital} SOL`);
    }
    delete portfolio[tokenPubKey.toBase58()];
}

async function tradingBot() {
    try {
        console.log('🤖 Iniciando ciclo de trading...');
        console.log(`📊 Capital: ${tradingCapital} SOL | Guardado: ${savedSol} SOL`);
        if (tradingCapital < MIN_TRADE_AMOUNT) {
            console.log('🚫 Capital insuficiente para operar.');
            return;
        }

        // Usamos un token ficticio predefinido
        const topTokens = [{ token: new PublicKey('4p4rJ84u1M7oy9pffas1oUHVQd5Jh7PQt8uHHqv9eHLf'), price: 1 }];
        console.log('Tokens obtenidos:', topTokens.length);

        const amountPerTrade = Math.min(tradingCapital, 0.3) / maxTrades;
        let trades = 0;
        for (const { token } of topTokens) {
            if (trades >= maxTrades || tradingCapital < MIN_TRADE_AMOUNT) break;
            if (!portfolio[token.toBase58()]) {
                await buyToken(token, amountPerTrade);
                trades++;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        for (const token in portfolio) {
            const currentPrice = await getTokenPrice(new PublicKey(token));
            const { buyPrice } = portfolio[token];
            if (currentPrice >= buyPrice * 1.30 || currentPrice <= buyPrice * 0.95) {
                await sellToken(new PublicKey(token));
            }
        }

        console.log('✔️ Ciclo de trading completado.');
    } catch (error) {
        console.error('❌ Error en el ciclo:', error.message);
    }
}

function startBot() {
    console.log('🚀 Bot starting...');
    tradingBot();
    setInterval(() => {
        console.log('🔄 Nuevo ciclo iniciando...');
        tradingBot();
    }, 600000);
}

startBot();

