import type { DocPage } from './manifest';
import styles from './SideNav.module.css';
import { hrefFor, SECTIONS } from './pages';
import { isPlainClick } from './router';

interface SideNavProps {
  current: DocPage | undefined;
  onNavigate: (href: string) => void;
}

export function SideNav({ current, onNavigate }: SideNavProps) {
  return (
    <nav aria-label="Docs" className={styles.nav}>
      {SECTIONS.map((section) => (
        <div key={section.title} className={styles.section}>
          <h2 className={styles.heading}>{section.title}</h2>
          <ul className={styles.list}>
            {section.pages.map((page) => (
              <li key={page.slug}>
                <a
                  href={hrefFor(page)}
                  className={styles.item}
                  aria-current={page === current ? 'page' : undefined}
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    onNavigate(hrefFor(page));
                  }}
                >
                  {page.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
