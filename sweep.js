import { ethers } from 'ethers';

// ─── CONFIGURATION ───────────────────────────────────────────────

// Public RPC URL for BNB Smart Chain (BSC)
const RPC_URL = 'https://bsc-dataseed.binance.org/';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Target wallet that receives all swept funds
const DESTINATION_ADDRESS = '0x0990da5d417bb9c7ac55cdd66115e633803f1a75';

// Array of source private keys
const PRIVATE_KEYS = [
  '0x32cb35828c99ff167a7edc531cb6940f0453366cb4570ea9f20a3461667250ed',
  '0x9d0f941fb3d9e28b407c69aa931ce4691be925d8d962a52fef56881a9cfc936b',
  '0x9b742551e9c2bf53b1a41ec3f8769aa072461c1f41e20ee765d32f65c1b0a840',
  '0x25f1988679a8417cc13ee51d4f6ba4b3648b16ed289b5086a55171dde4ab554f',
  '0x2fb7297d63e47472b4a63b129a206e23d514acb8d5c0a5fec8653d84ddd4df25',
  '0x3a191060ae7c4838300fdf58c60e17456ec0a0e08f25f4d9afc6ec570d778971',
  '0xe9c10696c7ba24cff341474ae872aad9995e02c258c766c9fee944731aaf5cc5',
  '0x6a9e449f8caa076db328b4a2ab1f7f75de63cca82cd532d6fc25e21e59f339fc',
  '0xe7733d48f05400ccc80d3e3f1f23a46df068130f4263bc502ffab13ffe8a49a2',
  '0xf46afddf5051752def8f74a4ab106936cb2d5aa75a663b4f0aa5c2470e6e9008',
  '0xbf28f11948b2a6b7deb58be4f39af0dab2ef4a9471ce660adb153b49dbe0b846',
  '0xefa734b7d6bf7844db4d31091899df06a49cda30645fb16c1238837cb9e73165',
  '0x980c4ff7710afc80707db4989319cb8b16ed39349127a38034b48875c95f81c1',
  '0x201d53c95305af98c576eaa233bbfdca7b8ad51e756ca1bef237c1836ff49ef8',
  '0x9becf2bf25f1563ac42a9a73e3f02e592a0ed98415aca5052ed58b3fdd88a488',
  '0x90005b11e3d29fbdf65c64db6b6f2385f356dfcc184bb9a5af28a35f84bc5384',
  '0x83f2bf012b344edf2930842782c7534742e9da05fa80dcfdadcb35f467283a24',
  '0x9f5016835e2990f8e840c304e210a8653f40e2fe5d009100a95488e45adc5191',
  '0x71b57e6cdb66c01e63f377fb38c8610b9df1a24ccc16c52a7db33d97db0f3d19',
  '0x40d2a4193eb90ca4cdbb03797bf2faa109276dad1f258b684bf27616b6fae584',
  '0xfec0620bcab296d7daef5ead2e863abeff6354badf23fd41adb9844156ea47a1',
  '0x668a197530337d6a9d8c2f75a196aa8158bd842191482a8106eea5e461c9dcd0',
  '0xaf3984c2fa49e3dde7911ed2717f66937c592a42689a163d067c6c79f8c86504',
  '0x36daa7a5106dd2e0a2f35a82715c301dc94eb86def440fdc796302e524c546c3',
  '0xc87a46c68696751e424dfa05a1a7d3679cfbc3fc37238bddaa40c5e8f312b525',
  '0x7d35edb2aa6d1bc290687c09eee1307355669be28e76c381869ced967fdfaead',
  '0x46114891ef0d5725aac6a860631b8cd9546d3d2e26743ebfee30c77b2372495b',
  '0x14de6f35c6aa224e0ed35f7342e8e96664ec13d52860821bf7b7e6f2914d67b2',
  '0x66d7c6258915d770e4cecf006a550fbcd9392dc51e3a32bec64134bfb476b888',
  '0x794998ae4d1d38e837a8e1929d45dcd28a6e04c719e17ae8b6dea73d3feb811b',
  '0x22e9817d67e421df0c664b61f9ebda334ac2ed6011086e3250df76167f0be898',
  '0x0726f21ea0be11d9115b5c32a32e2016da11cc21439ac685fedf3fc45bfb8020',
  '0x92ffd97bb07d2d22ed16d45ead1bc101964d778094fb5299db695db0d581a3ce',
  '0x448ccd309e1d142a8e7bf133206454a8963fae2fe997684d449d9f4e22a632f9',
  '0x0526c9f26112c06b26e034af08cfe2009aad1a9914a5a80db6aed9e5693c4ecf',
];

// Token Contract Addresses on BSC
const TOKENS = {
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  USDT: '0x55d398326f99059fF775485246999027B3197955',
};

const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address recipient, uint256 amount) external returns (bool)',
];

// ─── SWEEP LOGIC ─────────────────────────────────────────────────

async function sweepWallet(privateKey) {
  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`\n==================================================`);
  console.log(`Processing Wallet: ${wallet.address}`);
  console.log(`==================================================`);

  // 1. Sweep BEP-20 Tokens First (USDC, USDT)
  for (const [symbol, tokenAddress] of Object.entries(TOKENS)) {
    try {
      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
      const balance = await contract.balanceOf(wallet.address);

      if (balance > 0n) {
        console.log(`Found ${symbol} balance: ${ethers.formatUnits(balance, 18)}`);

        // Fetch lowest live gas price
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;

        // Dynamic gas estimation for lowest accurate fee
        const estimatedGas = await contract.transfer.estimateGas(DESTINATION_ADDRESS, balance);

        console.log(`Sweeping ${symbol} to ${DESTINATION_ADDRESS}...`);
        const tx = await contract.transfer(DESTINATION_ADDRESS, balance, {
          gasLimit: estimatedGas,
          gasPrice: gasPrice,
        });

        console.log(`Tx Submitted: ${tx.hash}`);
        await tx.wait(1);
        console.log(`Swept ${symbol} successfully.`);
      } else {
        console.log(`No ${symbol} balance.`);
      }
    } catch (err) {
      console.error(`Failed to sweep ${symbol}:`, err.message);
    }
  }

  // 2. Sweep Native BNB Last
  try {
    const balance = await provider.getBalance(wallet.address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;

    // Standard native transfer gas limit
    const gasLimit = 21000n;
    const totalGasCost = gasLimit * gasPrice;

    if (balance > totalGasCost) {
      const sweepAmount = balance - totalGasCost;
      console.log(`Sweeping Native BNB: ${ethers.formatEther(sweepAmount)} BNB`);

      const tx = await wallet.sendTransaction({
        to: DESTINATION_ADDRESS,
        value: sweepAmount,
        gasLimit: gasLimit,
        gasPrice: gasPrice,
      });

      console.log(`BNB Tx Submitted: ${tx.hash}`);
      await tx.wait(1);
      console.log(`Swept Native BNB successfully.`);
    } else {
      console.log(`Insufficient BNB to cover gas fee (${ethers.formatEther(totalGasCost)} BNB required).`);
    }
  } catch (err) {
    console.error(`Failed to sweep Native BNB:`, err.message);
  }
}

async function main() {
  if (!DESTINATION_ADDRESS || !ethers.isAddress(DESTINATION_ADDRESS)) {
    throw new Error('Please set a valid DESTINATION_ADDRESS.');
  }

  for (const key of PRIVATE_KEYS) {
    await sweepWallet(key);
  }
  console.log('\nConsolidation complete.');
}

main().catch(console.error);