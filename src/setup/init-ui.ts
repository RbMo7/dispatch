import * as clack from '@clack/prompts';

type Output = { write: (text: string) => unknown };

/** What init prints between questions. */
export type Ui = {
  intro(title: string): void;
  step(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  note(title: string, lines: readonly string[]): void;
  /** One line that becomes "done" or "failed" when its work ends. */
  progress(label: string): { done(text: string): void; failed(text: string): void };
  outro(text: string): void;
};

export function plainUi(out: Output): Ui {
  let blank = true;
  const line = (text: string) => {
    if (text === '' && blank) return;
    blank = text === '';
    out.write(`${text}\n`);
  };
  return {
    intro: (title) => line(title),
    step: (text) => line(`- ${text}`),
    info: (text) => line(text),
    warn: (text) => line(`! ${text}`),
    note: (title, lines) => {
      line('');
      line(title);
      for (const text of lines) line(`  ${text}`);
      line('');
    },
    progress: (label) => {
      line(`- ${label}...`);
      return { done: (text) => line(`  ${text}`), failed: (text) => line(`  FAILED: ${text}`) };
    },
    outro: (text) => line(text),
  };
}

export function clackUi(): Ui {
  return {
    intro: (title) => clack.intro(title),
    step: (text) => clack.log.step(text),
    info: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    note: (title, lines) => clack.note(lines.join('\n'), title),
    progress: (label) => {
      const spinner = clack.spinner();
      spinner.start(label);
      return {
        done: (text) => spinner.stop(text),
        failed: (text) => spinner.error(text),
      };
    },
    outro: (text) => clack.outro(text),
  };
}
