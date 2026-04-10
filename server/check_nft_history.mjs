import { JsonRpcProvider, Contract, Interface } from 'ethers';

const RPC = process.env.UNI_RPC_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const TOKEN_ID = 5412248n;

const EVENTS_ABI = [
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
];

async function main() {
  const provider = new JsonRpcProvider(RPC, 42161, { staticNetwork: true });
  const iface = new Interface(EVENTS_ABI);

  const tokenIdTopic = '0x' + TOKEN_ID.toString(16).padStart(64, '0');

  const latestBn = await provider.getBlockNumber();
  const latest = Number(latestBn);
  const fromBlock = Math.max(0, latest - 250_000);
  console.log('Latest block:', latest, '| from:', fromBlock);

  const topics = {
    IncreaseLiquidity: iface.getEvent('IncreaseLiquidity').topicHash,
    DecreaseLiquidity: iface.getEvent('DecreaseLiquidity').topicHash,
    Collect: iface.getEvent('Collect').topicHash,
  };

  const chunkSize = 5_000;
  const events = [];
  for (let from = fromBlock; from <= latest; from += chunkSize) {
    const to = Math.min(from + chunkSize - 1, latest);
    for (const [name, topic0] of Object.entries(topics)) {
      try {
        const logs = await provider.getLogs({
          address: POSITION_MANAGER,
          topics: [topic0, tokenIdTopic],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          const parsed = iface.parseLog(log);
          const argObj = parsed.args.toObject();
          const args = {};
          for (const [k, v] of Object.entries(argObj)) {
            args[k] = typeof v === 'bigint' ? v.toString() : v;
          }
          events.push({ name, blockNumber: log.blockNumber, txHash: log.transactionHash, args });
        }
      } catch (err) {
        console.warn(`getLogs ${name} ${from}-${to}: ${(err.message || '').slice(0, 80)}`);
      }
    }
  }

  events.sort((a, b) => a.blockNumber - b.blockNumber);
  console.log('\n=== Eventos del NFT 5412248 ===');
  for (const ev of events) {
    console.log(`\nBloque ${ev.blockNumber} | ${ev.name}`);
    console.log('  tx:', ev.txHash);
    console.log('  args:', JSON.stringify(ev.args));
  }
  console.log('\nTotal eventos:', events.length);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
