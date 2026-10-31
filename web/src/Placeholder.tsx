import type { ReactNode } from 'react';

import { EmptyState } from './components/EmptyState';
import styles from './Placeholder.module.css';

export function Placeholder(props: { caption: ReactNode; action?: ReactNode }) {
  return (
    <main className={styles.page}>
      <EmptyState {...props} />
    </main>
  );
}
