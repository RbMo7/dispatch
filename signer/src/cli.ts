import { runKeys } from './keys.js';

/** `signer keys ...`: the key CLI's entry point (`pnpm signer keys ...`, or `node dist/cli.js keys ...`). */
const [group, ...args] = process.argv.slice(2);

if (group !== 'keys') {
  console.error('usage: signer keys <new|import|list|export-public> ...');
  process.exit(2);
}

process.exitCode = await runKeys(args, {
  env: process.env,
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
