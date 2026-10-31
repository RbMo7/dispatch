import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import styles from './Scaled.module.css';

interface ScaledProps {
  /** The size the console components are laid out at, before scaling. */
  width: number;
  height: number;
  /** Below this the view stops shrinking and is cropped instead, so text stays legible. */
  minScale?: number;
  maxScale?: number;
  /** Which edge stays in view when the view is cropped. */
  anchor?: 'left' | 'right';
  /** Start the visible window this far down the laid-out view. */
  offsetY?: number;
  children: ReactNode;
}

/**
 * Real console components laid out at console size, scaled to the container's width.
 * The view is a picture of the product, so it is inert: nothing in it takes focus or clicks.
 */
export function Scaled({
  width,
  height,
  minScale = 0,
  maxScale = 1,
  anchor = 'left',
  offsetY = 0,
  children,
}: ScaledProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(width);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setAvailable(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = Math.min(maxScale, Math.max(minScale, available / width));
  const visibleWidth = Math.min(width, available / scale);

  return (
    <div ref={ref} className={styles.window} style={{ height: height * scale }}>
      <div
        className={styles.view}
        aria-hidden="true"
        {...{ inert: '' }}
        style={{
          width,
          height: height + offsetY,
          transform: `scale(${scale}) translate(${anchor === 'right' ? visibleWidth - width : 0}px, ${-offsetY}px)`,
          left: available > width * scale ? (available - width * scale) / 2 : 0,
        }}
      >
        {children}
      </div>
    </div>
  );
}
