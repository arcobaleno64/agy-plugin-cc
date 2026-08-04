# Adapter Contract

```text
ENGINE_NAME: string
DELIVERS_PROMPT_VIA: "stdin" | "argv"   // argv 者必須文件化輸入驗證前提
detect() → { engine, binary /*resolved path 優先*/, version }   // 不可用時 throw
buildArgs({ prompt?, jobId? }) → string[]
buildSpawnOptions({ cwd, timeoutMs? }) → { cwd, env, timeoutMs?, shell }
parseOutput(rawText, exitCode) → { ok, error?, raw, ... }
cancel(pid) → { signaled, confirmedTerminated?, reason? }
```

## gemini-plugin-cc 對應表

- `binaryAvailable`／`resolveBinaryPath`（`process.mjs`）對應契約 `detect()` 的組成件。
- `terminateProcessTree` 對應契約 `cancel(pid)`：語意等價為樹殺與結果物件。
- Prompt 遞送：gemini 與 AGY >=1.1.2 使用 stdin；舊版、prerelease 或無法解析版本的 AGY 才使用 argv。AGY 的 positional fallback 會預先拒絕 NUL 與超過 24,000 字元的 prompt，並以絕對 `.exe` 路徑及 `shell:false` 啟動；model id 字元集白名單適用於兩個引擎。AGY >=1.1.5 的 `--model` 使用 `agy models` 列出的引擎別 ID，`--effort` 值域為 `low|medium|high`，兩者不可合併。
- 不改動 CC 既有函式命名（已發布 v0.6.6，Hyrum 面）；本檔為對照文件，宣告 CC 以語意等價符合契約。
