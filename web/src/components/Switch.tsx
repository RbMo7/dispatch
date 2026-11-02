import styles from './Switch.module.css';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What it turns on, for a screen reader: "Large USDC payment". */
  label: string;
  disabled?: boolean;
}

/** An on/off toggle: a 28 by 16 track, the knob on the right when on. */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={styles.track}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className={styles.knob} />
    </button>
  );
}
