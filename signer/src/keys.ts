import { parseArgs } from 'node:util';

import { CURVES, type Curve } from './backends/key-backend.js';
import { keystoreDir, keystorePassphrase } from './backends/local.js';
import {
  assertKeyName,
  assertValidKey,
  decryptKey,
  encryptKey,
  generateKey,
  KeystoreError,
  listKeys,
  readKeyFile,
  writeKeyFile,
} from './backends/keystore.js';

/** Everything the CLI touches, so a test can run it without a terminal. */
export type KeysIo = {
  env: Record<string, string | undefined>;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const USAGE = `usage: signer keys <command>

  new --curve <secp256k1|ed25519> --name <name>      make a key, print its address
  import --curve <secp256k1|ed25519> --name <name>   read a 32-byte hex private key from stdin
  list                                               every key's name, curve and address
  export-public --name <name>                        print one key's address

Needs SIGNER_KEYSTORE_DIR; new and import also need SIGNER_KEYSTORE_PASSPHRASE or
SIGNER_KEYSTORE_PASSPHRASE_FILE. A private key is never printed, and is never an argument.`;

/** Only ever called with text this file wrote, so it can't echo what the user typed. */
class UsageError extends Error {}

function options(args: string[], wanted: ('curve' | 'name')[]) {
  let values: { curve?: string | undefined; name?: string | undefined };
  try {
    ({ values } = parseArgs({
      args,
      options: { curve: { type: 'string' }, name: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // parseArgs quotes the offending argument, which could be a private key typed as one.
    throw new UsageError(
      'unrecognised arguments (a private key is read from stdin, not an argument)',
    );
  }
  for (const option of ['curve', 'name'] as const) {
    if (wanted.includes(option) !== (values[option] !== undefined)) {
      throw new UsageError(
        wanted.includes(option) ? `--${option} is required` : `--${option} is not used here`,
      );
    }
  }
  const { curve, name } = values;
  if (curve !== undefined && !CURVES.includes(curve as Curve)) {
    throw new UsageError(`--curve must be one of ${CURVES.join(', ')}`);
  }
  if (name !== undefined) assertKeyName(name);
  return { curve: curve as Curve | undefined, name };
}

function parseHexKey(text: string): Buffer {
  const hex = text.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new KeystoreError('the private key on stdin must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * The Signer opens its whole keystore with one passphrase, so a key added
 * under another one would stop it at startup. Checked against one existing
 * key, before anything is written.
 */
function assertOpensKeystore(dir: string, passphrase: string): void {
  const [existing] = listKeys(dir);
  if (!existing) return;
  try {
    decryptKey(readKeyFile(dir, existing.name), passphrase);
  } catch {
    throw new KeystoreError(
      `the passphrase does not open "${existing.name}", already in this keystore; the Signer uses one passphrase for every key in it`,
    );
  }
}

/** Runs one `signer keys` command; resolves to the process exit code. */
export async function runKeys(args: string[], io: KeysIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'new':
      case 'import': {
        const { curve, name } = options(rest, ['curve', 'name']);
        if (!curve || !name) throw new UsageError('--curve and --name are required');
        const dir = keystoreDir(io.env);
        const passphrase = keystorePassphrase(io.env);
        assertOpensKeystore(dir, passphrase);
        const key = command === 'new' ? generateKey(curve) : parseHexKey(await io.readStdin());
        assertValidKey(curve, key);
        const file = encryptKey(curve, key, passphrase);
        writeKeyFile(dir, name, file);
        io.stdout(`${file.address}\n`);
        return 0;
      }
      case 'list': {
        options(rest, []);
        for (const { name, curve, address } of listKeys(keystoreDir(io.env))) {
          io.stdout(`${name}\t${curve}\t${address}\n`);
        }
        return 0;
      }
      case 'export-public': {
        const { name } = options(rest, ['name']);
        if (!name) throw new UsageError('--name is required');
        io.stdout(`${readKeyFile(keystoreDir(io.env), name).address}\n`);
        return 0;
      }
      default:
        io.stderr(`${USAGE}\n`);
        return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
    }
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`error: ${cause.message}\n\n${USAGE}\n`);
      return 2;
    }
    // Only our own errors are worded not to hold key material; anything else is not repeated.
    io.stderr(`error: ${cause instanceof KeystoreError ? cause.message : 'the command failed'}\n`);
    return 1;
  }
}
