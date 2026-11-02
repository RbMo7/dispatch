import { useBalances } from '../balances';
import { formatAmount, type Money, splitAmount } from '../domain/assets';
import styles from './Amount.module.css';
import { Tooltip } from './Tooltip';

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
  /**
   * The asset's name as a tooltip on its symbol. Off inside a link or button,
   * where a second focusable element can't live.
   */
  tip?: boolean;
}

const MASK = '••••';

export function Amount({ variant = 'row', unit = false, tip = true, ...money }: AmountProps) {
  const { hidden } = useBalances();
  const symbol =
    tip && money.name !== money.asset ? (
      <Tooltip tip={money.name}>{money.asset}</Tooltip>
    ) : (
      money.asset
    );
  const mask = (
    <>
      <span className="visually-hidden">Hidden amount</span>
      <span className={styles.mask} aria-hidden="true">
        {MASK}
      </span>
    </>
  );

  if (variant === 'plain') {
    return (
      <span className={styles.plain}>
        {hidden ? mask : formatAmount(money)}
        {unit && <> {symbol}</>}
      </span>
    );
  }

  const { whole, fraction } = splitAmount(money);
  return (
    <span className={`${styles.amount} ${styles[variant]}`}>
      {hidden ? (
        mask
      ) : (
        <>
          <span className="visually-hidden">{formatAmount(money)} </span>
          <span aria-hidden="true">
            {whole}
            <span className={styles.fraction}>{fraction}</span>
          </span>
        </>
      )}
      <span className={styles.unit}>{symbol}</span>
    </span>
  );
}
