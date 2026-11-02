/** Runs a command and says whether it exited 0, with its stdout. Never throws. */
export type Probe = (
  command: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stdout: string }>;

/** The machine init runs on: its platform and, on Linux, the `ID` and `ID_LIKE` of /etc/os-release. */
export type Machine = { platform: NodeJS.Platform; nodeVersion: string; linuxIds?: string[] };

export type Prerequisite = 'node' | 'pnpm' | 'docker' | 'compose' | 'docker-running';

export type Missing = { what: Prerequisite; problem: string; fix: string[] };

const MIN_NODE_MAJOR = 22;

/**
 * What init needs and this machine lacks, each with how to get it here.
 * Docker is needed only to start the services, so `needDocker` is false
 * under `--no-start`.
 */
export async function findMissing(
  probe: Probe,
  machine: Machine,
  { needDocker }: { needDocker: boolean },
): Promise<Missing[]> {
  const missing: Missing[] = [];
  const nodeMajor = Number(machine.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (!(nodeMajor >= MIN_NODE_MAJOR)) {
    missing.push(
      lack(
        machine,
        'node',
        `Node ${MIN_NODE_MAJOR} or later is needed; this is Node ${machine.nodeVersion}`,
      ),
    );
  }
  if (!(await probe('pnpm', ['--version'])).ok) {
    missing.push(lack(machine, 'pnpm', 'pnpm is not installed'));
  }
  if (!needDocker) return missing;

  if (!(await probe('docker', ['--version'])).ok) {
    missing.push(lack(machine, 'docker', 'Docker is not installed'));
    return missing;
  }
  if (!(await probe('docker', ['compose', 'version'])).ok) {
    missing.push(
      lack(machine, 'compose', 'Docker Compose (the `docker compose` plugin) is not installed'),
    );
  }
  if (!(await probe('docker', ['info'])).ok) {
    missing.push(lack(machine, 'docker-running', 'Docker is installed but not running'));
  }
  return missing;
}

function lack(machine: Machine, what: Prerequisite, problem: string): Missing {
  return { what, problem, fix: howToGet(what, machine) };
}

const DOCKER_DESKTOP_MAC = 'https://docs.docker.com/desktop/setup/install/mac-install/';
const WSL = 'https://learn.microsoft.com/windows/wsl/install';

type LinuxFamily = 'debian' | 'fedora' | 'arch' | 'other';

function linuxFamily(ids: readonly string[] = []): LinuxFamily {
  if (ids.some((id) => ['debian', 'ubuntu'].includes(id))) return 'debian';
  if (ids.some((id) => ['fedora', 'rhel', 'centos'].includes(id))) return 'fedora';
  if (ids.includes('arch')) return 'arch';
  return 'other';
}

const LINUX_PACKAGES: Record<LinuxFamily, Record<'node' | 'compose', string>> = {
  debian: {
    node: 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs',
    compose: 'sudo apt-get install -y docker-compose-plugin',
  },
  fedora: {
    node: 'sudo dnf install -y nodejs22',
    compose: 'sudo dnf install -y docker-compose-plugin',
  },
  arch: { node: 'sudo pacman -S nodejs npm', compose: 'sudo pacman -S docker-compose' },
  other: {
    node: 'install Node 22 from https://nodejs.org/en/download/package-manager',
    compose: 'install the Compose plugin: https://docs.docker.com/compose/install/linux/',
  },
};

/** The commands or links that get `what` onto this machine. */
export function howToGet(what: Prerequisite, machine: Machine): string[] {
  if (machine.platform === 'win32') {
    return [`run init inside WSL 2 (${WSL}), with Docker Desktop's WSL integration turned on`];
  }
  if (machine.platform === 'darwin') {
    return {
      node: ['brew install node@22'],
      pnpm: ['brew install pnpm'],
      docker: [`install Docker Desktop: ${DOCKER_DESKTOP_MAC}`, 'or: brew install --cask docker'],
      compose: [`Docker Desktop includes Compose: ${DOCKER_DESKTOP_MAC}`],
      'docker-running': ['open Docker Desktop and wait until it says it is running'],
    }[what];
  }
  const family = linuxFamily(machine.linuxIds);
  return {
    node: [LINUX_PACKAGES[family].node],
    pnpm: ['npm install -g pnpm@10'],
    docker: ['curl -fsSL https://get.docker.com | sh   # Docker Engine and the Compose plugin'],
    compose: [LINUX_PACKAGES[family].compose],
    'docker-running': ['sudo systemctl start docker'],
  }[what];
}

export function describeMissing(missing: readonly Missing[]): string {
  const lines = ['init needs these first:', ''];
  for (const { problem, fix } of missing) {
    lines.push(`  ${problem}`);
    for (const step of fix) lines.push(`    ${step}`);
  }
  lines.push('', 'Install them, then run pnpm dispatch init again.');
  return `${lines.join('\n')}\n`;
}
