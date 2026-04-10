import { JsonRpcProvider } from 'ethers';

const RPC = process.env.UNI_RPC_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com';

async function main() {
  const provider = new JsonRpcProvider(RPC, 42161, { staticNetwork: true });

  const blocks = [450480930, 450514440];
  for (const bn of blocks) {
    const blk = await provider.getBlock(bn);
    console.log(`Bloque ${bn}: timestamp=${blk.timestamp} = ${new Date(blk.timestamp * 1000).toISOString()}`);
  }

  console.log('\n=== TX 0xb8af6b46... (DecreaseLiquidity) ===');
  const tx = await provider.getTransaction('0xb8af6b4641c3098a206b9b85dad989d4c477992bd49a7902eac3b25c49f9894a');
  console.log('from:', tx.from);
  console.log('to:', tx.to);
  console.log('input selector:', tx.data.slice(0, 10));
  console.log('input length:', tx.data.length);

  const receipt = await provider.getTransactionReceipt(tx.hash);
  console.log('status:', receipt.status, '(1 = success)');
  console.log('gasUsed:', receipt.gasUsed.toString());
  console.log('block:', receipt.blockNumber);
  console.log('logs count:', receipt.logs.length);
  // Imprimimos los selectors de funciones más comunes para identificar
  console.log('\nFunction selector references:');
  console.log('  multicall(bytes[])     = 0xac9650d8');
  console.log('  decreaseLiquidity      = 0x0c49ccbe');
  console.log('  collect                = 0xfc6f7865');
  console.log('  burn                   = 0x42966c68');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
