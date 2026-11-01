import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './Tooltip.module.css';

/** Long enough to move the pointer from the trigger onto the tip without it closing. */
const CLOSE_DELAY_MS = 120;

interface TooltipProps {
  /** What the tip says, also the trigger's accessible description. */
  tip: string;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * A short text shown above its trigger on hover or keyboard focus. Escape
 * hides it without moving focus. The tip is drawn in a portal so a list's
 * scroll area never clips it.
 */
export function Tooltip({ tip, children, className }: TooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => () => clearTimeout(closing.current), []);

  const show = () => {
    clearTimeout(closing.current);
    const box = trigger.current?.getBoundingClientRect();
    if (box) setAt({ left: box.left + box.width / 2, top: box.top });
  };
  const hide = () => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => setAt(null), CLOSE_DELAY_MS);
  };

  return (
    <>
      <span
        ref={trigger}
        tabIndex={0}
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
        aria-describedby={id}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={() => setAt(null)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !at) return;
          event.stopPropagation();
          setAt(null);
        }}
      >
        {children}
      </span>
      <span id={id} hidden>
        {tip}
      </span>
      {at &&
        createPortal(
          <span
            className={styles.tip}
            style={{ left: at.left, top: at.top }}
            aria-hidden="true"
            onPointerEnter={show}
            onPointerLeave={hide}
          >
            {tip}
          </span>,
          document.body,
        )}
    </>
  );
}
