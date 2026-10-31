import { BookOpen } from '@phosphor-icons/react';

import { mount } from '../mount';
import { Placeholder } from '../Placeholder';

mount(
  <Placeholder icon={<BookOpen size={18} />} title="The docs are being written">
    Until they land here, the guides live in the repository&apos;s docs folder.
  </Placeholder>,
);
