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
                  title={page.adr ? page.label : undefined}
                  onClick={(event) => {
                    if (!isPlainClick(event)) return;
                    event.preventDefault();
                    onNavigate(hrefFor(page));
                  }}
                >
                  {page.adr && <span className={styles.number}>{page.adr.number}</span>}
                  <span className={styles.label}>{page.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
