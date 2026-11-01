import { List } from '@phosphor-icons/react';
import { createContext, type ReactNode, useContext, useState } from 'react';

import { Button } from '../components/Button';
import { Sheet } from '../motion/Overlay';
import styles from './console.module.css';
import { useLive } from './live';
import { useRouter } from './router';
import { SidebarSenders } from './senderData';
import { useSession } from './session';
import { Sidebar } from './Sidebar';

const MenuContext = createContext<() => void>(() => {});

/** The sidebar beside the page; on a phone, a sheet behind the page bar's menu button. */
export function Shell({ children }: { children: ReactNode }) {
  const { page, navigate } = useRouter();
  const { connection, refresh } = useLive();
  const { signOut } = useSession();
  const [menu, setMenu] = useState(false);

  const sidebar = (
    <Sidebar
      current={page}
      instance={window.location.host}
      connection={connection}
      onRefresh={refresh}
      onNavigate={(next) => {
        setMenu(false);
        navigate(next);
      }}
      onSignOut={signOut}
      senders={
        <SidebarSenders
          onOpen={() => {
            setMenu(false);
            navigate('senders');
          }}
        />
      }
    />
  );

  return (
    <MenuContext.Provider value={() => setMenu(true)}>
      <div className={styles.shell}>
        <div className={styles.sidebarSlot}>{sidebar}</div>
        {children}
      </div>
      <Sheet open={menu} onClose={() => setMenu(false)} title="Menu">
        <div className={styles.sheetSidebar}>{sidebar}</div>
      </Sheet>
    </MenuContext.Provider>
  );
}

/** The 52 px bar on top of every page: its title on the left, its controls on the right. */
export function PageBar({ title, children }: { title: string; children?: ReactNode }) {
  const openMenu = useContext(MenuContext);
  return (
    <div className={styles.pageBar}>
      <span className={styles.menuButton}>
        <Button variant="quiet" icon aria-label="Open the menu" onClick={openMenu}>
          <List size={16} aria-hidden="true" />
        </Button>
      </span>
      <h1 className={styles.pageTitle}>{title}</h1>
      {children && <div className={styles.controls}>{children}</div>}
    </div>
  );
}
