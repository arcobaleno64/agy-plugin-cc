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

## agy-plugin-cc 對應表

- `binaryAvailable`／`resolveBinaryPath`（`process.mjs`）對應契約 `detect()` 的組成件。
- `terminateProcessTree` 對應契約 `cancel(pid)`：語意等價為樹殺與結果物件。
- Prompt 遞送：gemini 與 AGY >=1.1.2 使用 stdin；舊版、prerelease 或無法解析版本的 AGY 才使用 argv。AGY 的 positional fallback 會預先拒絕 NUL 與超過 24,000 字元的 prompt，並以絕對 `.exe` 路徑及 `shell:false` 啟動；model id 字元集白名單適用於兩個引擎。AGY >=1.1.10 的 `--model` 使用 `agy models` 列出的引擎別 ID，`--effort` 值域為 `low|medium|high`，兩者不可合併；1.1.5–1.1.9 雖接受這兩個旗標，卻在 headless 執行時忽略它們而靜默落回預設模型，故一律拒絕並要求升級。AGY >=1.1.9 一律加上 `--disable-slash-commands`，避免 print mode 把位於 prompt 開頭的使用者文字當成 slash command 或 skill 展開。
- 結果回收：AGY >=1.1.8 以 `--output-format json` 的 stdout envelope 為權威來源（`conversation_id`／`status`／`response`），不讀磁碟 transcript、不需要 brain root；`status: "ERROR"` 時其 `error` 字串送入失敗分類器，故 rate-limit 與 model-unavailable 樣式比對得以生效。該版本以上若 stdout 不是可解析的 envelope，直接判為 `invalid-json`，不回頭掃 transcript——版本既已承諾 envelope，掃磁碟只會掩蓋真正的故障。AGY <1.1.8 維持 transcript recovery（spawn 前後比對 conversation 目錄）。代價：envelope 只有 `thinking_tokens` 計數而無 thinking 文字（`stream-json` 亦然），故 AGY 結果不再提供 reasoning summary。
- 不改動 CC 既有函式命名（已發布 v0.6.6，Hyrum 面）；本檔為對照文件，宣告 CC 以語意等價符合契約。
