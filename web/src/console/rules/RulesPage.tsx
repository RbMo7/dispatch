import { Plus } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';

import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { CHAINS } from '../../domain/chains';
import { describeCheck, draftBody, draftOf, type FlagRule } from '../../domain/flagRules';
import { sharedChains } from '../../domain/sender';
import { ApiError, describeFailure } from '../api/client';
import styles from '../console.module.css';
import { type Polled, SENDERS_MS, usePoll } from '../live';
import ops from '../operator.module.css';
import { useRouter } from '../router';
import { useSenders } from '../senderData';
import { useApi } from '../session';
import { PageBar } from '../Shell';
import { RuleEditor } from './RuleEditor';

function useFlagRules(): Polled<FlagRule[]> {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => api.listFlagRules(signal), [api]);
  return usePoll({ key: 'flag-rules', load, delay: () => SENDERS_MS });
}

/** Rules with an on/off switch, and the editor in the right pane: `?rule=<id>` or `?rule=new`. */
export function RulesPage() {
  const api = useApi();
  const toast = useToast();
  const { params, replaceParams } = useRouter();
  const rules = useFlagRules();
  const senders = useSenders().data ?? [];
  const shared = useMemo(() => sharedChains(senders), [senders]);
  const selected = params.get('rule');
  const select = (rule: string | null) => replaceParams(new URLSearchParams(rule ? { rule } : {}));
  const editing = selected === 'new' ? null : rules.data?.find((rule) => rule.id === selected);

  async function toggle(rule: FlagRule, enabled: boolean) {
    // Its Sender left the configuration: the request can only name a Sender, so saving would widen it.
    if (rule.current.sender && rule.current.sender.name === null) {
      toast(`${rule.current.name}'s Sender is no longer configured. Open it to choose a scope.`);
      return;
    }
    const body = draftBody({ ...draftOf(rule), enabled });
    if (!body.ok) return;
    try {
      await api.updateFlagRule(rule.id, body.body);
      toast(`${rule.current.name} switched ${enabled ? 'on' : 'off'}`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      toast(describeFailure(error.failure));
    }
    rules.reload();
  }

  const scopeOf = (rule: FlagRule) => {
    const { chain, sender } = rule.current;
    const where = CHAINS[chain].label;
    if (!sender) return shared.has(chain) ? `${where}, every Sender` : where;
    return `${where}, ${sender.name ?? 'a Sender no longer configured'} only`;
  };

  return (
    <div className={styles.split}>
      <main className={styles.main}>
        <PageBar title="Flag Rules">
          <Button variant="primary" onClick={() => select('new')}>
            <Plus size={14} aria-hidden="true" />
            New rule
          </Button>
        </PageBar>
        <div className={styles.list}>
          {!rules.data ? (
            <p className={styles.noRows}>
              {rules.error ? describeFailure(rules.error.failure) : 'Loading Flag Rules'}
            </p>
          ) : rules.data.length === 0 ? (
            <EmptyState caption="No Flag Rules yet. A rule holds a Managed Dispatch that breaks it until you release or cancel it." />
          ) : (
            rules.data.map((rule) => (
              <div
                key={rule.id}
                className={`${ops.ruleRow} ${rule.current.enabled ? '' : ops.ruleOff}`}
                data-selected={rule.id === selected || undefined}
              >
                <button
                  type="button"
                  className={ops.ruleMain}
                  aria-current={rule.id === selected || undefined}
                  onClick={() => select(rule.id)}
                >
                  <span className={ops.ruleName}>{rule.current.name}</span>
                  <span className={ops.ruleLine}>
                    {describeCheck(rule.current.check, rule.current.chain)}, {scopeOf(rule)}
                  </span>
                </button>
                <span className={ops.ruleMeta}>Version {rule.current.version}</span>
                <Switch
                  checked={rule.current.enabled}
                  label={`${rule.current.name} on`}
                  onChange={(on) => void toggle(rule, on)}
                />
              </div>
            ))
          )}
        </div>
      </main>
      {selected && (selected === 'new' || editing) && (
        <RuleEditor
          key={editing ? `${editing.id}-${editing.current.version}` : 'new'}
          rule={editing ?? null}
          senders={senders}
          onClose={() => select(null)}
          onSaved={(saved, created) => {
            rules.reload();
            toast(created ? `${saved.current.name} created` : `${saved.current.name} saved`);
            select(saved.id);
          }}
        />
      )}
    </div>
  );
}
