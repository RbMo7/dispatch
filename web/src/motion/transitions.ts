import type { Transition } from 'motion/react';

// The console's one spring (design.md, Motion): rows reflow and insert with it.
export const layoutSpring: Transition = { type: 'spring', stiffness: 400, damping: 34 };

export const pillMorph: Transition = { duration: 0.2, ease: [0.2, 0, 0, 1] };

export const paneSlide: Transition = { duration: 0.24, ease: [0.32, 0.72, 0, 1] };

export const modalScale: Transition = { duration: 0.2, ease: [0.2, 0, 0, 1] };

export const reveal: Transition = { duration: 0.5, ease: [0.16, 1, 0.3, 1] };

export const REVEAL_STAGGER_S = 0.06;
