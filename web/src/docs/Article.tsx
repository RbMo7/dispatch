import { PencilSimple } from '@phosphor-icons/react';
import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from 'react';

import type { DocPage } from './manifest';
import { REPO_BLOB_URL } from './nav';
import styles from './Prose.module.css';
import { isPlainClick } from './router';

interface ArticleProps {
  page: DocPage;
  onNavigate: (href: string) => void;
}

export function Article({ page, onNavigate }: ArticleProps) {
  function onClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;

    const copy = target.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      void copyCode(copy);
      return;
    }
    const tab = target.closest<HTMLElement>('[role="tab"]');
    if (tab) {
      selectTab(tab, event.currentTarget);
      return;
    }
    const link = target.closest('a');
    const href = link?.getAttribute('href');
    if (href?.startsWith('/docs') && isPlainClick(event)) {
      event.preventDefault();
      onNavigate(href);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!tab || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    const tabs = [...tab.parentElement!.querySelectorAll<HTMLElement>('[role="tab"]')];
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]!;
    selectTab(next, event.currentTarget);
    next.focus();
  }

  // React does not report a change from a <select> it did not render, so listen natively.
  const prose = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scope = prose.current;
    if (!scope) return;
    const onChange = (event: Event) => {
      const select = event.target;
      if (select instanceof HTMLSelectElement && select.dataset.exampleSelect) {
        showExample(scope, select.dataset.exampleSelect, select.value);
      }
    };
    scope.addEventListener('change', onChange);
    return () => scope.removeEventListener('change', onChange);
  }, [page]);

  return (
    <article className={`${styles.article} ${page.layout === 'reference' ? styles.reference : ''}`}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{page.section}</p>
        <h1 className={styles.title}>{page.title}</h1>
      </header>
      <div
        className={styles.prose}
        onClick={onClick}
        onKeyDown={onKeyDown}
        ref={prose}
        dangerouslySetInnerHTML={{ __html: page.html }}
      />
      <footer className={styles.footer}>
        <a className={styles.edit} href={`${REPO_BLOB_URL}/${page.source}`}>
          <PencilSimple size={14} aria-hidden="true" />
          Edit this page
        </a>
        <span className={styles.source}>{page.source}</span>
      </footer>
    </article>
  );
}

async function copyCode(button: HTMLButtonElement) {
  const code = button.closest('figure')?.querySelector('pre')?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1400);
  } catch {
    // No clipboard (insecure origin, denied permission): the code is still selectable.
  }
}

/** The tab picked in each kind of tab group, so a sample built later opens on the same one. */
const picked = new WeakMap<HTMLElement, Map<string, string>>();

function selectTab(chosen: HTMLElement, scope: HTMLElement) {
  const label = chosen.dataset.tab;
  const own = chosen.closest<HTMLElement>('.code-tabs[data-own-tabs]');
  if (own) {
    switchGroup(own, chosen, scope);
    return;
  }
  const kind = chosen.parentElement?.getAttribute('aria-label');
  if (label && kind) {
    const choices = picked.get(scope) ?? new Map<string, string>();
    choices.set(kind, label);
    picked.set(scope, choices);
  }
  for (const group of scope.querySelectorAll<HTMLElement>('.code-tabs:not([data-own-tabs])')) {
    const tabs = [...group.querySelectorAll<HTMLElement>('[role="tab"]')];
    const match = group.contains(chosen) ? chosen : tabs.find((tab) => tab.dataset.tab === label);
    if (match) switchGroup(group, match, scope);
  }
}

function switchGroup(group: HTMLElement, match: HTMLElement, scope: HTMLElement) {
  for (const tab of group.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const selected = tab === match;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    if (!panel) continue;
    panel.hidden = !selected;
    if (selected) build(panel, scope);
  }
}

/**
 * Builds, in its place, the markup each `<script type="text/html" data-lazy>` under `root` holds,
 * where nothing hides it, and opens its tab groups on the tabs already picked on the page.
 */
function build(root: HTMLElement, scope: HTMLElement) {
  const built: HTMLElement[] = [];
  for (const lazy of root.querySelectorAll<HTMLScriptElement>('script[data-lazy]')) {
    const parent = lazy.parentElement;
    if (!parent || parent.closest('[hidden]')) continue;
    lazy.insertAdjacentHTML('afterend', lazy.text);
    lazy.remove();
    built.push(parent);
  }
  const choices = picked.get(scope);
  if (!choices) return;
  for (const parent of built) {
    for (const list of parent.querySelectorAll<HTMLElement>('[role="tablist"]')) {
      const label = choices.get(list.getAttribute('aria-label') ?? '');
      const tab = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (candidate) => candidate.dataset.tab === label,
      );
      if (tab && tab.getAttribute('aria-selected') !== 'true') selectTab(tab, scope);
    }
  }
}

/**
 * A reference operation shows one named example at a time: its request and its response, and the
 * schema of that response's status, which the operation renders once per status. Each is built
 * the first time it is shown.
 */
function showExample(scope: HTMLElement, operation: string, name: string) {
  let status: string | undefined;
  for (const panel of scope.querySelectorAll<HTMLElement>(`[data-op="${operation}"]`)) {
    panel.hidden = panel.dataset.example !== name;
    if (!panel.hidden) status = panel.dataset.status;
  }
  for (const panel of scope.querySelectorAll<HTMLElement>(`[data-schema-op="${operation}"]`)) {
    panel.hidden = panel.dataset.status !== status;
  }
  const shown = `[data-op="${operation}"]:not([hidden]), [data-schema-op="${operation}"]:not([hidden])`;
  for (const panel of scope.querySelectorAll<HTMLElement>(shown)) build(panel, scope);
}
