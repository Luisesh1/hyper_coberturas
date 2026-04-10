import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
const provider = new JsonRpcProvider('https://arbitrum-one-rpc.publicnode.com', 42161, { staticNetwork: true });
const ABI = ['function balanceOf(address) view returns (uint256)'];
const wallet = '0x7614BC8DA965C231135684Fa6b851E932f680cCb';
const weth = new Contract('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', ABI, provider);
const usdt = new Contract('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', ABI, provider);
const [w, u] = await Promise.all([weth.balanceOf(wallet), usdt.balanceOf(wallet)]);
console.log('Wallet WETH:  ', formatUnits(w, 18), 'WETH');
console.log('Wallet USD₮0: ', formatUnits(u, 6), 'USD₮0');
