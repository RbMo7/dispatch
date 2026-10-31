import type { ReactNode } from 'react';

import { EmptyState } from './components/EmptyState';
import styles from './Placeholder.module.css';

// Stand-in for a surface whose pages have not been built yet.
export function Placeholder(props: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <EmptyState {...props} />
    </main>
  );
}
