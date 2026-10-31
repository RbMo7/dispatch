import type { ReactNode } from 'react';

import styles from './Card.module.css';

interface CardProps {
  title?: string;
  /** A quiet link at the right of the title, such as "View all" or "Dispatches". */
  link?: { label: string; href: string };
  /** Anything else for the header's right side, such as a quiet button. */
  aside?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}

export function Card({ title, link, aside, className, children }: CardProps) {
  return (
    <section className={className ? `${styles.card} ${className}` : styles.card}>
      {title !== undefined && (
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {link && (
            <a className={styles.link} href={link.href}>
              {link.label} ›
            </a>
          )}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}
