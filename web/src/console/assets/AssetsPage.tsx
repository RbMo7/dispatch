import { Plus } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { MonoValue } from '../../components/MonoValue';
import { Switch } from '../../components/Switch';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { ASSET_KINDS, type KnownAsset } from '../../domain/assets';
import { CHAINS, type Chain } from '../../domain/chains';
import { describeFailure } from '../api/client';
import styles from '../console.module.css';
import { useRouter } from '../router';
import { useAssets, useEnabledChains } from '../senderData';
import { useOperator } from '../session';
import { PageBar } from '../Shell';
import { AddAssetPane } from './AddAssetPane';
import css from './assets.module.css';
import { EnableModal } from './EnableModal';

/**
 * Known Assets per enabled chain (ADR-0061). An operator adds a token from its
 * address, read from the chain, and disables or enables one added here.
 * `?chain=base&add=<address>` opens Add with the address filled in, and `&symbol=<symbol>` the
 * symbol; a symbol alone opens Add too, waiting for the address (the Rejected page links so).
 */
export function AssetsPage() {
  const operator = useOperator();
  const toast = useToast();
  const { params, replaceParams } = useRouter();
  const assets = useAssets();
  const chains = useEnabledChains();
  const [changing, setChanging] = useState<KnownAsset | null>(null);

  const asked = params.get('chain');
  const chain = chains.find((c) => c === asked) ?? chains[0] ?? null;
  const adding = operator && (params.has('add') || params.has('symbol')) && chain !== null;
  const rows = useMemo(
    () => (assets.data ?? []).filter((asset) => asset.chain === chain),
    [assets.data, chain],
  );

  /** `add: null` closes the form, dropping the address and symbol it was opened with. */
  const go = (next: { chain?: Chain | null; add?: string | null }) => {
    const query = new URLSearchParams();
    const c = next.chain === undefined ? chain : next.chain;
    if (c) query.set('chain', c);
    const add = next.add === undefined ? params.get('add') : next.add;
    if (add !== null) query.set('add', add);
    const symbol = params.get('symbol');
    if (next.add === undefined && symbol !== null) query.set('symbol', symbol);
    replaceParams(query);
  };

  return (
    <div className={styles.split}>
      <main className={styles.main}>
        <PageBar title="Assets">
          {operator && chain && (
            <Button variant="primary" onClick={() => go({ add: '' })}>
              <Plus size={14} aria-hidden="true" />
              Add asset
            </Button>
          )}
        </PageBar>
        <div className={styles.pageBody}>
          {chains.length === 0 || !chain ? (
            <p className={styles.noRows}>
              {assets.error ? describeFailure(assets.error.failure) : 'Loading assets'}
            </p>
          ) : (
            <Tabs
              label="Chains"
              tabs={chains.map((id) => ({ id, label: CHAINS[id].label }))}
              value={chain}
              onChange={(id) => go({ chain: id })}
            >
              <AssetTable
                rows={rows}
                operator={operator}
                loading={!assets.data}
                onChange={(asset) => setChanging(asset)}
              />
            </Tabs>
          )}
        </div>
      </main>
      {adding && (
        <AddAssetPane
          key={chain}
          chain={chain}
          address={params.get('add') ?? ''}
          symbol={params.get('symbol') ?? ''}
          onClose={() => go({ add: null })}
          onAdded={(asset) => {
            assets.reload();
            toast(`${asset.symbol} added on ${CHAINS[asset.chain].label}`);
            go({ chain: asset.chain, add: null });
          }}
        />
      )}
      <EnableModal
        asset={changing}
        onClose={() => setChanging(null)}
        onChanged={(asset) => {
          setChanging(null);
          assets.reload();
          toast(`${asset.symbol} ${asset.enabled ? 'enabled' : 'disabled'}`);
        }}
      />
    </div>
  );
}

function AssetTable({
  rows,
  operator,
  loading,
  onChange,
}: {
  rows: readonly KnownAsset[];
  operator: boolean;
  loading: boolean;
  onChange: (asset: KnownAsset) => void;
}) {
  if (loading) return <p className={styles.noRows}>Loading assets</p>;
  return (
    <>
      <div className={css.scroll}>
        <table className={css.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Symbol</th>
              <th scope="col">Address</th>
              <th scope="col" className={css.number}>
                Decimals
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Source</th>
              <th scope="col">Enabled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((asset) => (
              <tr key={asset.id} data-disabled={!asset.enabled || undefined}>
                <th scope="row" className={css.name}>
                  {asset.name}
                </th>
                <td className={css.symbol}>{asset.symbol}</td>
                <td>
                  {asset.kind === 'native' ? (
                    <span className={styles.muted}>Native coin</span>
                  ) : (
                    <MonoValue value={asset.address} head={6} tail={4} />
                  )}
                </td>
                <td className={css.number}>{asset.decimals}</td>
                <td>{ASSET_KINDS[asset.kind]}</td>
                <td className={styles.muted}>
                  {asset.source === 'config' ? 'Configuration' : 'Console'}
                </td>
                <td>
                  <span className={css.enabled}>
                    {operator && asset.source === 'console' && (
                      <Switch
                        checked={asset.enabled}
                        label={`${asset.symbol} enabled`}
                        onChange={() => onChange(asset)}
                      />
                    )}
                    {asset.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((asset) => asset.source === 'config') && (
        <p className={css.readOnly}>
          Assets from the configuration can&apos;t be changed here. Edit SOLANA_KNOWN_TOKENS or
          BASE_KNOWN_TOKENS and restart the engine.
        </p>
      )}
    </>
  );
}
