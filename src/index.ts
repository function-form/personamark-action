import { processRunner } from "./actions.ts";
import { run } from "./run.ts";

const runner = processRunner();
try {
  process.exitCode = await run({ runner });
} catch (error) {
  runner.error(`PersonaMark audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
