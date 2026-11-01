import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Env } from '../config.js';
import { cliContext } from './cli-context.js';
import { doctor } from './doctor.js';
import type { InitIo } from './init.js';
import type { Runner } from './init-services.js';
import type { Machine, Probe } from './prerequisites.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const probe: Probe = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 15_000 }, (error, stdout) =>
      resolve({ ok: error === null, stdout: String(stdout) }),
    );
  });

const run: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (cause) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${cause.message}` }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

function linuxIds(): string[] {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const value = (name: string) =>
      new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm').exec(text)?.[1] ?? '';
    return [value('ID'), ...value('ID_LIKE').split(' ')].filter((id) => id !== '');
  } catch {
    return [];
  }
}

/** The real machine: this repository, this terminal, real commands and a real doctor run. */
export function processInitIo(): InitIo {
  const machine: Machine = {
    platform: process.platform,
    nodeVersion: process.version,
    ...(process.platform === 'linux' ? { linuxIds: linuxIds() } : {}),
  };
  return {
    root: REPO_ROOT,
    signerPackage: path.join(REPO_ROOT, 'signer'),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    machine,
    probe,
    run,
    runDoctor: (env: Env) =>
      doctor([], { stdout: process.stdout, stderr: process.stderr, env, makeContext: cliContext }),
    now: () => new Date(),
    randomToken: () => randomBytes(32).toString('hex'),
  };
}
