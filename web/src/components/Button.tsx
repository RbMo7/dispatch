import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
} from 'react';

import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-filled';

interface CommonProps {
  variant?: ButtonVariant;
  /** A square 28 px icon button; `aria-label` names it. */
  icon?: boolean;
  children: ReactNode;
}

export type ButtonProps = CommonProps &
  (
    | ({ href: string } & AnchorHTMLAttributes<HTMLAnchorElement>)
    | ({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>)
  );

export const Button = forwardRef<HTMLButtonElement & HTMLAnchorElement, ButtonProps>(
  function Button({ variant = 'secondary', icon = false, children, className, ...rest }, ref) {
    const classes = [styles.button, styles[variant], icon && styles.icon, className]
      .filter(Boolean)
      .join(' ');

    if (rest.href !== undefined) {
      return (
        <a ref={ref} className={classes} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <button ref={ref} type="button" className={classes} {...rest}>
        {children}
      </button>
    );
  },
);
