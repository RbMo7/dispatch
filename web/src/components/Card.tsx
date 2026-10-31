import { CaretRight } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import styles from './Card.module.css';

interface CardProps {
  title?: string;
  viewAllHref?: string;
  children: ReactNode;
}

export function Card({ title, viewAllHref, children }: CardProps) {
  return (
    <section className={styles.card}>
      {title !== undefined && (
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {viewAllHref !== undefined && (
            <a className={styles.viewAll} href={viewAllHref}>
              View all
              <CaretRight size={12} weight="bold" aria-hidden="true" />
            </a>
          )}
        </header>
      )}
      {children}
    </section>
  );
}
