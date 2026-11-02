import { useEffect, useState } from 'react';

import type { DocPage } from './manifest';
import styles from './Rail.module.css';

const READING_LINE_PX = 96;

export function Rail({ page }: { page: DocPage }) {
  const active = useActiveHeading(page);
  if (page.headings.length === 0) return null;

  return (
    <nav aria-label="On this page" className={styles.rail}>
      <h2 className={styles.heading}>On this page</h2>
      <ul className={styles.list}>
        {page.headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              className={styles.item}
              data-depth={heading.depth}
              aria-current={heading.id === active ? 'location' : undefined}
            >
              {heading.method ? (
                <>
                  <span className="method" data-method={heading.method}>
                    {heading.method}
                  </span>{' '}
                  {heading.text.slice(heading.method.length + 1)}
                </>
              ) : (
                heading.text
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function useActiveHeading(page: DocPage): string | undefined {
  const [active, setActive] = useState<string>();

  useEffect(() => {
    const ids = page.headings.map((heading) => heading.id);
    let frame = 0;
    const update = () => {
      frame = 0;
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom && window.scrollY > 0) {
        setActive(ids.at(-1));
        return;
      }
      let reading = ids[0];
      for (const id of ids) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top === undefined || top > READING_LINE_PX) break;
        reading = id;
      }
      setActive(reading);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [page]);

  return active;
}
