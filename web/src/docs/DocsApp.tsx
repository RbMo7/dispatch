import { GithubLogo, List, MagnifyingGlass } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ThemeToggle } from '../components/ThemeToggle';
import { Sheet } from '../motion/Overlay';
import { Article } from './Article';
import styles from './DocsApp.module.css';
import { SideNav } from './SideNav';
import { pageForPath } from './pages';
import { Rail } from './Rail';
import { useLocation } from './router';
import { Search } from './Search';

const HOME =
  import.meta.env.MODE === 'engine'
    ? { href: '/console', label: 'Console' }
    : { href: '/', label: 'Home' };

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function DocsApp() {
  const [location, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState<{ query: string }>();
  const page = pageForPath(location.pathname);

  useEffect(() => {
    document.title = `${page?.title ?? 'Not found'} - Dispatch docs`;
  }, [page]);

  useEffect(() => {
    const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [page, location.hash]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearch({ query: '' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.menu}`}
          aria-label="Open navigation"
          onClick={() => setMenuOpen(true)}
        >
          <List size={18} aria-hidden="true" />
        </button>
        <a
          href="/docs"
          className={styles.brand}
          onClick={(event) => {
            event.preventDefault();
            navigate('/docs');
          }}
        >
          Dispatch <span className={styles.brandMuted}>Docs</span>
        </a>
        <button type="button" className={styles.searchButton} onClick={() => setSearch({ query: '' })}>
          <MagnifyingGlass size={14} aria-hidden="true" />
          <span className={styles.searchLabel}>Search</span>
          <kbd className={styles.kbd}>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <div className={styles.actions}>
          <a href={HOME.href} className={styles.textLink}>
            {HOME.label}
          </a>
          <a
            href="https://github.com/RbMo7/dispatch"
            className={styles.iconButton}
            aria-label="Dispatch on GitHub"
          >
            <GithubLogo size={18} aria-hidden="true" />
          </a>
          <ThemeToggle />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <SideNav current={page} onNavigate={navigate} />
        </aside>
        <main className={styles.content}>
          {page ? (
            <Article key={page.slug} page={page} onNavigate={navigate} />
          ) : (
            <EmptyState
              icon={<MagnifyingGlass size={18} />}
              title={`No page at ${location.pathname}`}
              action={
                <Button
                  variant="soft"
                  onClick={() => setSearch({ query: queryFromPath(location.pathname) })}
                >
                  Search the docs
                </Button>
              }
            >
              The link may be out of date. Search for what you were after.
            </EmptyState>
          )}
        </main>
        <aside className={styles.rail}>{page && <Rail page={page} />}</aside>
      </div>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Docs">
        <SideNav
          current={page}
          onNavigate={(href) => {
            setMenuOpen(false);
            navigate(href);
          }}
        />
      </Sheet>
      <Search
        open={search !== undefined}
        initialQuery={search?.query ?? ''}
        onClose={() => setSearch(undefined)}
        onNavigate={navigate}
      />
    </div>
  );
}

function queryFromPath(pathname: string): string {
  return (pathname.split('/').at(-1) ?? '').replace(/[-_]+/g, ' ').trim();
}
