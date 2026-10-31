import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/geist-mono';
import './styles/tokens.css';
import './styles/base.css';

import { MotionConfig } from 'motion/react';
import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

export function mount(app: ReactNode): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('missing #root');
  createRoot(root).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">{app}</MotionConfig>
    </StrictMode>,
  );
}
