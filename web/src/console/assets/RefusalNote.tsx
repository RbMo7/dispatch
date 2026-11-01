import { TextView } from '../../components/FlowGraph';
import { type ErrorContext, type Explanation, explainError } from '../../domain/errors';
import { ApiError, describeFailure } from '../api/client';
import css from './assets.module.css';

export type Refusal = Pick<Explanation, 'text' | 'next' | 'quote'>;

/** A failed asset change in the error catalogue's words, or the failure itself when the engine sent no code. */
export function assetRefusal(failure: unknown, ctx: ErrorContext): Refusal {
  if (!(failure instanceof ApiError)) throw failure;
  return failure.failure.kind === 'refused'
    ? explainError(failure.failure, ctx)
    : { text: describeFailure(failure.failure), next: '', quote: null };
}

/** A refused asset change, inline where it happened: plain words, then the engine's own where they add a fact. */
export function RefusalNote({ refusal }: { refusal: Refusal }) {
  return (
    <div className={css.refusal} role="alert">
      <p className={css.refusalText}>
        <TextView text={refusal.text} />
        {refusal.next && ` ${refusal.next}`}
      </p>
      {refusal.quote && <p className={css.refusalDetail}>{refusal.quote}</p>}
    </div>
  );
}
