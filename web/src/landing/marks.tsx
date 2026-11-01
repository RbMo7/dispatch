import base from '@web3icons/core/svgs/networks/mono/base.svg.js';
import solana from '@web3icons/core/svgs/networks/mono/solana.svg.js';
import safe from '@web3icons/core/svgs/wallets/mono/safe.svg.js';
import squads from '@web3icons/core/svgs/wallets/mono/squads.svg.js';

import styles from './marks.module.css';

/** A real logo from @web3icons/core, or, where no maintained package has one, the name as a wordmark. */
export type Mark =
  | { name: string; svg: string; tile: { bg: string; fg: string } }
  | { name: string; svg: null; tile?: undefined };

const ON_CHAIN = '#ffffff';

function mono(svg: string): string {
  return svg
    .replace(/ width="\d+" height="\d+"/, '')
    .replace(/ class="[^"]*"/, '')
    .replaceAll('fill="#fff"', 'fill="currentColor"');
}

export const SOLANA: Mark = {
  name: 'Solana',
  svg: mono(solana),
  tile: { bg: 'var(--chain-solana)', fg: ON_CHAIN },
};
export const BASE: Mark = {
  name: 'Base',
  svg: mono(base),
  tile: { bg: '#0052ff', fg: ON_CHAIN },
};
export const SQUADS: Mark = {
  name: 'Squads',
  svg: mono(squads),
  tile: { bg: 'var(--ink)', fg: 'var(--surface)' },
};
export const SAFE: Mark = {
  name: 'Safe',
  svg: mono(safe),
  tile: { bg: 'var(--ink)', fg: 'var(--surface)' },
};
export const PRIVY: Mark = { name: 'Privy', svg: null };
export const AWS_KMS: Mark = { name: 'AWS KMS', svg: null };

export const MARKS: readonly Mark[] = [SOLANA, BASE, SQUADS, SAFE, PRIVY, AWS_KMS];

/** The mark's glyph alone, in the current text colour. */
export function MarkGlyph({ mark, className }: { mark: Mark; className: string | undefined }) {
  if (mark.svg === null) return null;
  return (
    <span
      className={`${styles.glyph} ${className ?? ''}`}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: mark.svg }}
    />
  );
}

/** A rounded-square tile, sized in em so it sits inline in a headline. */
export function MarkTile({ mark }: { mark: Mark }) {
  if (mark.svg === null) {
    return (
      <span className={`${styles.tile} ${styles.wordTile}`}>
        <span className={styles.word}>{mark.name}</span>
      </span>
    );
  }
  return (
    <span className={styles.tile} style={{ background: mark.tile.bg, color: mark.tile.fg }}>
      <MarkGlyph mark={mark} className={styles.tileGlyph} />
    </span>
  );
}
