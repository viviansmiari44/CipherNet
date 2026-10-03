import 'dotenv/config';
import { createPublicClient, http, fallback } from 'viem';
import { mainnet } from 'viem/chains';

const ATTACKER_ROUTER = '0x77EB52E44dB06777bCE478159f25c0d55a295314';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const client = createPublicClient({
    chain: mainnet,
    transport: fallback([
        'https://ethereum.publicnode.com',
        'https://eth.llamarpc.com',
        'https://1rpc.io/eth'
    ].map(url => http(url, { timeout: 15000 })), { rank: false }),
});

async function findLatestAttackerTx() {
    console.log('🔍 Fetching current block...');
    const currentBlock = await client.getBlockNumber();
    console.log(`🔍 Scanning last 100 blocks (~20 mins) for attacker router calls...\n`);

    let foundTx = null;

    // Scan backwards to find the latest tx calling the attacker's router
    for (let b = currentBlock; b >= currentBlock - 100n; b--) {
        try {
            const block = await client.getBlock({ blockNumber: b, includeTransactions: true });
            for (const tx of block.transactions) {
                if (tx.to && tx.to.toLowerCase() === ATTACKER_ROUTER.toLowerCase()) {
                    foundTx = tx;
                    break;
                }
            }
            if (foundTx) break;
        } catch (e) { }
    }

    if (!foundTx) {
        console.log('❌ No router calls found in the last 100 blocks. The attacker might be inactive right now.');
        console.log('👉 Please go to Etherscan for the router (0x77EB52E44dB06777bCE478159f25c0d55a295314) and paste a recent successful TX hash here.');
        return;
    }

    console.log(`✅ Found recent router call: ${foundTx.hash}\n`);
    console.log(`📥 Calldata sent to router (first 10 bytes = function selector):`);
    console.log(`   ${foundTx.input.slice(0, 10)}`);
    console.log(`   Full length: ${foundTx.input.length} characters\n`);

    const receipt = await client.getTransactionReceipt({ hash: foundTx.hash });
    const transferLogs = receipt.logs.filter(l => l.topics[0] === TRANSFER_TOPIC);

    const mirrors = new Set(transferLogs.map(l => l.address));

    console.log(`🎯 NEW MIRROR CONTRACTS EMITTING TRANSFERS:`);
    for (const m of mirrors) console.log(`   - ${m}`);

    console.log('\n💡 ACTION REQUIRED:');
    console.log('1. Copy one of the NEW mirror addresses printed above.');
    console.log('2. Update your router/script to point to this NEW mirror address.');
    console.log('3. Paste the TX Hash and the new mirror address back to me so I can decode the exact function signature for your smart contract!');
}

findLatestAttackerTx().catch(console.error);