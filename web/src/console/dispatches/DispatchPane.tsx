import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { FlowGraph } from '../../components/FlowGraph';
import { MonoValue } from '../../components/MonoValue';
import { StatusPill } from '../../components/StatusPill';
import { Tabs } from '../../components/Tabs';
import type { Money } from '../../domain/assets';
import type { Item, ItemFilter, Mode, SenderRef } from '../../domain/dispatch';
import type { Flow } from '../../domain/flow';
import type { Status } from '../../domain/status';
import type { ExportFormat } from '../../export/download';
import { fade } from '../../motion/transitions';
import styles from '../console.module.css';
import { ItemsTab } from './ItemsTab';

export type PaneTab = 'flow' | 'items' | 'details';
export const PANE_TABS: readonly PaneTab[] = ['flow', 'items', 'details'];

const TAB_LABELS: Record<PaneTab, string> = { flow: 'Flow', items: 'Items', details: 'Details' };

export interface PaneHead {
  id: string;
  mode: Mode;
  name: string;
  /** "Today, 14:02". */
  when: string;
  totals: readonly Money[];
  status: Status;
}

interface DispatchPaneProps {
  head: PaneHead;
  /** Null while the first load is out, or when it failed: `body` says which. */
  flow: Flow | null;
  /** Null for a Relay Dispatch, which has no items: its tab is left out. */
  items: readonly Item[] | null;
  details: readonly { label: string; value: ReactNode }[];
  /** Shown in place of the tabs while loading or after a failed load. */
  body?: ReactNode;
  tab: PaneTab;
  onTab: (tab: PaneTab) => void;
  itemFilter: ItemFilter;
  onItemFilter: (filter: ItemFilter) => void;
  itemSearch: string;
  onItemSearch: (search: string) => void;
  onExportItems: (format: ExportFormat, items: readonly Item[]) => void;
  explorerHref: string | null;
  /** The footer's right side: Cancel while unclaimed, or where to reject an open Proposal. */
  action?: ReactNode;
  onClose: () => void;
}

export function DispatchPane(props: DispatchPaneProps) {
  const { head, items } = props;
  const tabs = PANE_TABS.filter((tab) => tab !== 'items' || items !== null).map((id) => ({
    id,
    label: TAB_LABELS[id],
  }));
  const tab = tabs.some((t) => t.id === props.tab) ? props.tab : 'flow';

  return (
    <DockedPane
      title={head.mode === 'relay' ? 'Relay Dispatch' : 'Managed Dispatch'}
      meta={<MonoValue value={head.id} head={8} tail={4} />}
      label="Dispatch detail"
      onClose={props.onClose}
      footer={
        <>
          {props.explorerHref ? (
            <Button variant="secondary" href={props.explorerHref} target="_blank" rel="noreferrer">
              Open in explorer
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              Open in explorer
            </Button>
          )}
          {props.action && <span className={styles.pushRight}>{props.action}</span>}
        </>
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={head.id}
          className={styles.paneInner}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
        >
          <div className={styles.summary}>
            <div className={styles.muted}>{head.when}</div>
            <div className={styles.summaryLine}>
              <span className={styles.summaryName}>{head.name}</span>
              {head.totals[0] && (
                <span className={styles.summaryTotal}>
                  <Amount {...head.totals[0]} variant="raised" />
                </span>
              )}
            </div>
            {head.totals.length > 1 && (
              <div className={styles.summaryMore}>
                {head.totals.slice(1).map((total) => (
                  <Amount key={total.asset} {...total} variant="plain" unit />
                ))}
              </div>
            )}
            <div className={styles.summaryPill}>
              <StatusPill status={head.status} />
            </div>
          </div>
          {props.body ?? (
            <Tabs label="Dispatch views" tabs={tabs} value={tab} onChange={props.onTab}>
              {tab === 'flow' && props.flow && (
                <div className={styles.tabBody}>
                  <FlowGraph
                    flow={props.flow}
                    onShowItems={(filter) => {
                      props.onItemFilter(filter);
                      props.onTab('items');
                    }}
                  />
                </div>
              )}
              {tab === 'items' && items && (
                <ItemsTab
                  items={items}
                  filter={props.itemFilter}
                  onFilter={props.onItemFilter}
                  search={props.itemSearch}
                  onSearch={props.onItemSearch}
                  onExport={props.onExportItems}
                />
              )}
              {tab === 'details' && (
                <dl className={`${styles.kv} ${styles.tabBody}`}>
                  {props.details.map(({ label, value }) => (
                    <div key={label} className={styles.kvRow}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Tabs>
          )}
        </motion.div>
      </AnimatePresence>
    </DockedPane>
  );
}

/** The Details tab's Sender: its name, then its address. */
export function SenderDetail({ sender }: { sender: SenderRef | null }) {
  if (!sender) return 'Not given to a Sender yet';
  return (
    <span className={styles.senderDetail}>
      {sender.name ?? <span className={styles.muted}>No longer configured</span>}
      <MonoValue value={sender.address} />
    </span>
  );
}
