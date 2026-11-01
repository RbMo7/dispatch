import { mount } from '../mount';
import { Placeholder } from '../Placeholder';
import { PillButton } from './PillButton';

mount(
  <Placeholder
    caption="A self-hosted engine that signs, sends, retries and confirms your Solana and Base transactions."
    action={
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <PillButton href="/docs">Get started</PillButton>
        <PillButton variant="soft" arrow href="https://github.com/RbMo7/dispatch">
          View on GitHub
        </PillButton>
      </div>
    }
  />,
);
