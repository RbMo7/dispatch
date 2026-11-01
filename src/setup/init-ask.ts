import * as clack from '@clack/prompts';

export type Option<T extends string> = { value: T; label: string; hint?: string; flag?: string };

export type SelectQuestion<T extends string> = {
  flag?: string;
  message: string;
  options: Option<T>[];
  initial?: T;
  /** The prompt starts at `initial`, but `--yes` still needs the flag: a choice the operator must make. */
  noScriptedDefault?: boolean;
};
export type MultiselectQuestion<T extends string> = {
  flag: string;
  message: string;
  options: Option<T>[];
  initial: T[];
};
export type TextQuestion = {
  flag?: string;
  message: string;
  initial?: string;
  placeholder?: string;
  /** A reason the value is not acceptable, or undefined. */
  validate: (value: string) => string | undefined;
};
export type ConfirmQuestion = { flag?: string; message: string; initial: boolean };

/** Every question init asks. Interactive mode prompts; scripted mode answers from flags and defaults. */
export type Asker = {
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  multiselect<T extends string>(question: MultiselectQuestion<T>): Promise<T[]>;
  text(question: TextQuestion): Promise<string>;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  /** "yes, mainnet", typed out. */
  mainnet(chainName: string): Promise<boolean>;
  /** Read without echo. `twice` asks again to confirm, for a new keystore. */
  passphrase(twice: boolean): Promise<string>;
};

/** A problem with what the operator asked for: printed as is, and init stops before writing anything. */
export class InitError extends Error {}

/** The operator pressed Ctrl-C or Escape. */
export class Cancelled extends Error {}

export type Flags = Readonly<Record<string, string | boolean | undefined>>;

function flagOption<T extends string>(options: Option<T>[], given: string, flag: string): T {
  const match = options.find((option) => (option.flag ?? option.value) === given);
  if (!match) {
    const allowed = options.map((option) => option.flag ?? option.value).join(', ');
    throw new InitError(`--${flag} must be one of ${allowed}, not "${given}"`);
  }
  return match.value;
}

/** Answers each question its flag already answers, and passes the rest to `inner`. */
export function withFlags(flags: Flags, inner: Asker): Asker {
  const given = (flag: string | undefined) => {
    const value = flag === undefined ? undefined : flags[flag];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    select: async (question) => {
      const value = given(question.flag);
      return value === undefined
        ? inner.select(question)
        : flagOption(question.options, value, question.flag!);
    },
    multiselect: async (question) => {
      const value = given(question.flag);
      if (value === undefined) return inner.multiselect(question);
      const picked = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      if (picked.length === 0) throw new InitError(`--${question.flag} needs at least one value`);
      return picked.map((item) => flagOption(question.options, item, question.flag));
    },
    text: async (question) => {
      const value = given(question.flag);
      if (value === undefined) return inner.text(question);
      const problem = question.validate(value);
      if (problem !== undefined) throw new InitError(`--${question.flag}: ${problem}`);
      return value;
    },
    confirm: async (question) => {
      const value = question.flag === undefined ? undefined : flags[question.flag];
      if (typeof value === 'boolean') return value;
      return inner.confirm(question);
    },
    mainnet: async (chainName) => flags['confirm-mainnet'] === true || inner.mainnet(chainName),
    passphrase: (twice) => inner.passphrase(twice),
  };
}

/** `--yes`: every question takes its default, and one without a default needs its flag. */
export function scriptedAsker(): Asker {
  const needs = (flag: string | undefined, message: string): never => {
    throw new InitError(
      flag === undefined
        ? `${message}: no default in --yes mode`
        : `--yes needs --${flag} (${message})`,
    );
  };
  const answer = <T>(value: () => T): Promise<T> => Promise.resolve().then(value);
  return {
    select: ({ flag, message, initial, noScriptedDefault }) =>
      answer(() => (noScriptedDefault ? undefined : initial) ?? needs(flag, message)),
    multiselect: ({ initial }) => answer(() => initial),
    text: ({ flag, message, initial }) => answer(() => initial ?? needs(flag, message)),
    confirm: ({ initial }) => answer(() => initial),
    mainnet: (chainName) =>
      answer(() => needs('confirm-mainnet', `${chainName} mainnet must be confirmed`)),
    passphrase: () =>
      answer(() => {
        throw new InitError(
          '--yes reads the local keystore passphrase from SIGNER_KEYSTORE_PASSPHRASE (an environment variable, never a flag), and it is not set',
        );
      }),
  };
}

function answered<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

function choices<T extends string>(options: Option<T>[]) {
  return options.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) }));
}

export const MAINNET_ANSWER = 'yes, mainnet';

/** The terminal prompts. */
export function interactiveAsker(): Asker {
  return {
    select: async <T extends string>({ message, options, initial }: SelectQuestion<T>) =>
      answered(
        await clack.select<T>({
          message,
          options: choices(options) as Parameters<typeof clack.select<T>>[0]['options'],
          ...(initial ? { initialValue: initial } : {}),
        }),
      ),
    multiselect: async <T extends string>({ message, options, initial }: MultiselectQuestion<T>) =>
      answered(
        await clack.multiselect<T>({
          message,
          options: choices(options) as Parameters<typeof clack.multiselect<T>>[0]['options'],
          initialValues: initial,
          required: true,
        }),
      ),
    text: async ({ message, initial, placeholder, validate }) =>
      answered(
        await clack.text({
          message,
          ...(initial !== undefined ? { initialValue: initial } : {}),
          ...(placeholder !== undefined ? { placeholder } : {}),
          validate: (value) => validate(value ?? ''),
        }),
      ),
    confirm: async ({ message, initial }) =>
      answered(await clack.confirm({ message, initialValue: initial })),
    mainnet: async (chainName) => {
      const typed = answered(
        await clack.text({
          message: `${chainName} mainnet moves real funds. Type "${MAINNET_ANSWER}" to use it, or anything else to go back`,
        }),
      );
      return typed.trim() === MAINNET_ANSWER;
    },
    passphrase: async (twice) => {
      for (;;) {
        const first = answered(
          await clack.password({
            message: 'Keystore passphrase (not shown as you type)',
            mask: '',
            validate: (value) => (value ? undefined : 'the passphrase cannot be empty'),
          }),
        );
        if (!twice) return first;
        const again = answered(
          await clack.password({ message: 'The same passphrase again', mask: '' }),
        );
        if (again === first) return first;
        clack.log.warn('The two passphrases differ. Try again.');
      }
    },
  };
}
