import type { Transition } from 'motion/react';

// The console's one spring (design.md, Motion): rows reflow and insert with it.
export const layoutSpring: Transition = { type: 'spring', stiffness: 400, damping: 34 };

// A new row enters 6 px over 180 ms.
export const rowEnter: Transition = { duration: 0.18, ease: [0.2, 0, 0, 1] };

export const fade: Transition = { duration: 0.16, ease: 'easeOut' };

export const modalScale: Transition = { duration: 0.16, ease: [0.2, 0, 0, 1] };

export const sheetSlide: Transition = { duration: 0.24, ease: [0.32, 0.72, 0, 1] };

export const reveal: Transition = { duration: 0.5, ease: [0.2, 0, 0, 1] };

export const REVEAL_STAGGER_S = 0.06;
