import { useBalances } from '../balances';
import { formatAmount, type Money, splitAmount } from '../domain/assets';
import styles from './Amount.module.css';

export type AmountVariant = 'row' | 'raised' | 'plain';

interface AmountProps extends Money {
  /**
   * `row`: the unit in a fixed 38 px slot so decimals line up down a list.
   * `raised`: the unit lifted to cap height, for a headline figure.
   * `plain`: one run of text, for "700.00 committed".
   */
  variant?: AmountVariant;
  /** `plain` only: follow the figure with its unit, as in "0.4182 SOL". */
  unit?: boolean;
}

const MASK = '••••';

// `raw` is the integer string in the smallest unit, as the engine reports it.
export function Amount({ variant = 'row', unit = false, ...money }: AmountProps) {
  const { hidden } = useBalances();
  const label = hidden ? `Hidden ${money.asset} amount` : `${formatAmount(money)} ${money.asset}`;

  if (variant === 'plain') {
    return (
      <span className={styles.plain} aria-label={label}>
        {hidden ? MASK : formatAmount(money)}
        {unit && ` ${money.asset}`}
      </span>
    );
  }

  const { whole, fraction } = splitAmount(money);
  return (
    <span className={`${styles.amount} ${styles[variant]}`} aria-label={label}>
      <span aria-hidden="true">
        {hidden ? (
          <span className={styles.mask}>{MASK}</span>
        ) : (
          <>
            {whole}
            <span className={styles.fraction}>{fraction}</span>
          </>
        )}
        <span className={styles.unit}>{money.asset}</span>
      </span>
    </span>
  );
}
