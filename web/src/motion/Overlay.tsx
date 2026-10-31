import { AnimatePresence, motion, type TargetAndTransition, type Transition } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { modalScale, paneSlide } from './transitions';
import styles from './Overlay.module.css';

interface Kind {
  className: string | undefined;
  hidden: TargetAndTransition;
  transition: Transition;
}

// Opacity rides along with each transform so that, with the transform removed
// under reduced motion, both still arrive as a plain fade.
const KINDS = {
  pane: { className: styles.pane, hidden: { x: '100%', opacity: 0 }, transition: paneSlide },
  modal: { className: styles.modal, hidden: { scale: 0.96, opacity: 0 }, transition: modalScale },
} satisfies Record<string, Kind>;

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

function Overlay({
  kind,
  open,
  onClose,
  title,
  children,
}: OverlayProps & { kind: keyof typeof KINDS }) {
  const { className, hidden, transition } = KINDS[kind];
  const titleId = useId();

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={styles.layer}>
          <motion.div
            className={styles.backdrop}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={transition}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={className}
            initial={hidden}
            animate={{ x: 0, scale: 1, opacity: 1 }}
            exit={hidden}
            transition={transition}
          >
            <FocusAndEscape onClose={onClose}>
              <h2 id={titleId} className={styles.title}>
                {title}
              </h2>
              {children}
            </FocusAndEscape>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// Mounted only while open: takes focus in, closes on Escape, locks page
// scroll, and hands focus back to whatever opened it.
function FocusAndEscape({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  return (
    <div ref={ref} tabIndex={-1} className={styles.body}>
      {children}
    </div>
  );
}

export function Pane(props: OverlayProps) {
  return <Overlay kind="pane" {...props} />;
}

export function Modal(props: OverlayProps) {
  return <Overlay kind="modal" {...props} />;
}
