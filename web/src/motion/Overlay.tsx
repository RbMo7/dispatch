import { X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../components/Button';
import { modalScale, sheetSlide } from './transitions';
import styles from './Overlay.module.css';

interface FrameProps {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  titleId?: string;
}

/** The modal's box: small uppercase title, close, body and footer. Also shown inline in the gallery. */
export function ModalFrame({ title, onClose, footer, children, titleId }: FrameProps) {
  return (
    <div className={styles.frame}>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <Button variant="quiet" icon aria-label="Close" className={styles.close} onClick={onClose}>
          <X size={14} weight="bold" aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
  );
}

interface ModalProps extends Omit<FrameProps, 'titleId'> {
  open: boolean;
}

// One decision at a time: scales from 0.98 over 160 ms as the scrim fades in.
// Under reduced motion only the fades remain.
export function Modal({ open, ...frame }: ModalProps) {
  const titleId = useId();
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={styles.layer}>
          <motion.div
            className={styles.scrim}
            onClick={frame.onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={modalScale}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={styles.modal}
            initial={{ scale: 0.98, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.98, opacity: 0 }}
            transition={modalScale}
          >
            <FocusAndEscape onClose={frame.onClose}>
              <ModalFrame {...frame} titleId={titleId} />
            </FocusAndEscape>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/** A left sheet for narrow screens (the docs navigation). */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const titleId = useId();
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={styles.layer}>
          <motion.div
            className={styles.scrim}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={sheetSlide}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={styles.sheet}
            initial={{ x: '-100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '-100%', opacity: 0 }}
            transition={sheetSlide}
          >
            <FocusAndEscape onClose={onClose}>
              <div className={styles.sheetBody}>
                <h2 id={titleId} className={styles.sheetTitle}>
                  {title}
                </h2>
                {children}
              </div>
            </FocusAndEscape>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// Mounted only while open: takes focus in (to a [data-autofocus] child when
// there is one), closes on Escape, locks page scroll, and hands focus back to
// whatever opened it.
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
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current)?.focus();
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
    <div ref={ref} tabIndex={-1} className={styles.focus}>
      {children}
    </div>
  );
}
