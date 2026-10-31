import { ArrowRight } from '@phosphor-icons/react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './Button.module.css';

type Variant = 'ink' | 'soft';

interface CommonProps {
  variant?: Variant;
  arrow?: boolean;
  children: ReactNode;
}

type ButtonProps = CommonProps &
  (
    | ({ href: string } & AnchorHTMLAttributes<HTMLAnchorElement>)
    | ({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>)
  );

export function Button({ variant = 'ink', arrow = false, children, ...rest }: ButtonProps) {
  const content = (
    <>
      {children}
      {arrow && <ArrowRight size={14} weight="bold" aria-hidden="true" />}
    </>
  );
  const className = `${styles.button} ${styles[variant]}`;

  if (rest.href !== undefined) {
    return (
      <a className={className} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={className} {...rest}>
      {content}
    </button>
  );
}
