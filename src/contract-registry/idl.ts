import { createHash } from 'node:crypto';

import bs58 from 'bs58';

import { err, ok, type Result } from '../domain/result.js';

/**
 * ADR-0063: an Anchor IDL, in the format Anchor 0.30 and later write
 * (`discriminator` on each instruction, `pubkey`, `{ defined: { name } }`) or
 * the older one (`publicKey`, `{ defined: "Name" }`, discriminators derived
 * from the instruction's name), read into one model.
 */

const PRIMITIVES = [
  'bool',
  'u8',
  'i8',
  'u16',
  'i16',
  'u32',
  'i32',
  'f32',
  'u64',
  'i64',
  'f64',
  'u128',
  'i128',
  'u256',
  'i256',
  'string',
  'bytes',
  'pubkey',
] as const;
type Primitive = (typeof PRIMITIVES)[number];

export type IdlType =
  | { kind: 'primitive'; name: Primitive }
  | { kind: 'vec' | 'option' | 'coption'; of: IdlType }
  | { kind: 'array'; of: IdlType; length: number }
  | { kind: 'defined'; name: string };

type Fields =
  { named: true; fields: { name: string; type: IdlType }[] } | { named: false; types: IdlType[] };

export type IdlTypeDef =
  | { kind: 'struct'; fields: Fields }
  | { kind: 'enum'; variants: { name: string; fields: Fields | null }[] }
  | { kind: 'alias'; of: IdlType };

export type IdlInstruction = {
  name: string;
  /** Lowercase hex. Anchor's are 8 bytes; 0.31 lets a program choose its own. */
  discriminator: string;
  /** In the order the instruction takes them; a nested group's as `group.account`. */
  accounts: string[];
  args: { name: string; type: IdlType }[];
};

export type ParsedIdl = {
  name: string | null;
  /** The program the IDL says it describes, when it says. */
  address: string | null;
  instructions: readonly IdlInstruction[];
  types: ReadonlyMap<string, IdlTypeDef>;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseType(raw: unknown, path: string): Result<IdlType, string> {
  if (typeof raw === 'string') {
    const name = raw === 'publicKey' ? 'pubkey' : raw;
    return PRIMITIVES.includes(name as Primitive)
      ? ok({ kind: 'primitive', name: name as Primitive })
      : err(`${path}: "${raw}" is not an IDL type`);
  }
  if (!isObject(raw)) return err(`${path}: must be a type name or a type object`);
  for (const kind of ['vec', 'option', 'coption'] as const) {
    if (kind in raw) {
      const of = parseType(raw[kind], `${path}.${kind}`);
      return of.ok ? ok({ kind, of: of.value }) : of;
    }
  }
  if ('array' in raw) {
    const array = raw.array;
    if (!Array.isArray(array) || array.length !== 2) {
      return err(`${path}.array: must be [type, length]`);
    }
    const [element, length] = array as [unknown, unknown];
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
      return err(`${path}.array[1]: must be a fixed length (generic lengths are not supported)`);
    }
    const of = parseType(element, `${path}.array[0]`);
    return of.ok ? ok({ kind: 'array', of: of.value, length }) : of;
  }
  if ('defined' in raw) {
    const defined = raw.defined;
    if (typeof defined === 'string') return ok({ kind: 'defined', name: defined });
    if (isObject(defined) && typeof defined.name === 'string') {
      if (Array.isArray(defined.generics) && defined.generics.length > 0) {
        return err(`${path}.defined: generic types are not supported`);
      }
      return ok({ kind: 'defined', name: defined.name });
    }
    return err(`${path}.defined: must name a type`);
  }
  if ('generic' in raw) return err(`${path}: generic types are not supported`);
  return err(`${path}: is not an IDL type`);
}

function parseFields(raw: unknown, path: string): Result<Fields, string> {
  if (raw === undefined) return ok({ named: true, fields: [] });
  if (!Array.isArray(raw)) return err(`${path}: must be an array`);
  if (raw.every((field) => isObject(field) && typeof field.name === 'string' && 'type' in field)) {
    const fields: { name: string; type: IdlType }[] = [];
    for (const [i, field] of (raw as Json[]).entries()) {
      const type = parseType(field.type, `${path}[${i}].type`);
      if (!type.ok) return type;
      fields.push({ name: field.name as string, type: type.value });
    }
    return ok({ named: true, fields });
  }
  const types: IdlType[] = [];
  for (const [i, entry] of raw.entries()) {
    const type = parseType(entry, `${path}[${i}]`);
    if (!type.ok) return type;
    types.push(type.value);
  }
  return ok({ named: false, types });
}

function parseTypeDef(raw: unknown, path: string): Result<[string, IdlTypeDef], string> {
  if (!isObject(raw) || typeof raw.name !== 'string') return err(`${path}.name: must be a string`);
  if (Array.isArray(raw.generics) && raw.generics.length > 0) {
    return err(`${path}: generic types are not supported`);
  }
  const type = raw.type;
  if (!isObject(type)) return err(`${path}.type: must be an object with a kind`);
  if (type.kind === 'struct') {
    const fields = parseFields(type.fields, `${path}.type.fields`);
    return fields.ok ? ok([raw.name, { kind: 'struct', fields: fields.value }]) : fields;
  }
  if (type.kind === 'enum') {
    if (!Array.isArray(type.variants)) return err(`${path}.type.variants: must be an array`);
    const variants: { name: string; fields: Fields | null }[] = [];
    for (const [i, variant] of type.variants.entries()) {
      const at = `${path}.type.variants[${i}]`;
      if (!isObject(variant) || typeof variant.name !== 'string') {
        return err(`${at}.name: must be a string`);
      }
      if (variant.fields === undefined) {
        variants.push({ name: variant.name, fields: null });
        continue;
      }
      const fields = parseFields(variant.fields, `${at}.fields`);
      if (!fields.ok) return fields;
      variants.push({ name: variant.name, fields: fields.value });
    }
    return ok([raw.name, { kind: 'enum', variants }]);
  }
  if (type.kind === 'type') {
    const alias = parseType(type.alias, `${path}.type.alias`);
    return alias.ok ? ok([raw.name, { kind: 'alias', of: alias.value }]) : alias;
  }
  return err(`${path}.type.kind: must be struct, enum or type`);
}

function accountNames(raw: unknown, path: string, prefix = ''): Result<string[], string> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(`${path}: must be an array`);
  const names: string[] = [];
  for (const [i, account] of raw.entries()) {
    if (!isObject(account) || typeof account.name !== 'string') {
      return err(`${path}[${i}].name: must be a string`);
    }
    if (Array.isArray(account.accounts)) {
      const inner = accountNames(account.accounts, `${path}[${i}].accounts`, `${account.name}.`);
      if (!inner.ok) return inner;
      names.push(...inner.value);
    } else {
      names.push(`${prefix}${account.name}`);
    }
  }
  return ok(names);
}

/** `initializeMint` and `initialize_mint` alike become `initialize_mint`, as the Rust function is named. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The older format leaves the discriminator out: it is the start of sha256("global:<snake_name>"). */
function legacyDiscriminator(name: string): string {
  return createHash('sha256')
    .update(`global:${snakeCase(name)}`)
    .digest()
    .subarray(0, 8)
    .toString('hex');
}

function discriminatorOf(raw: unknown, name: string, path: string): Result<string, string> {
  if (raw === undefined) return ok(legacyDiscriminator(name));
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((byte) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) < 256)
  ) {
    return err(`${path}: must be an array of bytes`);
  }
  return ok(Buffer.from(raw as number[]).toString('hex'));
}

function definedNames(type: IdlType): string[] {
  switch (type.kind) {
    case 'primitive':
      return [];
    case 'defined':
      return [type.name];
    default:
      return definedNames(type.of);
  }
}

function fieldTypes(fields: Fields | null): IdlType[] {
  if (!fields) return [];
  return fields.named ? fields.fields.map((f) => f.type) : fields.types;
}

/** Reads a pasted Anchor IDL, or says what is wrong with it, named by where it is. */
export function parseIdl(raw: unknown): Result<ParsedIdl, string> {
  if (!isObject(raw)) return err('idl: must be a JSON object, an Anchor IDL');
  if (!Array.isArray(raw.instructions) || raw.instructions.length === 0) {
    return err('idl.instructions: must list at least one instruction');
  }
  const types = new Map<string, IdlTypeDef>();
  for (const [i, def] of (Array.isArray(raw.types) ? raw.types : []).entries()) {
    const parsed = parseTypeDef(def, `idl.types[${i}]`);
    if (!parsed.ok) return parsed;
    types.set(...parsed.value);
  }
  const instructions: IdlInstruction[] = [];
  for (const [i, entry] of raw.instructions.entries()) {
    const at = `idl.instructions[${i}]`;
    if (!isObject(entry) || typeof entry.name !== 'string' || entry.name === '') {
      return err(`${at}.name: must be a string`);
    }
    const discriminator = discriminatorOf(entry.discriminator, entry.name, `${at}.discriminator`);
    if (!discriminator.ok) return discriminator;
    const accounts = accountNames(entry.accounts, `${at}.accounts`);
    if (!accounts.ok) return accounts;
    const args = parseFields(entry.args, `${at}.args`);
    if (!args.ok) return args;
    if (!args.value.named) return err(`${at}.args: each argument needs a name and a type`);
    instructions.push({
      name: entry.name,
      discriminator: discriminator.value,
      accounts: accounts.value,
      args: args.value.fields,
    });
  }
  const referenced = [
    ...instructions.flatMap((ix) => ix.args.map((a) => a.type)),
    ...[...types.values()].flatMap((def) =>
      def.kind === 'alias'
        ? [def.of]
        : def.kind === 'struct'
          ? fieldTypes(def.fields)
          : def.variants.flatMap((v) => fieldTypes(v.fields)),
    ),
  ].flatMap(definedNames);
  const missing = referenced.find((name) => !types.has(name));
  if (missing !== undefined) return err(`idl.types: has no type named "${missing}"`);

  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  const name = typeof raw.name === 'string' ? raw.name : metadata.name;
  const address = typeof raw.address === 'string' ? raw.address : metadata.address;
  return ok({
    name: typeof name === 'string' ? name : null,
    address: typeof address === 'string' ? address : null,
    // Longest first, so a discriminator that starts another never takes its data.
    instructions: instructions.sort((a, b) => b.discriminator.length - a.discriminator.length),
    types,
  });
}

/** `u64`, `vec<pubkey>`, `[u8; 32]`, `TransferArgs`. */
export function formatIdlType(type: IdlType): string {
  switch (type.kind) {
    case 'primitive':
      return type.name;
    case 'defined':
      return type.name;
    case 'array':
      return `[${formatIdlType(type.of)}; ${type.length}]`;
    default:
      return `${type.kind}<${formatIdlType(type.of)}>`;
  }
}

/** `deposit(amount: u64, memo: string)`: what an instruction reads as. */
export function idlSignature(ix: IdlInstruction): string {
  return `${ix.name}(${ix.args.map((a) => `${a.name}: ${formatIdlType(a.type)}`).join(', ')})`;
}

export type IdlValue = string | boolean | null | IdlValue[] | { [name: string]: IdlValue };

/** Too deep or past the end: the data is not what the IDL says, so the instruction stays undecoded. */
class Unreadable extends Error {}

const INT_BYTES: Partial<Record<Primitive, number>> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  i128: 16,
  u256: 32,
  i256: 32,
};

const MAX_DEPTH = 32;

/** Borsh, as Anchor encodes instruction arguments. */
class Reader {
  private at: number;
  constructor(
    private readonly bytes: Buffer,
    start: number,
    private readonly types: ReadonlyMap<string, IdlTypeDef>,
  ) {
    this.at = start;
  }

  private take(n: number): Buffer {
    if (this.at + n > this.bytes.length) throw new Unreadable();
    const slice = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return slice;
  }

  private length(): number {
    return this.take(4).readUInt32LE(0);
  }

  private int(name: Primitive, size: number): string {
    const bytes = this.take(size);
    let value = 0n;
    for (let i = size - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
    if (name.startsWith('i') && value >= 1n << BigInt(size * 8 - 1))
      value -= 1n << BigInt(size * 8);
    return value.toString();
  }

  read(type: IdlType, depth = 0): IdlValue {
    if (depth > MAX_DEPTH) throw new Unreadable();
    switch (type.kind) {
      case 'primitive':
        return this.primitive(type.name);
      case 'option':
        return this.take(1)[0] === 0 ? null : this.read(type.of, depth + 1);
      case 'coption':
        return this.length() === 0 ? null : this.read(type.of, depth + 1);
      case 'vec':
      case 'array': {
        const n = type.kind === 'array' ? type.length : this.length();
        if (type.of.kind === 'primitive' && type.of.name === 'u8') {
          return this.take(n).toString('base64');
        }
        if (n > this.bytes.length - this.at) throw new Unreadable();
        return Array.from({ length: n }, () => this.read(type.of, depth + 1));
      }
      case 'defined':
        return this.defined(type.name, depth + 1);
    }
  }

  private primitive(name: Primitive): IdlValue {
    const size = INT_BYTES[name];
    if (size !== undefined) return this.int(name, size);
    switch (name) {
      case 'bool': {
        const byte = this.take(1)[0];
        if (byte !== 0 && byte !== 1) throw new Unreadable();
        return byte === 1;
      }
      case 'f32':
        return String(this.take(4).readFloatLE(0));
      case 'f64':
        return String(this.take(8).readDoubleLE(0));
      case 'string':
        return this.take(this.length()).toString('utf8');
      case 'bytes':
        return this.take(this.length()).toString('base64');
      default:
        return bs58.encode(this.take(32));
    }
  }

  private fields(fields: Fields, depth: number): IdlValue {
    return fields.named
      ? Object.fromEntries(fields.fields.map((f) => [f.name, this.read(f.type, depth)]))
      : fields.types.map((t) => this.read(t, depth));
  }

  private defined(name: string, depth: number): IdlValue {
    const def = this.types.get(name)!;
    switch (def.kind) {
      case 'alias':
        return this.read(def.of, depth);
      case 'struct':
        return this.fields(def.fields, depth);
      case 'enum': {
        const variant = def.variants[this.take(1)[0]!];
        if (!variant) throw new Unreadable();
        return variant.fields === null
          ? variant.name
          : { [variant.name]: this.fields(variant.fields, depth) };
      }
    }
  }
}

export type DecodedInstruction = {
  instruction: IdlInstruction;
  args: { name: string; type: string; value: IdlValue }[];
};

/** The instruction `data` starts with, its arguments read; null when no instruction matches or the data does not fit it. */
export function decodeIdlInstruction(idl: ParsedIdl, data: Buffer): DecodedInstruction | null {
  const hex = data.toString('hex');
  const instruction = idl.instructions.find((ix) => hex.startsWith(ix.discriminator));
  if (!instruction) return null;
  const reader = new Reader(data, instruction.discriminator.length / 2, idl.types);
  try {
    return {
      instruction,
      args: instruction.args.map((arg) => ({
        name: arg.name,
        type: formatIdlType(arg.type),
        value: reader.read(arg.type),
      })),
    };
  } catch (cause) {
    if (cause instanceof Unreadable) return null;
    throw cause;
  }
}
