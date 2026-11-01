import type { AssetRefusal } from '../../domain/assets';
import css from './assets.module.css';

/** A refused asset change, inline where it happened: plain words, then the engine's own. */
export function RefusalNote({ refusal }: { refusal: AssetRefusal }) {
  return (
    <div className={css.refusal} role="alert">
      <p className={css.refusalText}>{refusal.text}</p>
      {refusal.detail && <p className={css.refusalDetail}>{refusal.detail}</p>}
    </div>
  );
}
