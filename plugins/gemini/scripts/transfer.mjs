import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, normalizeArgv } from './lib/args.mjs';
import { buildTransferSnapshot } from './lib/transfer-context.mjs';

const SELF_PATH = fileURLToPath(import.meta.url);
const VALID_ENGINES = new Set(['auto', 'gemini', 'agy']);

// The slash command hands the whole user tail over as one quoted "$ARGUMENTS"
// token, so it has to go through the same normalize + parse path as every
// gemini-companion subcommand.
export function parseTransferArgs(argv) {
  const { options, positionals } = parseArgs(normalizeArgv(argv), {
    valueOptions: ['engine', 'model', 'effort'],
    booleanOptions: ['json'],
  });

  const engine = String(options.engine ?? 'auto').trim().toLowerCase();
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(`Unknown engine "${options.engine}". Valid values: auto, gemini, agy.`);
  }

  // `json` stays in booleanOptions so it never leaks into the instructions text.
  return {
    engine,
    model: options.model ?? null,
    effort: options.effort ?? null,
    instructions: positionals.join(' '),
  };
}

// Resolved before parsing so an argument error is still reported in the shape
// the caller asked for.
// Mirrors how parseArgs resolves a boolean option, including `--json=false`
// and last-occurrence-wins, so both paths read the same flag the same way.
function wantsJson(tokens) {
  let value = false;
  for (const token of tokens) {
    if (token === '--json') value = true;
    else if (token.startsWith('--json=')) value = token.slice('--json='.length) !== 'false';
  }
  return value;
}

export function main() {
  const tokens = normalizeArgv(process.argv.slice(2));
  const isJson = wantsJson(tokens);

  try {
    const { engine, model, effort, instructions } = parseTransferArgs(tokens);
    const { snapshot, snapshotPath } = buildTransferSnapshot({ engine, model, effort, instructions });

    if (isJson) {
      console.log(JSON.stringify({
        success: true,
        transferId: snapshot.transferId,
        snapshotPath,
        engine: snapshot.engine,
        model: snapshot.model,
        effort: snapshot.effort,
      }, null, 2));
      return;
    }

    const relPath = path.relative(process.cwd(), snapshotPath).split(path.sep).join('/');
    const promptText = `Transferred context loaded from ${relPath}. ${snapshot.instructions}`;

    // POSIX single-quote escaping: 'foo'\''bar'
    const safePromptBash = `'${promptText.replace(/'/g, "'\\''")}'`;

    // PowerShell single-quote escaping: 'foo''bar'
    const safePromptPs = `'${promptText.replace(/'/g, "''")}'`;

    const agyFlags = [];
    if (snapshot.model) agyFlags.push(`--model ${snapshot.model}`);
    if (snapshot.effort) agyFlags.push(`--effort ${snapshot.effort}`);
    const agyExtra = agyFlags.length ? ' ' + agyFlags.join(' ') : '';

    console.log(`\x1b[32m✔ Session transfer snapshot created:\x1b[0m ${relPath}`);
    console.log(`\n\x1b[1mReady-to-run CLI Handoff Commands:\x1b[0m\n`);

    if (engine === 'agy' || engine === 'auto') {
      console.log(`\x1b[36m# Hand off to AGY CLI (Bash / Zsh): \x1b[0m`);
      console.log(`agy --add-dir .${agyExtra} --prompt ${safePromptBash}\n`);
      if (process.platform === 'win32') {
        console.log(`\x1b[36m# Hand off to AGY CLI (PowerShell): \x1b[0m`);
        console.log(`agy --add-dir .${agyExtra} --prompt ${safePromptPs}\n`);
      }
    }

    if (engine === 'gemini' || engine === 'auto') {
      const geminiFlags = snapshot.model ? ` --model ${snapshot.model}` : '';
      console.log(`\x1b[36m# Hand off to Gemini CLI (Bash / Zsh): \x1b[0m`);
      console.log(`gemini${geminiFlags} --prompt ${safePromptBash}\n`);
      if (process.platform === 'win32') {
        console.log(`\x1b[36m# Hand off to Gemini CLI (PowerShell): \x1b[0m`);
        console.log(`gemini${geminiFlags} --prompt ${safePromptPs}\n`);
      }
    }
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.error(`\x1b[31m✖ Transfer failed:\x1b[0m ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === SELF_PATH) {
  main();
}
