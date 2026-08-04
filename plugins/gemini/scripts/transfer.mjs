import path from 'node:path';
import { buildTransferSnapshot } from './lib/transfer-context.mjs';

function parseArgs(args) {
  let engine = 'auto';
  let model = null;
  let effort = null;
  let isJson = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--engine' && i + 1 < args.length) {
      engine = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === '--effort' && i + 1 < args.length) {
      effort = args[++i];
    } else if (arg === '--json') {
      isJson = true;
    } else {
      positional.push(arg);
    }
  }

  return { engine, model, effort, isJson, instructions: positional.join(' ') };
}

export function main() {
  const args = process.argv.slice(2);
  const { engine, model, effort, isJson, instructions } = parseArgs(args);

  try {
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

if (process.argv[1] && process.argv[1].endsWith('transfer.mjs')) {
  main();
}
