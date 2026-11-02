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

function selectTab(chosen: HTMLElement, scope: HTMLElement) {
  const label = chosen.dataset.tab;
  for (const group of scope.querySelectorAll<HTMLElement>('.code-tabs')) {
    const tabs = [...group.querySelectorAll<HTMLElement>('[role="tab"]')];
    const match = group.contains(chosen) ? chosen : tabs.find((tab) => tab.dataset.tab === label);
    if (!match) continue;
    for (const tab of tabs) {
      const selected = tab === match;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (!panel) continue;
      panel.hidden = !selected;
      if (selected) build(panel);
    }
  }
}

/** Swaps the inert `<template data-lazy>` blocks under `scope` for their content. */
function build(scope: HTMLElement) {
  for (const template of scope.querySelectorAll<HTMLTemplateElement>('template[data-lazy]')) {
    template.replaceWith(template.content);
  }
}

/**
 * A reference operation shows one named example at a time: its request and its response, and the
 * schema of that response's status, which the operation renders once per status.
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
}
