import { useMemo } from 'react';

import { FlowGraph } from '../components/FlowGraph';
import { DISPATCHES, FIXTURE_TODAY, type GalleryDispatch } from '../console/fixtures';
import { DispatchList } from '../console/gallery/DispatchList';
import { DispatchPane } from '../console/gallery/DispatchPane';
import { Sidebar } from '../console/gallery/Sidebar';
import { presetRange } from '../domain/dateRange';
import styles from './console.module.css';

// The recorded Dispatches from the console gallery, minus the held one: Flag Rules are not shipped yet.
const RECORDED = DISPATCHES.filter((d) => d.status !== 'held');
const RANGE = presetRange('7d', FIXTURE_TODAY);
const NONE: ReadonlySet<string> = new Set();
const ignore = () => {};

function recorded(id: string): GalleryDispatch {
  const dispatch = RECORDED.find((d) => d.id === id);
  if (!dispatch) throw new Error(`no recorded Dispatch ${id}`);
  return dispatch;
}

/** The 37-payment Bulk Call whose flow has a fee-bump branch. */
const FEE_BUMPED = '7f3a91c2';
const LARGE = 'a40d6e93';
const AWAITING_APPROVAL = 'c09e5d17';

function List({ landed, selected }: { landed: boolean; selected: string | null }) {
  const rows = useMemo(
    () =>
      landed
        ? RECORDED.map((d) => (d.id === FEE_BUMPED ? { ...d, status: 'confirmed' as const } : d))
        : RECORDED,
    [landed],
  );
  return (
    <DispatchList
      rows={rows}
      selected={selected}
      onSelect={ignore}
      checked={NONE}
      onCheck={ignore}
      range={RANGE}
      onRange={ignore}
      chain="all"
      onChain={ignore}
      search=""
      onSearch={ignore}
      onExport={ignore}
    />
  );
}

/** The Dispatches screen as the console renders it: sidebar, list, and the docked pane on its flow. */
export function ConsoleScreen({ landed }: { landed: boolean }) {
  return (
    <div className={styles.screen}>
      <Sidebar />
      <List landed={landed} selected={LARGE} />
      <DispatchPane
        dispatch={recorded(LARGE)}
        tab="flow"
        onTab={ignore}
        showItems={ignore}
        itemFilter="all"
        onItemFilter={ignore}
        itemSearch=""
        onItemSearch={ignore}
        onExportItems={ignore}
        onClose={ignore}
        onCancel={ignore}
      />
    </div>
  );
}

export function DispatchRows() {
  return (
    <div className={styles.listCrop}>
      <List landed={false} selected={null} />
    </div>
  );
}

/** The console sidebar, whose Sender cards show balance, committed funds and who signs. */
export function SidebarView() {
  return (
    <div className={styles.sidebar}>
      <Sidebar />
    </div>
  );
}

export function Flow({ id }: { id: 'fee-bump' | 'approval' }) {
  const dispatch = recorded(id === 'fee-bump' ? FEE_BUMPED : AWAITING_APPROVAL);
  return (
    <div className={styles.flow}>
      <FlowGraph flow={dispatch.flowFor(ignore)} />
    </div>
  );
}
