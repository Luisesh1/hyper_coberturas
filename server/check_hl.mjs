async function main() {
  const userAddress = '0x81E3c7ad81Ef18d4B14Cdf7eeD0c951EdDC71c6C'; // account_id 8 "prestado 2"
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'clearinghouseState', user: userAddress }),
  });
  const data = await res.json();
  console.log('=== Hyperliquid account "prestado 2" (' + userAddress + ') ===');
  console.log('marginSummary:', JSON.stringify(data.marginSummary, null, 2));
  console.log('withdrawable:', data.withdrawable);
  console.log('crossMarginSummary:', JSON.stringify(data.crossMarginSummary, null, 2));
  console.log('\n=== Posiciones abiertas ===');
  if (!data.assetPositions || data.assetPositions.length === 0) {
    console.log('Sin posiciones abiertas. ✓');
  } else {
    for (const ap of data.assetPositions) {
      const p = ap.position;
      console.log(`- ${p.coin}: szi=${p.szi}, entryPx=${p.entryPx}, unrealizedPnl=${p.unrealizedPnl}, marginUsed=${p.marginUsed}`);
    }
  }
}
main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
