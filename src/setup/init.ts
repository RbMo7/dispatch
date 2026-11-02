import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { configFrom, type Env } from '../config.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import { parseSenderName, type SenderName } from '../domain/sender.js';
import {
  Cancelled,
  InitError,
  interactiveAsker,
  scriptedAsker,
  withFlags,
  type Asker,
  type Flags,
} from './init-ask.js';
import {
  addressesToFund,
  backendsIn,
  chainEnv,
  clearedSenderVariables,
  CONTAINER_SIGNER_CONFIG,
  CURVE,
  databaseEnv,
  DEFAULT_RPC,
  describeChains,
  DEV_KEYS,
  FAUCETS,
  isChainAddress,
  NETWORK_NAMES,
  networkOf,
  sameAddress,
  tokenEnv,
  updateSignerConfig,
  type ChainChoice,
  type Database,
  type HeldKey,
  type Network,
  type SenderShape,
  type Signing,
} from './init-plan.js';
import {
  composeCommands,
  composeReadiness,
  startServices,
  type Readiness,
  type Runner,
} from './init-services.js';
import { clackUi, plainUi, type Ui } from './init-ui.js';
import { parseEnvText, updateEnvText, writePrivateFile } from './env-file.js';
import { describeMissing, findMissing, type Machine, type Probe } from './prerequisites.js';
import {
  entryFromVariables,
  senderEntry,
  senderNames,
  VARIABLES_SENDER_NAME,
  withDefault,
  withSender,
  type SendersFile,
} from './senders-file.js';
import { readSettings, type SenderSetup, type Settings } from './settings.js';
import { CHAIN_NAMES } from './wording.js';

type Output = { write: (text: string) => unknown };

export type InitIo = {
  /** Where `.env` and `signer/local/` live: the repository root. */
  root: string;
  /** The Signer package, whose own `keys new` creates a local key. */
  signerPackage: string;
  stdout: Output;
  stderr: Output;
  env: Env;
  /** Both stdin and stdout are a terminal. */
  terminal: boolean;
  machine: Machine;
  probe: Probe;
  run: Runner;
  readiness?: Readiness;
  /** `pnpm dispatch doctor` against `env`, printing its report; resolves to its exit code. */
  runDoctor: (env: Env) => Promise<number>;
  now: () => Date;
  randomToken: () => string;
  /** The interactive prompts and output; the terminal ones unless a test replaces them. */
  interactive?: { ask: Asker; ui: Ui };
};

export const INIT_EXIT = { ok: 0, problems: 1, cannotRun: 2, cancelled: 130 } as const;

export const INIT_USAGE = `Usage: pnpm dispatch init [--yes] [options]

Sets up this engine: asks which chains to run and how each Sender signs,
writes the Signer config and .env, starts the services and ends with doctor.
Run it again to change one part, add a chain or add a named Sender to a
chain; it keeps everything else.

  --yes                         no prompts: each question takes its default or its flag
  --chains <solana,base>        chains to enable
  --<chain>-network <name>      solana: devnet or mainnet; base: sepolia or mainnet
  --confirm-mainnet             needed with --yes to choose mainnet
  --<chain>-rpc <url>           the chain's RPC URL (default: the network's public RPC)
  --<chain>-signer <backend>    local (a new encrypted key), privy, aws-kms, or keyfile (dev only)
  --<chain>-key-ref <id>        privy: the wallet id; aws-kms: the key id or ARN
  --<chain>-address <address>   privy, aws-kms: the key's address
  --solana-sender <plain|squads>, --solana-multisig <address>
  --base-sender <plain|safe>,     --base-safe <address>
  --<chain>-sender-name <name>  add a named Sender to the chain, beside the ones it has,
                                in the senders file (SENDERS_FILE, default senders.json)
  --<chain>-default <name>      the Sender a Dispatch that names none pays from
  --database <compose|url>      Compose's Postgres (default) or a postgres:// URL
  --start, --no-start           start the services with Docker Compose (default: start)

A new local key's passphrase is read from the terminal, or with --yes from
SIGNER_KEYSTORE_PASSPHRASE. It is never a flag and never written to a file.
`;

const CHAIN_FLAGS = ['network', 'rpc', 'signer', 'key-ref', 'address', 'sender'] as const;
const MULTISIG_FLAG: Record<Chain, string> = { solana: 'solana-multisig', base: 'base-safe' };

function parseFlags(args: readonly string[]): { yes: boolean; help: boolean; flags: Flags } {
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    yes: { type: 'boolean' },
    help: { type: 'boolean' },
    chains: { type: 'string' },
    database: { type: 'string' },
    'confirm-mainnet': { type: 'boolean' },
    start: { type: 'boolean' },
    'no-start': { type: 'boolean' },
  };
  for (const chain of CHAINS) {
    for (const flag of [...CHAIN_FLAGS, 'sender-name', 'default']) {
      options[`${chain}-${flag}`] = { type: 'string' };
    }
    options[MULTISIG_FLAG[chain]] = { type: 'string' };
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({ args: [...args], options, strict: true, allowPositionals: false }));
  } catch (cause) {
    throw new InitError(cause instanceof Error ? cause.message : String(cause));
  }
  if (values.start === true && values['no-start'] === true) {
    throw new InitError('--start and --no-start contradict each other');
  }
  const start = values['no-start'] === true ? false : values.start === true ? true : undefined;
  return {
    yes: values.yes === true,
    help: values.help === true,
    flags: { ...values, start },
  };
}

/** Runs `pnpm dispatch init`; resolves to the exit code. */
export async function init(args: readonly string[], io: InitIo): Promise<number> {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(args);
  } catch (cause) {
    io.stderr.write(`init: ${(cause as Error).message}\n\n${INIT_USAGE}`);
    return INIT_EXIT.cannotRun;
  }
  if (parsed.help) {
    io.stdout.write(INIT_USAGE);
    return INIT_EXIT.ok;
  }
  if (!parsed.yes && !io.terminal) {
    io.stderr.write('init: no terminal to ask questions in. Run it with --yes and flags.\n');
    return INIT_EXIT.cannotRun;
  }

  const missing = await findMissing(io.probe, io.machine, {
    needDocker: parsed.flags.start !== false,
  });
  if (missing.length > 0) {
    io.stderr.write(describeMissing(missing));
    if (
      parsed.flags.start !== false &&
      missing.every((m) => m.what !== 'node' && m.what !== 'pnpm')
    ) {
      io.stderr.write('To write the configuration without starting anything, add --no-start.\n');
    }
    return INIT_EXIT.cannotRun;
  }

  const interactive = parsed.yes
    ? undefined
    : (io.interactive ?? { ask: interactiveAsker(), ui: clackUi() });
  const ui = interactive?.ui ?? plainUi(io.stdout);
  const ask = withFlags(parsed.flags, interactive?.ask ?? scriptedAsker());
  try {
    return await setUp(io, ui, ask, parsed.flags);
  } catch (cause) {
    if (cause instanceof Cancelled) {
      ui.outro('Stopped. Nothing was written.');
      return INIT_EXIT.cancelled;
    }
    if (cause instanceof InitError) {
      io.stderr.write(`init: ${cause.message}\n`);
      return INIT_EXIT.cannotRun;
    }
    throw cause;
  }
}

type Files = {
  envPath: string;
  envText: string;
  signerDir: string;
  signerConfigPath: string;
  keystore: string;
  signerConfig: Record<string, unknown>;
  /** SENDERS_FILE, or `senders.json`, under the root. */
  sendersPath: string;
  /** The senders file (ADR-0060); undefined while there is none and today's variables describe the Senders. */
  senders: SendersFile | undefined;
};

function readFiles(root: string): Files {
  const envPath = path.join(root, '.env');
  const example = path.join(root, '.env.example');
  const envText = existsSync(envPath)
    ? readFileSync(envPath, 'utf8')
    : existsSync(example)
      ? readFileSync(example, 'utf8')
      : '';
  const signerDir = path.join(root, 'signer', 'local');
  const signerConfigPath = path.join(signerDir, 'signer.config.json');
  let signerConfig: Record<string, unknown> = {};
  if (existsSync(signerConfigPath)) {
    try {
      signerConfig = JSON.parse(readFileSync(signerConfigPath, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new InitError(
        `${signerConfigPath} is not valid JSON; fix or move it, then run init again`,
      );
    }
  }
  const sendersPath = path.resolve(
    root,
    parseEnvText(envText).SENDERS_FILE?.trim() || 'senders.json',
  );
  let senders: Files['senders'];
  if (existsSync(sendersPath)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(sendersPath, 'utf8'));
    } catch {
      json = undefined;
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new InitError(
        `${sendersPath} is not a JSON object; fix or move it, then run init again`,
      );
    }
    senders = json as SendersFile;
  }
  return {
    envPath,
    envText,
    signerDir,
    signerConfigPath,
    keystore: path.join(signerDir, 'keystore'),
    signerConfig,
    sendersPath,
    senders,
  };
}

/** The settings as the engine would read them from `env` and the senders file under the root. */
function settingsAt(env: Env, files: Pick<Files, 'sendersPath'>): Settings {
  return readSettings(configFrom(env), () =>
    existsSync(files.sendersPath)
      ? { kind: 'file', path: files.sendersPath, text: readFileSync(files.sendersPath, 'utf8') }
      : { kind: 'variables' },
  );
}

type NetworkChoice = Pick<ChainChoice, 'network' | 'rpcUrl'>;

/** Which network a chain runs on and its RPC, given which flags answer it. */
async function askNetwork(ask: Asker, flags: Flags, chain: Chain): Promise<NetworkChoice> {
  const name = CHAIN_NAMES[chain];
  let network: Network;
  for (;;) {
    network = await ask.select<Network>({
      flag: `${chain}-network`,
      message: `${name} network`,
      options: [
        {
          value: 'test',
          label: NETWORK_NAMES[chain].test,
          flag: chain === 'solana' ? 'devnet' : 'sepolia',
        },
        { value: 'main', label: NETWORK_NAMES[chain].main, hint: 'real funds', flag: 'mainnet' },
      ],
      initial: 'test',
    });
    if (network === 'test' || (await ask.mainnet(name))) break;
    if (flags[`${chain}-network`] !== undefined) {
      throw new InitError(`${name} mainnet was not confirmed`);
    }
  }

  const rpcUrl = await ask.text({
    flag: `${chain}-rpc`,
    message: `${name} RPC URL`,
    initial: DEFAULT_RPC[chain][network],
    validate: (value) =>
      /^https?:\/\//.test(value) && URL.canParse(value) ? undefined : 'an http:// or https:// URL',
  });
  return { network, rpcUrl };
}

/** The network and RPC a chain already runs on, for a Sender added to it. A Solana RPC whose URL doesn't say counts as mainnet, so the dev keyfile is never offered for it. */
function currentNetwork(chain: Chain, env: Env): NetworkChoice {
  const config = configFrom(env);
  return {
    network: networkOf(chain, env) ?? 'main',
    rpcUrl: chain === 'solana' ? config.solana.rpcUrl : config.base.rpcUrl,
  };
}

/** How one Sender signs and what kind it is. `senderName` is set for a named Sender (ADR-0060). */
async function askSender(
  ask: Asker,
  chain: Chain,
  network: Network,
  senderName?: SenderName,
): Promise<Pick<ChainChoice, 'signing' | 'sender'>> {
  const name = CHAIN_NAMES[chain];
  const which = senderName === undefined ? `${name} Sender` : `${name} Sender "${senderName}"`;
  const backend = await ask.select<Signing['backend']>({
    flag: `${chain}-signer`,
    message: `How does the ${which} sign?`,
    options: [
      { value: 'local', label: 'A new local encrypted key', hint: "made by the Signer's keys new" },
      { value: 'privy', label: 'An existing Privy wallet' },
      { value: 'aws-kms', label: 'An existing AWS KMS key' },
      ...(network === 'test'
        ? [
            {
              value: 'keyfile' as const,
              label: 'The dev keyfile',
              hint: 'development only: committed keys',
            },
          ]
        : []),
    ],
    initial: 'local',
    noScriptedDefault: true,
  });
  if (backend === 'keyfile' && network === 'main') {
    throw new InitError('the keyfile backend holds committed dev keys and is never for mainnet');
  }
  let signing: Signing = { backend } as Signing;
  if (backend === 'privy' || backend === 'aws-kms') {
    const keyRef = await ask.text({
      flag: `${chain}-key-ref`,
      message: backend === 'privy' ? 'Privy wallet id' : 'AWS KMS key id, key ARN or alias ARN',
      validate: (value) => (value.trim() ? undefined : 'cannot be empty'),
    });
    const address = await ask.text({
      flag: `${chain}-address`,
      message: `The key's ${name} address`,
      ...(backend === 'aws-kms'
        ? { placeholder: 'if unsure, the Signer prints the address it derives at startup' }
        : {}),
      validate: (value) => (isChainAddress(chain, value) ? undefined : `not a ${name} address`),
    });
    signing = { backend, keyRef: keyRef.trim(), address };
  }

  const multisigKind = chain === 'solana' ? 'squads' : 'safe';
  const kind = await ask.select<'plain' | 'squads' | 'safe'>({
    flag: `${chain}-sender`,
    message: `What kind of ${which}?`,
    options: [
      { value: 'plain', label: 'A plain wallet', hint: 'the key pays directly' },
      chain === 'solana'
        ? { value: 'squads', label: 'A Squads multisig', hint: 'Approvers approve each transfer' }
        : { value: 'safe', label: 'A Safe', hint: 'owners approve each transfer' },
    ],
    initial: 'plain',
  });
  let sender: SenderShape = { kind: 'plain' };
  if (kind === multisigKind) {
    const address = await ask.text({
      flag: MULTISIG_FLAG[chain],
      message:
        chain === 'solana' ? 'The Squads multisig account (not its vault)' : 'The Safe address',
      validate: (value) => (isChainAddress(chain, value) ? undefined : `not a ${name} address`),
    });
    sender =
      chain === 'solana' ? { kind: 'squads', multisig: address } : { kind: 'safe', safe: address };
  }
  return { signing, sender };
}

async function askDatabase(
  ask: Asker,
  flags: Flags,
  firstRun: boolean,
): Promise<Database | undefined> {
  const given = flags.database;
  if (typeof given === 'string') {
    if (given === 'compose') return { kind: 'compose' };
    if (/^postgres(ql)?:\/\//.test(given) && URL.canParse(given))
      return { kind: 'url', url: given };
    throw new InitError('--database must be compose or a postgres:// URL');
  }
  if (!firstRun && (await ask.confirm({ message: 'Keep the database as it is?', initial: true }))) {
    return undefined;
  }
  const kind = await ask.select<'compose' | 'url'>({
    message: 'Database',
    options: [
      { value: 'compose', label: "Compose's Postgres", hint: 'localhost:5432' },
      { value: 'url', label: 'Another Postgres', hint: 'enter its URL' },
    ],
    initial: 'compose',
  });
  if (kind === 'compose') return { kind };
  const url = await ask.text({
    message: 'Postgres URL',
    placeholder: 'postgres://user:password@host:5432/dispatch',
    validate: (value) =>
      /^postgres(ql)?:\/\//.test(value) && URL.canParse(value) ? undefined : 'a postgres:// URL',
  });
  return { kind: 'url', url };
}

function freeKeyName(keystore: string, wanted: string): string {
  const taken = (name: string) => existsSync(path.join(keystore, `${name}.json`));
  if (!taken(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken(`${wanted}-${n}`)) return `${wanted}-${n}`;
}

const KEY_NAMES: Record<SenderShape['kind'], (chain: Chain) => string> = {
  plain: (chain) => `${chain}-sender`,
  squads: () => 'squads-member',
  safe: () => 'safe-executor',
};

/** Creates a key with the Signer's own `keys new`: the key never passes through this process. */
async function newLocalKey(
  io: InitIo,
  ui: Ui,
  files: Files,
  choice: ChainChoice,
  passphrase: string,
): Promise<HeldKey> {
  if (!existsSync(path.join(io.signerPackage, 'node_modules'))) {
    const install = ui.progress("Installing the Signer's packages (pnpm --dir signer install)");
    const installed = await io.run('pnpm', [
      '--dir',
      io.signerPackage,
      'install',
      '--frozen-lockfile',
    ]);
    if (installed.code !== 0) {
      install.failed('pnpm --dir signer install failed');
      throw new InitError(`installing the Signer's packages failed:\n${installed.stderr.trim()}`);
    }
    install.done("Installed the Signer's packages");
  }
  mkdirSync(files.keystore, { recursive: true, mode: 0o700 });
  const name = freeKeyName(
    files.keystore,
    choice.name === undefined
      ? KEY_NAMES[choice.sender.kind](choice.chain)
      : `${choice.chain}-${choice.name}`,
  );
  const progress = ui.progress(`Creating the ${choiceLabel(choice)} key "${name}"`);
  const result = await io.run(
    'pnpm',
    [
      '--silent',
      '--dir',
      io.signerPackage,
      'signer',
      'keys',
      'new',
      '--curve',
      CURVE[choice.chain],
      '--name',
      name,
    ],
    {
      env: {
        ...io.env,
        SIGNER_KEYSTORE_DIR: files.keystore,
        SIGNER_KEYSTORE_PASSPHRASE: passphrase,
        // The Signer refuses both a passphrase and a passphrase file.
        SIGNER_KEYSTORE_PASSPHRASE_FILE: undefined,
      },
    },
  );
  const address = result.stdout.trim().split('\n').at(-1)?.trim() ?? '';
  if (result.code !== 0 || !isChainAddress(choice.chain, address)) {
    progress.failed('keys new failed');
    throw new InitError(
      `the Signer's keys new failed: ${result.stderr.trim() || 'no address printed'}`,
    );
  }
  progress.done(`Created the ${choiceLabel(choice)} key "${name}": ${address}`);
  return { address, backend: 'local', keyRef: name };
}

function choiceLabel({ chain, name }: ChainChoice): string {
  return name === undefined ? CHAIN_NAMES[chain] : `${CHAIN_NAMES[chain]} "${name}"`;
}

function keystoreHasKeys(keystore: string): boolean {
  return existsSync(keystore) && readdirSync(keystore).some((file) => file.endsWith('.json'));
}

/** A Sender set up in this run, and the engine key it takes over from, if any. */
type Planned = { choice: ChainChoice; replaces?: string };

/** The name a Sender has, or will have, in the senders file. */
function fileName(sender: SenderSetup): SenderName {
  return sender.name ?? VARIABLES_SENDER_NAME;
}

const NAME_RULE = '1 to 40 lowercase letters, digits or hyphens';

/**
 * The Senders to set up on one enabled chain; none when it is kept as it
 * is. `--<chain>-sender-name`, or the prompt after keeping a chain, adds a
 * named Sender beside the ones it has (ADR-0060).
 */
async function askChainSenders(
  ask: Asker,
  flags: Flags,
  chain: Chain,
  context: {
    existing: readonly SenderSetup[];
    held: (sender: SenderSetup) => boolean;
    fileEnv: Env;
    fileMode: boolean;
  },
): Promise<Planned[]> {
  const { existing, held, fileEnv, fileMode } = context;
  const replacing = (sender: SenderSetup | undefined) =>
    sender?.accounts ? { replaces: sender.accounts.feePayer } : {};
  const named = async (name: SenderName, network: NetworkChoice): Promise<ChainChoice> => ({
    chain,
    ...network,
    name,
    ...(await askSender(ask, chain, network.network, name)),
  });

  const flaggedName = flags[`${chain}-sender-name`];
  if (typeof flaggedName === 'string') {
    const name = parseSenderName(flaggedName);
    if (!name) throw new InitError(`--${chain}-sender-name must be ${NAME_RULE}`);
    const same = existing.find((sender) => fileName(sender) === name);
    const keep =
      same !== undefined &&
      (await ask.confirm({
        message: `Keep the ${CHAIN_NAMES[chain]} Sender "${name}" as it is?`,
        initial: true,
      }));
    if (keep) return [];
    const network =
      existing.length > 0 ? currentNetwork(chain, fileEnv) : await askNetwork(ask, flags, chain);
    return [{ choice: await named(name, network), ...replacing(same) }];
  }

  const flagged =
    CHAIN_FLAGS.some((flag) => flags[`${chain}-${flag}`] !== undefined) ||
    flags[MULTISIG_FLAG[chain]] !== undefined;
  const keep =
    existing.some(held) &&
    !flagged &&
    (await ask.confirm({
      message: `Keep the ${CHAIN_NAMES[chain]} setup as it is?`,
      initial: true,
    }));
  if (!keep) {
    // A chain's own questions change its default Sender; a named one is added by name.
    const target = existing.find((sender) => sender.isDefault) ?? existing[0];
    const network = await askNetwork(ask, flags, chain);
    if (fileMode) {
      const name = target ? fileName(target) : VARIABLES_SENDER_NAME;
      return [{ choice: await named(name, network), ...replacing(target) }];
    }
    const choice = { chain, ...network, ...(await askSender(ask, chain, network.network)) };
    return [{ choice, ...replacing(target) }];
  }

  const add = await ask.confirm({
    message: `Add another ${CHAIN_NAMES[chain]} Sender, with its own key?`,
    initial: false,
  });
  if (!add) return [];
  const taken = existing.map(fileName);
  const name = parseSenderName(
    await ask.text({
      message: 'Its name, which a request gives as "sender"',
      placeholder: 'such as refunds or treasury',
      validate: (value) =>
        !parseSenderName(value)
          ? NAME_RULE
          : taken.includes(value as SenderName)
            ? `${CHAIN_NAMES[chain]} already has a Sender named "${value}"`
            : undefined,
    }),
  )!;
  return [{ choice: await named(name, currentNetwork(chain, fileEnv)) }];
}

/** With more than one Sender on a chain, which one a Dispatch that names none pays from. */
async function askDefaults(
  ask: Asker,
  flags: Flags,
  enabled: readonly Chain[],
  file: SendersFile,
  choices: readonly ChainChoice[],
): Promise<Map<Chain, SenderName>> {
  const defaults = new Map<Chain, SenderName>();
  for (const chain of enabled) {
    const changed = choices.filter((choice) => choice.chain === chain);
    const names = [
      ...new Set([...senderNames(file, chain), ...changed.map((choice) => choice.name!)]),
    ];
    if (names.length < 2 || (changed.length === 0 && flags[`${chain}-default`] === undefined)) {
      continue;
    }
    const current = file[chain]?.default;
    defaults.set(
      chain,
      await ask.select<SenderName>({
        flag: `${chain}-default`,
        message: `Which ${CHAIN_NAMES[chain]} Sender pays a Dispatch that names none?`,
        options: names.map((name) => ({ value: name, label: name })),
        initial: names.find((name) => name === current) ?? names[0]!,
      }),
    );
  }
  return defaults;
}

async function setUp(io: InitIo, ui: Ui, ask: Asker, flags: Flags): Promise<number> {
  ui.intro('Dispatch setup');
  const files = readFiles(io.root);
  const fileEnv = parseEnvText(files.envText);
  const settings = settingsAt(fileEnv, files);
  const signerEntryFor = (address: string) => {
    const key = Object.keys(files.signerConfig).find((k) => sameAddress(k, address));
    return key === undefined ? undefined : (files.signerConfig[key] as { backend?: string });
  };
  /** A Sender counts as set up once it is configured and the Signer config holds its key. */
  const held = (sender: SenderSetup) =>
    sender.accounts !== undefined && signerEntryFor(sender.accounts.feePayer) !== undefined;
  const setUpChains = new Set(settings.senders.filter(held).map((sender) => sender.chain));
  const firstRun = setUpChains.size === 0;
  if (!firstRun) ui.note('Current setup', describeChains(fileEnv, settings, files.signerConfig));

  const enabled = await ask.multiselect<Chain>({
    flag: 'chains',
    message: 'Chains to enable',
    options: CHAINS.map((chain) => ({
      value: chain,
      label: CHAIN_NAMES[chain],
      ...(setUpChains.has(chain) ? { hint: 'set up' } : {}),
    })),
    initial: firstRun ? ['solana'] : [...setUpChains],
  });

  let planned: Planned[] = [];
  for (const chain of enabled) {
    planned.push(
      ...(await askChainSenders(ask, flags, chain, {
        existing: settings.senders.filter((sender) => sender.chain === chain),
        held,
        fileEnv,
        fileMode: files.senders !== undefined,
      })),
    );
  }
  // ADR-0060: a named Sender needs a senders file, and with one the engine reads every chain's Senders from it.
  const fileMode = files.senders !== undefined || planned.some(({ choice }) => choice.name);
  if (fileMode) {
    planned = planned.map(({ choice, ...rest }) => ({
      ...rest,
      choice: { ...choice, name: choice.name ?? VARIABLES_SENDER_NAME },
    }));
  }
  const choices = planned.map(({ choice }) => choice);

  let sendersFile: SendersFile = files.senders ?? {};
  if (fileMode && files.senders === undefined) {
    const config = configFrom(fileEnv);
    for (const sender of settings.senders) {
      const entry = entryFromVariables(sender, config);
      if (entry && enabled.includes(sender.chain)) {
        sendersFile = withSender(sendersFile, sender.chain, VARIABLES_SENDER_NAME, entry);
      }
    }
  }
  const defaults = fileMode
    ? await askDefaults(ask, flags, enabled, sendersFile, choices)
    : new Map<Chain, SenderName>();
  const database = await askDatabase(ask, flags, firstRun);

  const newKeys = choices.filter((choice) => choice.signing.backend === 'local');
  const start = await ask.confirm({
    flag: 'start',
    message: 'Start all services now?',
    initial: true,
  });
  const replaced = (address: string) =>
    planned.some(({ replaces }) => replaces !== undefined && sameAddress(replaces, address));
  const keptKeys = settings.senders.flatMap(({ accounts }) =>
    accounts && !replaced(accounts.feePayer) ? [accounts.feePayer] : [],
  );
  const plannedBackends = new Set([
    ...settings.senders
      .filter((sender) => enabled.includes(sender.chain) && held(sender))
      .flatMap(({ accounts }) =>
        replaced(accounts!.feePayer) ? [] : [signerEntryFor(accounts!.feePayer)?.backend ?? ''],
      ),
    ...choices.map((choice) => choice.signing.backend),
  ]);
  let passphrase: string | undefined;
  if (newKeys.length > 0 || (start && plannedBackends.has('local'))) {
    if (io.env.SIGNER_KEYSTORE_PASSPHRASE) {
      ui.info('Using the keystore passphrase in SIGNER_KEYSTORE_PASSPHRASE.');
      passphrase = io.env.SIGNER_KEYSTORE_PASSPHRASE;
    } else {
      passphrase = await ask.passphrase(!keystoreHasKeys(files.keystore));
    }
  }

  const heldKeys: HeldKey[] = [];
  for (const choice of choices) {
    const { signing } = choice;
    heldKeys.push(
      signing.backend === 'local'
        ? await newLocalKey(io, ui, files, choice, passphrase!)
        : signing.backend === 'keyfile'
          ? DEV_KEYS[choice.chain]
          : { address: signing.address, backend: signing.backend, keyRef: signing.keyRef },
    );
  }

  const changes = planned.map((plan, i) => ({ ...plan, key: heldKeys[i]! }));
  const signerConfig = updateSignerConfig(files.signerConfig, changes, [
    ...keptKeys,
    ...heldKeys.map((key) => key.address),
  ]);

  const tokens = tokenEnv(fileEnv, io.randomToken);
  const updates: Record<string, string> = {
    ENABLED_CHAINS: enabled.join(','),
    SIGNER_URL: fileEnv.SIGNER_URL || 'http://localhost:8421',
    SIGNER_CONFIG: CONTAINER_SIGNER_CONFIG,
    ...tokens,
    ...(database ? databaseEnv(database) : {}),
  };
  for (const { choice, key } of changes) Object.assign(updates, chainEnv(choice, key));
  if (fileMode) {
    for (const { choice, key } of changes) {
      sendersFile = withSender(
        sendersFile,
        choice.chain,
        choice.name!,
        senderEntry(choice.chain, choice.sender, key.address),
      );
    }
    for (const [chain, name] of defaults) sendersFile = withDefault(sendersFile, chain, name);
    for (const chain of enabled) Object.assign(updates, clearedSenderVariables(chain));
  }
  const envText = updateEnvText(files.envText, updates);

  const now = io.now();
  const relative = (file: string) => path.relative(io.root, file);
  const wrote = (file: string, backup: string | undefined) =>
    ui.step(
      `Wrote ${relative(file)} (mode 0600)${backup ? `; the old one is ${relative(backup)}` : ''}`,
    );
  mkdirSync(files.signerDir, { recursive: true });
  wrote(
    files.signerConfigPath,
    writePrivateFile(files.signerConfigPath, `${JSON.stringify(signerConfig, null, 2)}\n`, now),
  );
  if (fileMode) {
    wrote(
      files.sendersPath,
      writePrivateFile(files.sendersPath, `${JSON.stringify(sendersFile, null, 2)}\n`, now),
    );
  }
  wrote(files.envPath, writePrivateFile(files.envPath, envText, now));
  const generated = Object.keys(tokens);
  if (generated.length > 0) {
    ui.info(
      `Generated ${listed(generated)} into ${relative(files.envPath)}. They are not shown here; read them from the file.`,
    );
  }

  // The process environment already holds the old .env, loaded at startup, so the new file wins.
  const finalEnv: Env = { ...io.env, ...parseEnvText(envText) };
  const backends = backendsIn(signerConfig);
  ui.note('Before you rely on it', nextSteps(choices, heldKeys, backends));

  const ownDatabase = (finalEnv.CONTAINER_DATABASE_URL ?? '') !== '';
  let servicesUp = true;
  if (start && !fileMode) {
    servicesUp = await startServices(
      io.run,
      io.readiness ?? composeReadiness(io.run, io.root),
      ui,
      io.root,
      {
        ownDatabase,
        ...(backends.has('local') && passphrase ? { passphrase } : {}),
      },
    );
  } else {
    // docker-compose.yml mounts no senders file into the api and worker containers, so they would start without it.
    if (start) {
      ui.warn(
        `Not starting the services: Compose's api and worker containers cannot read ${relative(files.sendersPath)}, so they run from this checkout instead.`,
      );
    }
    const commands = composeCommands({ ownDatabase }).map((command) => command.join(' '));
    ui.note('Start the services later with', [
      ...(backends.has('local')
        ? ['read -rs SIGNER_KEYSTORE_PASSPHRASE && export SIGNER_KEYSTORE_PASSPHRASE']
        : []),
      ...(fileMode ? [...commands.slice(0, 2), 'pnpm dev:api', 'pnpm dev:worker'] : commands),
    ]);
  }

  ui.step('Running pnpm dispatch doctor');
  const doctorCode = await io.runDoctor(finalEnv);

  const funding = addressesToFund(finalEnv, settingsAt(finalEnv, files));
  if (funding.length > 0) {
    ui.note(
      'Fund these addresses',
      funding.flatMap(({ label, chain, address, pays, network }) => [
        `${label} ${address}`,
        `  pays ${pays}${network === 'test' ? `; faucet: ${FAUCETS[chain]}` : ''}`,
      ]),
    );
  }
  ui.outro(
    servicesUp && doctorCode === 0
      ? 'Set up. Run pnpm dispatch doctor any time to check again.'
      : 'Configuration written. Fix what doctor reported, then run pnpm dispatch doctor again.',
  );
  return servicesUp ? doctorCode : INIT_EXIT.problems;
}

function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

function nextSteps(
  choices: readonly ChainChoice[],
  held: readonly HeldKey[],
  backends: ReadonlySet<string>,
): string[] {
  const lines = [
    'Each key has a default policy (its chain and, for a multisig, its pin). Tighten it:',
    '  docs/self-hosting/signer.md#4-write-a-policy-for-every-address',
  ];
  choices.forEach((choice, i) => {
    const key = held[i]!.address;
    if (choice.sender.kind === 'squads') {
      lines.push(
        `Add ${key} to the Squads multisig with Initiate and Execute only (mask 5), and make it the rent collector:`,
        '  docs/self-hosting/multisig.md#squads-on-solana',
      );
    }
    if (choice.sender.kind === 'safe') {
      lines.push(
        `An owner of the Safe registers ${key} as a delegate:`,
        '  docs/self-hosting/multisig.md#register-the-executor-as-a-delegate',
      );
    }
  });
  if (backends.has('privy')) {
    lines.push(
      'Export PRIVY_APP_ID, PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_KEY where you run docker compose.',
    );
  }
  if (backends.has('aws-kms')) {
    lines.push(
      'Export AWS_REGION and AWS credentials where you run docker compose (docs/self-hosting/signer.md#aws-kms).',
    );
  }
  if (backends.has('keyfile')) {
    lines.push('The keyfile backend uses committed dev keys: development only, never mainnet.');
  }
  return lines;
}
