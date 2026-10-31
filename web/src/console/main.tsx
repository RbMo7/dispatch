import { Tray } from '@phosphor-icons/react';

import { Button } from '../components/Button';
import { mount } from '../mount';
import { Placeholder } from '../Placeholder';
import { Gallery } from './Gallery';

const path = window.location.pathname.replace(/\/+$/, '');

mount(
  path === '/console/_primitives' ? (
    <Gallery />
  ) : (
    <Placeholder
      icon={<Tray size={18} />}
      title="The console is on its way"
      action={
        <Button variant="soft" arrow href="/console/_primitives">
          View primitives
        </Button>
      }
    >
      Its pages are being built. The primitives they use are ready to review.
    </Placeholder>
  ),
);
