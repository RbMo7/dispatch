import { MagnifyingGlass } from '@phosphor-icons/react';
import MiniSearch from 'minisearch';
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';

import { Modal } from '../motion/Overlay';
import { SEARCH_OPTIONS, type SearchEntry } from './manifest';
import styles from './Search.module.css';

type Hit = Pick<SearchEntry, 'id' | 'slug' | 'anchor' | 'pageTitle' | 'heading' | 'excerpt'>;

const MAX_HITS = 12;

let index: Promise<MiniSearch<SearchEntry>> | undefined;

function loadIndex(): Promise<MiniSearch<SearchEntry>> {
  index ??= import('virtual:docs-search').then(({ default: json }) =>
    MiniSearch.loadJSON<SearchEntry>(json, SEARCH_OPTIONS),
  );
  return index;
}

interface SearchProps {
  open: boolean;
  initialQuery: string;
  onClose: () => void;
  onNavigate: (href: string) => void;
}

export function Search({ open, initialQuery, onClose, onNavigate }: SearchProps) {
  return (
    <Modal open={open} onClose={onClose} title="Search the docs">
      <SearchBody
        initialQuery={initialQuery}
        onPick={(hit) => {
          onClose();
          onNavigate(`/docs/${hit.slug}${hit.anchor === '' ? '' : `#${hit.anchor}`}`);
        }}
      />
    </Modal>
  );
}

function SearchBody({ initialQuery, onPick }: { initialQuery: string; onPick: (hit: Hit) => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState<MiniSearch<SearchEntry>>();
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    let live = true;
    void loadIndex().then((loaded) => {
      if (live) setSearch(loaded);
    });
    return () => {
      live = false;
    };
  }, []);

  const hits = useMemo<Hit[]>(() => {
    if (!search || query.trim() === '') return [];
    return search
      .search(query)
      .slice(0, MAX_HITS)
      .map((result) => ({
        id: String(result.id),
        slug: result.slug as string,
        anchor: result.anchor as string,
        pageTitle: result.pageTitle as string,
        heading: result.heading as string,
        excerpt: result.excerpt as string,
      }));
  }, [search, query]);

  useEffect(() => setActive(0), [hits]);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + hits.length) % hits.length);
    } else if (event.key === 'Enter' && hits[active]) {
      event.preventDefault();
      onPick(hits[active]);
    }
  }

  return (
    <div className={styles.search}>
      <label className={styles.field}>
        <MagnifyingGlass size={16} aria-hidden="true" className={styles.icon} />
        <span className={styles.hidden}>Search</span>
        <input
          data-autofocus
          type="search"
          role="combobox"
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={hits.length > 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Headings and text across every page"
          className={styles.input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <ul id={listId} role="listbox" aria-label="Results" className={styles.results}>
        {hits.map((hit, i) => (
          <li
            key={hit.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={styles.hit}
            onMouseMove={() => setActive(i)}
            onClick={() => onPick(hit)}
          >
            <span className={styles.hitHeading}>{hit.heading}</span>
            {hit.heading !== hit.pageTitle && (
              <span className={styles.hitPage}>{hit.pageTitle}</span>
            )}
            {hit.excerpt !== '' && <span className={styles.hitExcerpt}>{hit.excerpt}</span>}
          </li>
        ))}
      </ul>
      {query.trim() !== '' && search && hits.length === 0 && (
        <p className={styles.note}>Nothing matches &ldquo;{query.trim()}&rdquo;.</p>
      )}
      <p className={styles.keys} aria-hidden="true">
        <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close
      </p>
    </div>
  );
}
