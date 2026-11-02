import { Plus } from '@phosphor-icons/react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '../../components/Button';
import { MonoValue } from '../../components/MonoValue';
import { Switch } from '../../components/Switch';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { definitionName } from '../../domain/calls';
import { CHAINS, type Chain } from '../../domain/chains';
import type { KnownContract } from '../../domain/contracts';
import { describeFailure } from '../api/client';
import css from '../assets/assets.module.css';
import styles from '../console.module.css';
import { SENDERS_MS, usePoll } from '../live';
import { useRouter } from '../router';
import { useEnabledChains } from '../senderData';
import { useApi, useOperator } from '../session';
import { PageBar } from '../Shell';
import { AddContractPane } from './AddContractPane';
import { ContractEnableModal } from './ContractEnableModal';

const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The contract registry per enabled chain (ADR-0063): the ABIs and IDLs that
 * explain calls. `?chain=base&add=<address>` opens Add with the address filled
 * in, which is where a call's "Add ABI" leads.
 */
export function ContractsPage() {
  const api = useApi();
  const operator = useOperator();
  const toast = useToast();
  const { params, replaceParams } = useRouter();
  const chains = useEnabledChains();
  const load = useCallback((signal: AbortSignal) => api.listContracts(signal), [api]);
  const contracts = usePoll({ key: 'contracts', load, delay: () => SENDERS_MS });
  const [changing, setChanging] = useState<KnownContract | null>(null);

  const asked = params.get('chain');
  const chain = chains.find((c) => c === asked) ?? chains[0] ?? null;
  const adding = operator && params.has('add') && chain !== null;
  const rows = useMemo(
    () => (contracts.data ?? []).filter((contract) => contract.chain === chain),
    [contracts.data, chain],
  );

  const go = (next: { chain?: Chain | null; add?: string | null }) => {
    const query = new URLSearchParams();
    const c = next.chain === undefined ? chain : next.chain;
    if (c) query.set('chain', c);
    const add = next.add === undefined ? params.get('add') : next.add;
    if (add !== null) query.set('add', add);
    replaceParams(query);
  };

  return (
    <div className={styles.split}>
      <main className={styles.main}>
        <PageBar title="Contracts">
          {operator && chain && (
            <Button variant="primary" onClick={() => go({ add: '' })}>
              <Plus size={14} aria-hidden="true" />
              Add {definitionName(chain)}
            </Button>
          )}
        </PageBar>
        <div className={styles.pageBody}>
          {chains.length === 0 || !chain ? (
            <p className={styles.noRows}>
              {contracts.error ? describeFailure(contracts.error.failure) : 'Loading contracts'}
            </p>
          ) : (
            <Tabs
              label="Chains"
              tabs={chains.map((id) => ({ id, label: CHAINS[id].label }))}
              value={chain}
              onChange={(id) => go({ chain: id, add: null })}
            >
              <ContractTable
                chain={chain}
                rows={rows}
                operator={operator}
                loading={!contracts.data}
                onChange={setChanging}
              />
            </Tabs>
          )}
        </div>
      </main>
      {adding && (
        <AddContractPane
          key={`${chain}-${params.get('add') ?? ''}`}
          chain={chain}
          address={params.get('add') ?? ''}
          onClose={() => go({ add: null })}
          onAdded={(contract) => {
            contracts.reload();
            toast(`${contract.label} added on ${CHAINS[contract.chain].label}`);
            go({ chain: contract.chain, add: null });
          }}
        />
      )}
      <ContractEnableModal
        contract={changing}
        onClose={() => setChanging(null)}
        onChanged={(contract) => {
          setChanging(null);
          contracts.reload();
          toast(`${contract.label} ${contract.enabled ? 'enabled' : 'disabled'}`);
        }}
      />
    </div>
  );
}

function ContractTable({
  chain,
  rows,
  operator,
  loading,
  onChange,
}: {
  chain: Chain;
  rows: readonly KnownContract[];
  operator: boolean;
  loading: boolean;
  onChange: (contract: KnownContract) => void;
}) {
  if (loading) return <p className={styles.noRows}>Loading contracts</p>;
  if (rows.length === 0) {
    return (
      <p className={styles.noRows}>
        No contracts registered on {CHAINS[chain].label}. Calls the built-in decoders do not know
        show their raw data until you add the{' '}
        {chain === 'base' ? "contract's ABI" : "program's IDL"}.
      </p>
    );
  }
  const explains = chain === 'base' ? 'Functions' : 'Instructions';
  return (
    <div className={css.scroll}>
      <table className={css.table}>
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Address</th>
            <th scope="col">{explains}</th>
            {chain === 'base' && <th scope="col">Events</th>}
            <th scope="col">Added</th>
            <th scope="col">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((contract) => (
            <tr key={contract.id} data-disabled={!contract.enabled || undefined}>
              <th scope="row" className={css.name}>
                {contract.label}
              </th>
              <td>
                <MonoValue value={contract.address} head={6} tail={4} />
              </td>
              <td title={contract.functions.join('\n')}>{contract.functions.length}</td>
              {chain === 'base' && (
                <td title={contract.events.join('\n')}>{contract.events.length}</td>
              )}
              <td className={styles.muted}>{day.format(contract.addedAt)}</td>
              <td>
                <span className={css.enabled}>
                  {operator && (
                    <Switch
                      checked={contract.enabled}
                      label={`${contract.label} enabled`}
                      onChange={() => onChange(contract)}
                    />
                  )}
                  {contract.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
