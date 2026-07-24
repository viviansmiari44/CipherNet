// lib/lastTransferIndexer.ts

const EXPLORER_API_URLS: Record<string, string> = {
  ethereum: 'https://api.etherscan.io/api',
  bsc: 'https://api.bscscan.com/api',
  polygon: 'https://api.polygonscan.com/api',
};

const EXPLORER_API_KEYS: Record<string, string | undefined> = {
  ethereum: process.env.ETHERSCAN_API_KEY,
  bsc: process.env.BSCSCAN_API_KEY,
  polygon: process.env.POLYGONSCAN_API_KEY,
};

/**
 * Method 1: Alchemy `alchemy_getAssetTransfers`
 * Queries directly via your existing Alchemy RPC URL.
 */
async function fetchFromAlchemy(
  rpcUrl: string,
  fromAddress: string,
  toAddress: string
): Promise<string | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getAssetTransfers',
        params: [
          {
            fromBlock: '0x0',
            toBlock: 'latest',
            fromAddress: fromAddress.toLowerCase(),
            toAddress: toAddress.toLowerCase(),
            category: ['external', 'erc20'],
            order: 'desc',
            maxCount: '0x1',
            withMetadata: true,
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const transfers = data?.result?.transfers;

    if (Array.isArray(transfers) && transfers.length > 0) {
      const timestampStr = transfers[0]?.metadata?.blockTimestamp;
      if (timestampStr) {
        return new Date(timestampStr).toISOString();
      }
    }
  } catch (err) {
    console.warn('[Alchemy Indexer Error]:', err);
  }
  return null;
}

/**
 * Method 2: Block Explorer API (Etherscan / BscScan / Polygonscan)
 * Queries ERC-20 and Native transfers sorted newest first.
 */
async function fetchFromExplorer(
  chain: string,
  fromAddress: string,
  toAddress: string
): Promise<string | null> {
  const normalizedChain = chain.toLowerCase();
  const baseUrl = EXPLORER_API_URLS[normalizedChain];
  const apiKey = EXPLORER_API_KEYS[normalizedChain] || '';

  if (!baseUrl) return null;

  const targetTo = toAddress.toLowerCase();

  // Check both ERC20 transfers (tokentx) and Native transfers (txlist)
  for (const action of ['tokentx', 'txlist']) {
    try {
      const url = `${baseUrl}?module=account&action=${action}&address=${fromAddress}&sort=desc&page=1&offset=50${
        apiKey ? `&apikey=${apiKey}` : ''
      }`;

      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();

      if (data.status === '1' && Array.isArray(data.result)) {
        const match = data.result.find(
          (tx: any) => tx.to?.toLowerCase() === targetTo
        );

        if (match && match.timeStamp) {
          const timeSec = Number(match.timeStamp);
          if (!isNaN(timeSec)) {
            return new Date(timeSec * 1000).toISOString();
          }
        }
      }
    } catch (err) {
      console.warn(`[Explorer Indexer Error - ${chain}]:`, err);
    }
  }

  return null;
}

/**
 * Unified Helper: Tries Alchemy RPC first, then falls back to Block Explorer API
 */
export async function getLastTransferTimestamp(params: {
  chain: string;
  rpcUrl: string;
  fromAddress: string;
  toAddress: string;
}): Promise<string | null> {
  const { chain, rpcUrl, fromAddress, toAddress } = params;

  if (!fromAddress || !toAddress) return null;

  // 1. Try Alchemy RPC first
  if (rpcUrl && rpcUrl.includes('alchemy.com')) {
    const alchemyResult = await fetchFromAlchemy(rpcUrl, fromAddress, toAddress);
    if (alchemyResult) return alchemyResult;
  }

  // 2. Fallback to Explorer APIs (Etherscan / BscScan / Polygonscan)
  return await fetchFromExplorer(chain, fromAddress, toAddress);
}