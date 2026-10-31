import { AnimatePresence, motion } from 'motion/react';

import { Amount } from '../../components/Amount';
import { Button } from '../../components/Button';
import { DockedPane } from '../../components/DockedPane';
import { FlowGraph } from '../../components/FlowGraph';
import { MonoValue } from '../../components/MonoValue';
import { StatusPill } from '../../components/StatusPill';
import { Tabs } from '../../components/Tabs';
import { CHAINS } from '../../domain/chains';
import type { Item } from '../../domain/dispatch';
import type { ExportFormat } from '../../export/download';
import { fade } from '../../motion/transitions';
import type { GalleryDispatch, ShowItems } from '../fixtures';
import styles from './Gallery.module.css';
import { type ItemFilter, ItemsTab } from './ItemsTab';

export type PaneTab = 'flow' | 'items' | 'details';

const TABS = [
  { id: 'flow', label: 'Flow' },
  { id: 'items', label: 'Items' },
  { id: 'details', label: 'Details' },
] as const;

const clock = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface DispatchPaneProps {
  dispatch: GalleryDispatch;
  tab: PaneTab;
  onTab: (tab: PaneTab) => void;
  showItems: ShowItems;
  itemFilter: ItemFilter;
  onItemFilter: (filter: ItemFilter) => void;
  itemSearch: string;
  onItemSearch: (search: string) => void;
  onExportItems: (format: ExportFormat, rows: readonly Item[]) => void;
  onClose: () => void;
  onCancel: () => void;
}

export function DispatchPane(props: DispatchPaneProps) {
  const { dispatch } = props;
  const total = dispatch.totals[0]!;
  const firstHash = dispatch.items.find((item) => item.transactionHash)?.transactionHash ?? null;
  const cancellable = dispatch.claimedAt === null && dispatch.status !== 'cancelled';

  return (
    <DockedPane
      title={dispatch.mode === 'relay' ? 'Relay Dispatch' : 'Managed Dispatch'}
      meta={<MonoValue value={dispatch.id} />}
      label="Dispatch detail"
      onClose={props.onClose}
      footer={
        <>
          {firstHash ? (
            <Button
              variant="secondary"
              href={CHAINS[dispatch.chain].txUrl(firstHash)}
              target="_blank"
              rel="noreferrer"
            >
              Open in explorer
            </Button>
          ) : (
            <Button variant="secondary" disabled>
              Open in explorer
            </Button>
          )}
          <Button
            variant="danger"
            className={styles.pushRight}
            disabled={!cancellable}
            onClick={props.onCancel}
          >
            Cancel Dispatch
          </Button>
        </>
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={dispatch.id}
          className={styles.paneInner}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
        >
          <div className={styles.summary}>
            <div className={styles.muted}>{dispatch.when}</div>
            <div className={styles.summaryLine}>
              <span className={styles.summaryName}>
                {dispatch.label ?? `${dispatch.itemCount} payments`}
              </span>
              <span className={styles.summaryTotal}>
                <Amount {...total} variant="raised" />
              </span>
            </div>
            <div className={styles.summaryPill}>
              <StatusPill status={dispatch.status} />
            </div>
          </div>
          <Tabs label="Dispatch views" tabs={TABS} value={props.tab} onChange={props.onTab}>
            {props.tab === 'flow' && (
              <div className={styles.tabBody}>
                <FlowGraph flow={dispatch.flowFor(props.showItems)} />
              </div>
            )}
            {props.tab === 'items' && (
              <ItemsTab
                items={dispatch.items}
                filter={props.itemFilter}
                onFilter={props.onItemFilter}
                search={props.itemSearch}
                onSearch={props.onItemSearch}
                onExport={props.onExportItems}
              />
            )}
            {props.tab === 'details' && (
              <dl className={`${styles.kv} ${styles.tabBody}`}>
                <dt>Chain</dt>
                <dd>{CHAINS[dispatch.chain].label}</dd>
                <dt>Sender</dt>
                <dd>
                  {dispatch.sender.includes(' ') ? (
                    dispatch.sender
                  ) : (
                    <MonoValue value={dispatch.sender} />
                  )}
                </dd>
                <dt>Items</dt>
                <dd>{dispatch.itemCount.toLocaleString('en-US')}</dd>
                <dt>Retry policy</dt>
                <dd>{dispatch.retryPolicy}</dd>
                <dt>Bulk Call</dt>
                <dd>{dispatch.bulkCall}</dd>
                <dt>Created</dt>
                <dd>{clock.format(dispatch.createdAt)}</dd>
                <dt>Claimed</dt>
                <dd>{dispatch.claimedAt ? clock.format(dispatch.claimedAt) : 'Not yet'}</dd>
                <dt>Idempotency-Key</dt>
                <dd>
                  <MonoValue value={dispatch.idempotencyKey} head={14} tail={6} />
                </dd>
              </dl>
            )}
          </Tabs>
        </motion.div>
      </AnimatePresence>
    </DockedPane>
  );
}
