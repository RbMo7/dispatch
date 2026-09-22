import { runChainHandlerConformanceSuite } from './conformance.js';
import { StubChainHandler } from './stub-chain-handler.js';

runChainHandlerConformanceSuite('stub', () => new StubChainHandler(), {
  senderAddress: '0xsender',
  asset: 'ETH',
  validPayment: { recipient: '0xrecipient', asset: 'ETH', amount: '10' },
  validCall: { to: '0xrecipient', data: '0x', value: '0' },
  invalidCall: { to: 'not-an-address', data: '0x', value: '0' },
  invalidSignedTransaction: 'force-failure',
});
