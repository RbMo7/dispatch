import { Button } from '../components/Button';
import { mount } from '../mount';
import { Placeholder } from '../Placeholder';
import { Gallery } from './gallery/Gallery';

const path = window.location.pathname.replace(/\/+$/, '');

mount(
  path === '/console/_primitives' ? (
    <Gallery />
  ) : (
    <Placeholder
      caption="The console pages are being built. The primitives they use are ready to review."
      action={
        <Button variant="secondary" href="/console/_primitives">
          View primitives
        </Button>
      }
    />
  ),
);
