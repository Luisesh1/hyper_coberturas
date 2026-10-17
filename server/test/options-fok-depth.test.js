const test = require('node:test');
const assert = require('node:assert/strict');
const { fullSizeFokLimit } = require('../src/services/options/options-fok-depth');

const NOW = 1_780_000_000_000;
const book = (bids, asks=[['12.00','0.01']], T=NOW) => ({bids,asks,T});
const sell = (depth, options={}) => fullSizeFokLimit({
  book:depth, side:'SELL', quantity:0.01, nowMs:NOW, ...options,
});

test('FOK SELL picks the worst bid needed to fill the entire size, never just top of book',()=>{
  assert.equal(sell(book([['11.70','0.005'],['11.60','0.005']])),11.60);
  assert.equal(sell(book([['11.70','0.01']])),11.70);
});
test('FOK BUY close analogously traverses all asks',()=>{
  const depth=book([['11.50','0.01']],[['11.70','0.003'],['11.80','0.007']]);
  assert.equal(fullSizeFokLimit({book:depth,side:'BUY',quantity:.01,nowMs:NOW}),11.8);
});
test('insufficient quantity and excess adverse slippage are both NO POST',()=>{
  assert.throws(()=>sell(book([['11.70','0.005']])),/Insufficient visible/);
  assert.throws(()=>sell(book([['11.70','0.005'],['10.20','0.005']])),/slippage/);
  assert.throws(()=>sell(book([['11.70','0.01']]),{maxAdversePct:50}),/Invalid FOK/);
});
test('stale, future, one-sided, crossed, malformed, unsorted and empty book fail closed',()=>{
  assert.throws(()=>sell(book([['11.7','.01']],undefined,NOW-10001)),/stale/);
  assert.throws(()=>sell(book([['11.7','.01']],undefined,NOW+2001)),/stale/);
  assert.throws(()=>sell(book([['11.7','.01']],[],NOW)),/two-sided/);
  assert.throws(()=>sell(book([['12.70','.01']],[['12.00','.01']])),/crossed/);
  assert.throws(()=>sell(book([['11.7','.005'],['11.8','.005']])),/unsorted/);
  assert.throws(()=>sell(book([['11.7','.005'],['11.6','-1']])),/Invalid or unsorted/);
  assert.throws(()=>sell(book([['11.7','.01']]),{quantity:0}),/Invalid FOK/);
});
