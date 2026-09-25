import { describe, expect, it } from 'vitest';

import { NonceCounter } from './nonce-authority.js';

describe('NonceCounter', () => {
  it('assigns sequential, non-colliding values starting from the given initial nonce', () => {
    const counter = new NonceCounter(5);

    expect(counter.assignNext()).toBe(5);
    expect(counter.assignNext()).toBe(6);
    expect(counter.assignNext()).toBe(7);
  });

  it('peek reflects the next value assignNext would hand out, without assigning it', () => {
    const counter = new NonceCounter(0);

    expect(counter.peek()).toBe(0);
    expect(counter.peek()).toBe(0); // reading twice doesn't advance it
    counter.assignNext();
    expect(counter.peek()).toBe(1);
  });

  it('resyncTo corrects the counter to a fresh on-chain value, discarding any drift', () => {
    const counter = new NonceCounter(0);
    counter.assignNext();
    counter.assignNext();
    expect(counter.peek()).toBe(2);

    counter.resyncTo(0); // e.g. those two assignments never actually broadcast
    expect(counter.peek()).toBe(0);
    expect(counter.assignNext()).toBe(0);
  });

  it('advanceTo only ever moves forward — never back onto nonces already handed out (review of #13)', () => {
    const counter = new NonceCounter(10);
    counter.assignNext(); // 10 in flight
    counter.assignNext(); // 11 in flight

    counter.advanceTo(8); // chain's confirmed count lags what's in flight
    expect(counter.peek()).toBe(12);

    counter.advanceTo(15); // chain is genuinely ahead
    expect(counter.peek()).toBe(15);
  });
});
