import { PaperPlaneTilt } from '@phosphor-icons/react';

import { Button } from '../components/Button';
import { mount } from '../mount';
import { Placeholder } from '../Placeholder';

mount(
  <Placeholder
    icon={<PaperPlaneTilt size={18} />}
    title="Dispatch"
    action={
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <Button href="/docs">Read the docs</Button>
        <Button variant="soft" arrow href="https://github.com/RbMo7/dispatch">
          View on GitHub
        </Button>
      </div>
    }
  >
    A self-hosted engine that signs, sends, retries and confirms your Solana and Base transactions.
  </Placeholder>,
);
