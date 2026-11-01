import { describe, expect, it } from 'vitest';

import { decideTakenNonce, type TakenNonceFacts } from './taken-nonce.js';

const firstSend: TakenNonceFacts = {
  everSent: false,
  answers: 1,
  versions: ['no_receipt'],
  resends: 0,
};

describe('decideTakenNonce (ADR-0064)', () => {
  it.each<[string, TakenNonceFacts, ReturnType<typeof decideTakenNonce>]>([
    ['refused on its first send, no receipt: resend', firstSend, 'resend'],
    ['its own hash landed: confirmed', { ...firstSend, versions: ['landed'] }, 'confirmed'],
    [
      'an earlier fee-bump version landed: confirmed',
      { ...firstSend, everSent: true, versions: ['no_receipt', 'landed'] },
      'confirmed',
    ],
    [
      'a landed version wins over a failed read',
      { ...firstSend, versions: ['unreadable', 'landed'] },
      'confirmed',
    ],
    ['the receipt read failed: wait', { ...firstSend, versions: ['unreadable'] }, 'wait'],
    [
      'one version unreadable, the rest absent: wait',
      { ...firstSend, everSent: true, answers: 2, versions: ['no_receipt', 'unreadable'] },
      'wait',
    ],
    [
      'sent before, first "nonce too low": wait for it again',
      { ...firstSend, everSent: true, answers: 1 },
      'wait',
    ],
    [
      'sent before, answered twice, never landed: resend',
      { ...firstSend, everSent: true, answers: 2, versions: ['no_receipt', 'no_receipt'] },
      'resend',
    ],
    ['third resend still allowed', { ...firstSend, resends: 2 }, 'resend'],
    ['out of resends: fail', { ...firstSend, resends: 3 }, 'fail'],
    [
      'out of resends but a version landed: confirmed',
      { ...firstSend, resends: 3, versions: ['landed'] },
      'confirmed',
    ],
  ])('%s', (_case, facts, decision) => {
    expect(decideTakenNonce(facts)).toBe(decision);
  });
});
