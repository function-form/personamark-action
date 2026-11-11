import { appendFileSync } from "node:fs";
import { EOL } from "node:os";

/**
 * The few parts of the Actions runner protocol this action needs, without @actions/core: inputs
 * come in as `INPUT_*`, and outputs and the job summary are appended to the files the runner names.
 */

export interface Runner {
  input(name: string): string;
  output(name: string, value: string): void;
  summary(markdown: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/** `::` commands read `%`, CR and LF specially, so a message is escaped before it's printed. */
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

export function processRunner(env: NodeJS.ProcessEnv = process.env): Runner {
  return {
    input: (name) => (env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim(),
    output(name, value) {
      const file = env.GITHUB_OUTPUT;
      if (!file) return;
      // The heredoc form, with a delimiter the value can't contain.
      const delimiter = `pm_${crypto.randomUUID()}`;
      appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
    },
    summary(markdown) {
      const file = env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, `${markdown}${EOL}`);
    },
    info: (message) => {
      console.log(message);
    },
    warning: (message) => {
      console.log(`::warning::${escapeData(message)}`);
    },
    error: (message) => {
      console.log(`::error::${escapeData(message)}`);
    },
  };
}
