import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Coordinator } from '../../../coordinator/coordinator.js';
import {
  attempts,
  dispatches,
  proposals,
  relayDispatches,
  transactions,
} from '../../../db/schema.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  getTestMint,
  testMintDecimals,
  DEVNET_RPC_URL,
} from '../test-support/devnet-fixtures.js';
import {
  castVote,
  executeAsHuman,
  loadSquadsE2eFixture,
  RUN_SQUADS,
  sleep,
  startMemberSigner,
  tokenBalance,
  topUpSquadsFixture,
  voteInstruction,
  type MemberSignerHandle,
  type SquadsE2eFixture,
} from '../test-support/squads-e2e-fixtures.js';
import { SQUADS_PROGRAM_ID } from './multisig-config.js';
import { deriveProposalPda, deriveTransactionPda } from './vault-transaction.js';

/**
 * Live (ADR-0013), opt-in (issue #78): RUN_SQUADS=1 and SQUADS_E2E_KEYS_DIR, a
 * directory holding public.json and the keypair files (member, voter1-3,
 * human; never committed) of a throwaway devnet 2-of-3 Squads multisig. The
 * engine's key is its only Initiate + Execute member (mask 5) and its rent
 * collector; the Voters hold Vote only; one human member holds Execute only.
 *
 * The WHOLE engine runs against devnet: the real Postgres test database, the
 * real chain-loaders wiring in `multisig` mode (startup checks, SquadsApproval,
 * the Solana handler), the real Coordinator and ApprovalFlow driven tick by
 * tick (the worker process is not started), the real `signer/` server holding
 * the member key under `allowedMultisig`, and the real HTTP API through
 * `app.inject`. Votes and the late human execution are hand-built.
 *
 * Spends devnet SOL from the cached sender by plain transfer (capped, see
 * squads-e2e-fixtures.ts); almost all of it stays in the fixture for re-runs.
 */

const API_TOKEN = 'test-token';
const SPL_ASSET = 'TEST';
const DEADLINE_MS = 5 * 60_000;
const SHORT_DEADLINE_MS = 25_000;

type WireItem = {
  status: string;
  transactionHash: string | null;
  error: { code: string; message: string; chainDetail?: Record<string, unknown> } | null;
  approval?: {
    state: string;
    approvals: number;
    threshold: number;
    deadline: string;
    expected: { recipients: number; totals: { asset: string; amount: string }[] };
    chainRef: { kind: string; multisig: string; proposal: string; transactionIndex: number };
  };
};
type WireDispatch = { dispatchId: string; mode: string; status: string; items: WireItem[] };

const log = (message: string) => console.log(`[squads-engine-e2e] ${message}`);

describe.runIf(RUN_SQUADS)('Squads Multisig Sender through the whole engine (real devnet)', () => {
  let fixture: SquadsE2eFixture;
  let connection: Connection;
  let signer: MemberSignerHandle;
  let mint: PublicKey;
  let app: { inject: (opts: object) => Promise<{ statusCode: number; json: <T>() => T }> };
  let db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };
  let store: unknown;
  let CoordinatorClass: typeof Coordinator;
  let registry: Awaited<ReturnType<typeof import('../../../chain-loaders.js').loadChainRegistry>>;
  let coordinatorConfigFor: typeof import('../../../chain-loaders.js').coordinatorConfigFor;
  let vaultAta: PublicKey;
  const senderStart = { lamports: 0 };

  beforeAll(async () => {
    const dir = process.env.SQUADS_E2E_KEYS_DIR;
    if (!dir) throw new Error('SQUADS_E2E_KEYS_DIR must name the fixture keys directory');
    fixture = loadSquadsE2eFixture(dir);
    connection = getDevnetConnection();
    const funder = await getFundedSenderKeypair();
    mint = await getTestMint();
    senderStart.lamports = await connection.getBalance(funder.publicKey, 'confirmed');
    const spent = await topUpSquadsFixture(connection, fixture, funder, mint, testMintDecimals());
    log(`fixture topped up, sender spent ${spent} lamports`);
    vaultAta = getAssociatedTokenAddressSync(mint, fixture.vault, true);

    signer = await startMemberSigner(fixture);

    // config.ts reads the environment once, when first imported: set it, then load the engine fresh.
    Object.assign(process.env, {
      ENABLED_CHAINS: 'solana',
      SOLANA_RPC_URL: DEVNET_RPC_URL,
      SOLANA_SENDER_MODE: 'multisig',
      SOLANA_MULTISIG_ADDRESS: fixture.multisig.toBase58(),
      SOLANA_MULTISIG_MEMBER_ADDRESS: fixture.member.publicKey.toBase58(),
      SOLANA_APPROVAL_DEADLINE_MS: String(DEADLINE_MS),
      SOLANA_KNOWN_TOKENS: `${SPL_ASSET}:${mint.toBase58()}:${testMintDecimals()}`,
      SIGNER_URL: signer.url,
      SIGNER_AUTH_TOKEN: signer.token,
      AUTH_TOKEN: API_TOKEN,
    });
    delete process.env.SOLANA_SENDER_ADDRESS;
    vi.resetModules();
    const loaders = await import('../../../chain-loaders.js');
    coordinatorConfigFor = loaders.coordinatorConfigFor;
    // Runs the real multisig startup checks against the real RPC and the real Signer.
    registry = await loaders.loadChainRegistry();
    ({ db } = await import('../../../db/client.js'));
    const { PostgresDispatchStore } =
      await import('../../../repository/postgres-dispatch-store.js');
    store = new PostgresDispatchStore(db as never);
    ({ Coordinator: CoordinatorClass } = await import('../../../coordinator/coordinator.js'));
    const { buildApp } = await import('../../../app.js');
    app = buildApp({
      store: store as never,
      chainRegistry: registry,
      authToken: API_TOKEN,
      defaultRetryPolicy: false,
    });
  }, 180_000);

  afterAll(async () => {
    await signer?.close();
  });

  async function truncate(): Promise<void> {
    await db.execute(
      sql`TRUNCATE TABLE ${attempts}, ${transactions}, ${proposals}, ${relayDispatches}, ${dispatches} RESTART IDENTITY CASCADE`,
    );
  }

  function newCoordinator(approvalDeadlineMs = DEADLINE_MS): Coordinator {
    const config = coordinatorConfigFor(registry);
    config.approvalDeadlineMsByChain.set('solana', approvalDeadlineMs);
    return new CoordinatorClass({
      store: store as never,
      chainHandlers: registry.handlers,
      senderAddresses: config.senderAddresses,
      abandonmentTimeoutMs: config.abandonmentTimeoutMs,
      reorgRecheckWindowMs: config.reorgRecheckWindowMs,
      stuckHandling: config.stuckHandling,
      approvalDeadlineMsByChain: config.approvalDeadlineMsByChain,
      approvalRewatchWindowMsByChain: config.approvalRewatchWindowMsByChain,
    });
  }

  async function post(items: object[]): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        'idempotency-key': `squads-e2e-${Date.now()}-${Math.random()}`,
      },
      payload: { chain: 'solana', items },
    });
    expect(response.statusCode).toBe(202);
    return response.json<{ dispatchId: string }>().dispatchId;
  }

  async function get(id: string): Promise<WireDispatch> {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${id}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<WireDispatch>();
  }

  /** One worker tick of everything the multisig path needs, repeated until `done` holds (read through the API). */
  async function drive(
    coordinator: Coordinator,
    id: string,
    label: string,
    done: (d: WireDispatch) => boolean,
    timeoutMs = 240_000,
  ): Promise<WireDispatch> {
    const deadline = Date.now() + timeoutMs;
    let last = await get(id);
    while (Date.now() < deadline) {
      await coordinator.processQueuedDispatches(10);
      await coordinator.watchProposals(10);
      await coordinator.pollPendingTransactions(50);
      last = await get(id);
      if (done(last)) return last;
      await sleep(2_000);
    }
    throw new Error(`${label}: not reached within ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
  }

  const solPayment = (recipient: PublicKey, amount: bigint | number) => ({
    type: 'payment',
    recipient: recipient.toBase58(),
    asset: 'SOL',
    amount: amount.toString(),
  });
  const accountsClosed = async (index: number | bigint): Promise<boolean> =>
    (await connection.getAccountInfo(
      deriveProposalPda(fixture.multisig, BigInt(index)),
      'confirmed',
    )) === null &&
    (await connection.getAccountInfo(
      deriveTransactionPda(fixture.multisig, BigInt(index)),
      'confirmed',
    )) === null;

  /** Drives the engine until the Proposal's two accounts are gone (it closes what it finished with). */
  async function driveUntilClosed(
    coordinator: Coordinator,
    index: number,
    timeoutMs = 120_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await coordinator.watchProposals(10);
      await coordinator.pollPendingTransactions(50);
      if (await accountsClosed(index)) return true;
      await sleep(2_000);
    }
    return false;
  }

  /** Which Squads instructions (by discriminator) the transaction with this signature held, read from the chain. */
  async function squadsInstructionsOf(signature: string): Promise<string[]> {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return [];
    const message = tx.transaction.message;
    const keys = message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    const names: Record<string, string> = {
      '30fa4ea8d0e2dad3': 'vaultTransactionCreate',
      dc3c49e01e6c4f9f: 'proposalCreate',
      c208a15799a419ab: 'vaultTransactionExecute',
      c447bbb00223aaa5: 'vaultTransactionAccountsClose',
      '9025a488bcd82af8': 'proposalApprove',
      f33e869ce66af687: 'proposalReject',
    };
    return message.compiledInstructions.flatMap((instruction) => {
      const program = keys.get(instruction.programIdIndex);
      if (!program?.equals(SQUADS_PROGRAM_ID)) return [];
      const hex = Buffer.from(instruction.data.subarray(0, 8)).toString('hex');
      return [names[hex] ?? hex];
    });
  }

  async function signedInstructions(fromAuditIndex = 0): Promise<string[]> {
    const signed = signer.audit
      .slice(fromAuditIndex)
      .filter((line) => line.decision === 'signed' && line.transactionId);
    const all: string[] = [];
    for (const line of signed) all.push(...(await squadsInstructionsOf(line.transactionId!)));
    return all;
  }

  const sortTotals = (totals: { asset: string; amount: string }[]) =>
    [...totals].sort((a, b) => a.asset.localeCompare(b.asset));

  // ---- 1. approve path ---------------------------------------------------------------------

  it('approve path: SOL and SPL payments await approval, two Voters approve, the engine executes and closes', async () => {
    await truncate();
    const coordinator = newCoordinator();
    const solRecipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const amounts = [1_500_000n, 2_500_000n];
    const tokenRecipient = Keypair.generate().publicKey; // no token account yet: the proposal creates it
    const tokenAmount = 5_000_000n;
    const memberBefore = await connection.getBalance(fixture.member.publicKey, 'confirmed');
    const vaultBefore = await connection.getBalance(fixture.vault, 'confirmed');
    const vaultTokensBefore = await tokenBalance(connection, vaultAta);

    const id = await post([
      solPayment(solRecipients[0]!, amounts[0]!),
      solPayment(solRecipients[1]!, amounts[1]!),
      {
        type: 'payment',
        recipient: tokenRecipient.toBase58(),
        asset: SPL_ASSET,
        amount: tokenAmount.toString(),
      },
    ]);

    const t0 = Date.now();
    const waiting = await drive(coordinator, id, 'awaiting approval', (d) =>
      d.items.every((item) => item.status === 'awaiting_approval'),
    );
    log(`approve: awaiting_approval after ${Date.now() - t0} ms`);
    expect(waiting.status).toBe('broadcasting');
    const approval = waiting.items[0]!.approval!;
    expect(approval.state).toBe('awaiting');
    expect(approval.approvals).toBe(0);
    expect(approval.threshold).toBe(2);
    expect(approval.chainRef).toMatchObject({
      kind: 'squads',
      multisig: fixture.multisig.toBase58(),
    });
    const index = approval.chainRef.transactionIndex;
    expect(approval.chainRef.proposal).toBe(
      deriveProposalPda(fixture.multisig, BigInt(index)).toBase58(),
    );
    const remaining = new Date(approval.deadline).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(DEADLINE_MS - 120_000);
    expect(remaining).toBeLessThanOrEqual(DEADLINE_MS);
    expect(approval.expected.recipients).toBe(3);
    expect(sortTotals(approval.expected.totals)).toEqual([
      { asset: 'SOL', amount: (amounts[0]! + amounts[1]!).toString() },
      { asset: SPL_ASSET, amount: tokenAmount.toString() },
    ]);
    for (const item of waiting.items) {
      expect(item.transactionHash).toBeNull();
      expect(item.approval?.chainRef.transactionIndex).toBe(index);
    }
    // Nothing is paid before the votes.
    expect(await connection.getBalance(solRecipients[0]!, 'confirmed')).toBe(0);

    await castVote(connection, fixture, fixture.voters[0]!, index, 'approve');
    const half = await drive(
      coordinator,
      id,
      'one approval seen',
      (d) => d.items[0]!.approval?.approvals === 1,
    );
    expect(half.items[0]!.status).toBe('awaiting_approval');
    await castVote(connection, fixture, fixture.voters[1]!, index, 'approve');
    const voted = Date.now();
    const confirmed = await drive(coordinator, id, 'confirmed', (d) =>
      d.items.every((i) => i.status === 'confirmed'),
    );
    log(`approve: second vote -> CONFIRMED in ${Date.now() - voted} ms`);

    expect(confirmed.status).toBe('confirmed');
    const hashes = new Set(confirmed.items.map((item) => item.transactionHash));
    expect(hashes.size).toBe(1);
    const [hash] = [...hashes];
    expect(typeof hash).toBe('string');
    expect(await squadsInstructionsOf(hash!)).toEqual(['vaultTransactionExecute']);

    expect(await connection.getBalance(solRecipients[0]!, 'confirmed')).toBe(Number(amounts[0]));
    expect(await connection.getBalance(solRecipients[1]!, 'confirmed')).toBe(Number(amounts[1]));
    const tokenAccount = await getAccount(
      connection,
      getAssociatedTokenAddressSync(mint, tokenRecipient),
      'confirmed',
    );
    expect(tokenAccount.amount).toBe(tokenAmount);
    expect(await tokenBalance(connection, vaultAta)).toBe(vaultTokensBefore - tokenAmount);
    const vaultSpent = vaultBefore - (await connection.getBalance(fixture.vault, 'confirmed'));
    // The two SOL payments plus the new token account's rent: nothing else leaves the vault.
    expect(vaultSpent).toBeGreaterThanOrEqual(Number(amounts[0]! + amounts[1]!));
    expect(vaultSpent).toBeLessThan(Number(amounts[0]! + amounts[1]!) + 3_000_000);

    // The engine closes what it finished with; the rent returns to the collector (the member key).
    expect(await driveUntilClosed(coordinator, index)).toBe(true);
    const memberLoss =
      memberBefore - (await connection.getBalance(fixture.member.publicKey, 'confirmed'));
    log(`approve: member key net cost of the whole cycle ${memberLoss} lamports (rent reclaimed)`);
    expect(memberLoss).toBeGreaterThan(0);
    expect(memberLoss).toBeLessThan(100_000); // three signatures; the ~4.7M of rent came back
  }, 600_000);

  // ---- 2. reject path ----------------------------------------------------------------------

  it('reject path: two Voters reject, the Calls FAIL with APPROVAL_REJECTED, nothing is paid, the proposal is closed', async () => {
    await truncate();
    const coordinator = newCoordinator();
    const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const id = await post(recipients.map((to) => solPayment(to, 1_000_000)));

    const waiting = await drive(coordinator, id, 'awaiting approval', (d) =>
      d.items.every((item) => item.status === 'awaiting_approval'),
    );
    const index = waiting.items[0]!.approval!.chainRef.transactionIndex;
    await castVote(connection, fixture, fixture.voters[0]!, index, 'reject');
    await castVote(connection, fixture, fixture.voters[1]!, index, 'reject');
    const rejectedAt = Date.now();
    const failed = await drive(coordinator, id, 'failed', (d) =>
      d.items.every((i) => i.status === 'failed'),
    );
    log(`reject: second reject -> FAILED in ${Date.now() - rejectedAt} ms`);

    expect(failed.status).toBe('failed');
    for (const item of failed.items) {
      expect(item.error?.code).toBe('APPROVAL_REJECTED');
      expect(item.transactionHash).toBeNull();
    }
    for (const to of recipients) expect(await connection.getBalance(to, 'confirmed')).toBe(0);
    expect(await driveUntilClosed(coordinator, index)).toBe(true);
  }, 600_000);

  // ---- 3. timeout path, then a late human execution -----------------------------------------

  it('timeout path: nobody votes -> ABANDONED with APPROVAL_TIMEOUT; Voters approve, a human executes, the re-watch settles CONFIRMED', async () => {
    await truncate();
    const coordinator = newCoordinator(SHORT_DEADLINE_MS);
    const auditStart = signer.audit.length;
    const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const id = await post(recipients.map((to) => solPayment(to, 1_100_000)));

    const waiting = await drive(coordinator, id, 'awaiting approval', (d) =>
      d.items.every((item) => item.status === 'awaiting_approval'),
    );
    const index = waiting.items[0]!.approval!.chainRef.transactionIndex;
    const timedOutAfter = Date.now();
    const abandoned = await drive(coordinator, id, 'abandoned', (d) =>
      d.items.every((i) => i.status === 'abandoned'),
    );
    log(
      `timeout: ABANDONED ${Date.now() - timedOutAfter} ms after awaiting_approval (deadline ${SHORT_DEADLINE_MS} ms)`,
    );
    for (const item of abandoned.items) {
      expect(item.error?.code).toBe('APPROVAL_TIMEOUT');
      expect(item.transactionHash).toBeNull();
    }
    for (const to of recipients) expect(await connection.getBalance(to, 'confirmed')).toBe(0);

    // The Voters approve after the deadline; the engine must see it and still never execute.
    await castVote(connection, fixture, fixture.voters[0]!, index, 'approve');
    await castVote(connection, fixture, fixture.voters[1]!, index, 'approve');
    const late = await drive(
      coordinator,
      id,
      'late approval seen',
      (d) => d.items[0]!.approval?.approvals === 2,
    );
    log(
      `timeout: after the late votes the API says approval.state=${late.items[0]!.approval!.state}, items ${late.items.map((i) => i.status).join(',')}`,
    );
    // Give the engine two more watch ticks with an approved proposal it must leave alone.
    const quiet = Date.now() + 40_000;
    while (Date.now() < quiet) {
      await coordinator.watchProposals(10);
      await sleep(2_000);
    }
    const stillOpen = await connection.getAccountInfo(
      deriveTransactionPda(fixture.multisig, BigInt(index)),
      'confirmed',
    );
    expect(stillOpen).not.toBeNull(); // not executed, not closed by the engine
    for (const to of recipients) expect(await connection.getBalance(to, 'confirmed')).toBe(0);
    expect(await signedInstructions(auditStart)).not.toContain('vaultTransactionExecute');

    const humanSignature = await executeAsHuman(connection, fixture, index);
    const executedAt = Date.now();
    const settled = await drive(coordinator, id, 'settled by the re-watch', (d) =>
      d.items.every((i) => i.status === 'confirmed'),
    );
    log(`timeout: human execution -> CONFIRMED in ${Date.now() - executedAt} ms`);
    for (const item of settled.items) {
      expect(item.transactionHash).toBe(humanSignature);
      expect(item.error).toBeNull();
    }
    for (const to of recipients)
      expect(await connection.getBalance(to, 'confirmed')).toBe(1_100_000);
    // The engine itself never executed anything for this Dispatch.
    expect(await signedInstructions(auditStart)).not.toContain('vaultTransactionExecute');
    expect(await driveUntilClosed(coordinator, index)).toBe(true);
  }, 900_000);

  // ---- 4. Funding Check ---------------------------------------------------------------------

  it('funding check: more than the vault fails INSUFFICIENT_FUNDS naming the vault; open proposals count as committed', async () => {
    await truncate();
    const coordinator = newCoordinator();

    // (a) more than the vault holds, by a wide margin.
    const tooMuch = await post([solPayment(Keypair.generate().publicKey, 1_000_000_000_000n)]);
    await coordinator.processQueuedDispatches(10);
    const refused = await get(tooMuch);
    expect(refused.items[0]!.status).toBe('failed');
    expect(refused.items[0]!.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(refused.items[0]!.error?.chainDetail).toMatchObject({
      asset: 'SOL',
      holder: 'vault',
      address: fixture.vault.toBase58(),
      committed: '0',
    });

    // (b) each of two Dispatches fits the vault alone; together they do not.
    const vault = await connection.getBalance(fixture.vault, 'confirmed');
    const each = BigInt(Math.floor(vault * 0.6));
    const first = await post([solPayment(Keypair.generate().publicKey, each)]);
    const open = await drive(coordinator, first, 'first proposal open', (d) =>
      d.items.every((item) => item.status === 'awaiting_approval'),
    );
    const second = await post([solPayment(Keypair.generate().publicKey, each)]);
    await coordinator.processQueuedDispatches(10);
    const blocked = await get(second);
    expect(blocked.items[0]!.status).toBe('failed');
    expect(blocked.items[0]!.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(blocked.items[0]!.error?.chainDetail).toMatchObject({
      asset: 'SOL',
      holder: 'vault',
      address: fixture.vault.toBase58(),
      committed: each.toString(),
    });
    log(
      `funding: second proposal refused with chainDetail ${JSON.stringify(blocked.items[0]!.error?.chainDetail)}`,
    );

    // Clean up on chain: reject the open proposal so its rent comes back.
    const index = open.items[0]!.approval!.chainRef.transactionIndex;
    await castVote(connection, fixture, fixture.voters[0]!, index, 'reject');
    await castVote(connection, fixture, fixture.voters[1]!, index, 'reject');
    await drive(coordinator, first, 'first rejected', (d) =>
      d.items.every((i) => i.status === 'failed'),
    );
    expect(await driveUntilClosed(coordinator, index)).toBe(true);
  }, 600_000);

  // ---- 5. the Signer's policy, for real -----------------------------------------------------

  it('signer policy: the engine create, execute and close were all accepted; a vote for the member key is refused with 403', async () => {
    const signedKinds = await signedInstructions();
    log(
      `signer audit: ${signer.audit.length} lines; signed Squads instructions ${JSON.stringify(signedKinds)}`,
    );
    expect(signedKinds).toContain('vaultTransactionCreate');
    expect(signedKinds).toContain('proposalCreate');
    expect(signedKinds).toContain('vaultTransactionExecute');
    expect(signedKinds).toContain('vaultTransactionAccountsClose');
    expect(signedKinds).not.toContain('proposalApprove');
    expect(signedKinds).not.toContain('proposalReject');
    // The engine's own requests were never refused: startup reads the key's pin (ADR-0055) instead of
    // probing the Signer with a sign request.
    const refusals = signer.audit.filter((line) => line.decision === 'refused');
    expect(refusals).toEqual([]);
    expect(signer.audit.every((line) => line.address === fixture.member.publicKey.toBase58())).toBe(
      true,
    );

    // Directly against the Signer: a vote instruction for the member key.
    const member = fixture.member.publicKey;
    const proposal = deriveProposalPda(fixture.multisig, 1n);
    const tx = new Transaction({
      feePayer: member,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 0,
    }).add(voteInstruction(fixture, member, proposal, 'approve'));
    const auditBefore = signer.audit.length;
    const response = await fetch(`${signer.url}/sign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: 'solana',
        curve: 'ed25519',
        address: member.toBase58(),
        unsignedTransaction: Buffer.from(tx.compileMessage().serialize()).toString('base64'),
      }),
    });
    const body = (await response.json()) as { error?: string; reason?: string };
    log(`signer: vote for the member key -> ${response.status} ${JSON.stringify(body)}`);
    expect(response.status).toBe(403);
    expect(body.reason).toMatch(/proposalApprove|vote|not allowed/i);
    const refusal = signer.audit.slice(auditBefore);
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ decision: 'refused', status: 403 });

    const funder = await getFundedSenderKeypair();
    const spent =
      senderStart.lamports - (await connection.getBalance(funder.publicKey, 'confirmed'));
    log(`devnet sender spent ${spent} lamports in this run`);
    expect(spent).toBeLessThan(150_000_000);
  }, 120_000);
});
