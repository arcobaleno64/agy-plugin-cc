# AGY 1.1.2 macOS/Linux 驗證清單

> **有日期的記錄，不是現況。** 本檔量的是外掛 v0.7.1 對 AGY **1.1.2**；當前為 AGY 1.1.13，其間新增了 `--output-format json`／`stream-json`（1.1.8／1.1.12）、print 模式的 slash command 展開（1.1.9）、真正生效的 `--model`／`--effort`（1.1.10）與唯讀 slash command（1.1.11）——本檔一項都沒涵蓋。沒有人在較新版本上重跑過這份清單。
>
> 保留它是因為它回答「當時在 macOS/Linux 上量到什麼」，那是別處沒有的資料。當前行為請看 [`../plugins/gemini/CHANGELOG.md`](../plugins/gemini/CHANGELOG.md) 與 [`THREAT-MODEL.md`](THREAT-MODEL.md) §7.2；文件分類見 [`README.zh-TW.md`](README.zh-TW.md)。

本清單驗證 `gemini-plugin-cc` v0.7.1 對真實 Antigravity CLI 1.1.2 的 stdin、stdout、transcript、背景工作、review、錯誤與 OAuth headless 行為。POSIX fake fixture 只能作為自動化基線，不能取代真實 AGY binary 與服務端回應。

## 固定範圍與安全界線

- 插件基準：tag `v0.7.1`，commit `6115ee184b02c429c3a220ade9ac7313c19a9283`。
- AGY 基準：穩定版 `1.1.2`；unknown、prerelease 或其他版本不得記為通過。
- 全程唯讀：不得使用 `--write`、`--dangerously-skip-permissions` 或修改專案檔案。
- 不登出、不破壞日常憑證。未登入測試必須使用隔離的空白 `HOME`。
- 每次 live call 使用唯一標記；執行期間不得同時啟動其他 AGY 工作，避免 transcript set-diff 配對歧義。
- stdout 只驗證 transport；成功、`DONE`、conversation ID 與 thinking 仍以 transcript 為權威來源。

官方依據：

- [Antigravity CLI 1.1.2 changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md#112)
- [Antigravity CLI 安裝說明](https://github.com/google-antigravity/antigravity-cli#installation)

## 判定規則

- **PASS**：實際在該 OS 執行，所有必要項目符合預期，並留下可核對的 exit code、marker、conversation ID 或 job ID。
- **FAIL**：有實際執行，但任一必要行為不符合預期。
- **BLOCKED**：沒有可用的該 OS 執行環境、AGY 1.1.2 binary 或安全的登入環境；不得以其他 OS 或 fake fixture 代替。

## 前置檢查

在 macOS 或 Linux 的 Bash/Zsh 執行：

```sh
uname -srm
agy --version
node --version
git --version
git rev-parse HEAD
command -v agy

for root in \
  "$HOME/.gemini/antigravity-cli/brain" \
  "$HOME/.antigravity-cli/brain"
do
  test -d "$root" && printf 'brain=%s\n' "$root"
done
```

驗收：

- `agy --version` 精確為 `1.1.2`。
- Node.js 為專案支援的 `18` 以上。
- Git commit 精確為上述 v0.7.1 commit。
- 至少一個 brain root 存在；兩個候選路徑都要探測，不得只依 OS 猜測。

若要隔離安裝 binary，先讀取官方平台 manifest，確認 `version`、下載 URL 與 SHA-512，再下載到暫存目錄。不得覆寫使用者現有 `agy`。2026-07-14 的官方 manifest 平台名稱為 `linux_amd64`、`linux_arm64`、`darwin_amd64` 與 `darwin_arm64`。

## 必要 live 驗證

下列範例以 `OS` 代表 `MACOS` 或 `LINUX`，日期改成實際執行日。

### 1. 原生 stdin、stdout 與 transcript

```sh
MARKER="OS_AGY112_DIRECT_YYYYMMDD"
printf 'Reply with exactly %s\n' "$MARKER" | agy --print-timeout 1m
```

驗收：

- 90 秒內完成且 exit code 為 `0`。
- stdout trim 後精確等於 marker。
- argv 沒有 positional prompt；本項使用 stdin 自動進入 print mode。
- 在其中一個 brain root 找到同一 marker，且同一 conversation 的 transcript 同時包含：
  - `USER_INPUT status=DONE`
  - `PLANNER_RESPONSE status=DONE`
  - response content 精確等於 marker

可用下列方式定位 transcript：

```sh
grep -R -l "$MARKER" \
  "$HOME/.gemini/antigravity-cli/brain"/*/.system_generated/logs/transcript_full.jsonl \
  "$HOME/.antigravity-cli/brain"/*/.system_generated/logs/transcript_full.jsonl \
  2>/dev/null
```

### 2. 插件前景 task

```sh
node plugins/gemini/scripts/gemini-companion.mjs task \
  --engine agy --fresh \
  "Reply with exactly OS_AGY112_PLUGIN_FOREGROUND_YYYYMMDD"
```

驗收：exit `0`、使用者輸出為 marker、沒有 touched files，且新 conversation transcript 的 input、`DONE` response 與 marker 一致。

### 3. 插件背景 task

```sh
node plugins/gemini/scripts/gemini-companion.mjs task \
  --background --engine agy --fresh \
  "Reply with exactly OS_AGY112_PLUGIN_BACKGROUND_YYYYMMDD"

node plugins/gemini/scripts/gemini-companion.mjs status <job-id> --json
node plugins/gemini/scripts/gemini-companion.mjs result <job-id> --json
```

驗收：

- job 進入 `completed`，exit status 保持 `0`。
- `status`、`result.rawOutput` 與 transcript marker 一致。
- `threadId` 精確指向含 `PLANNER_RESPONSE status=DONE` 的 conversation。
- `touchedFiles` 為空。

### 4. 小型結構化 review

使用小型、既有的唯讀 diff，避免把 transport 驗證混入大型 prompt 壓力測試。v0.7.1 歷史中的 `2a09e6d33528a58a7ab824a39a359b50ee94c198` 是單檔文件 commit，可作為固定 target。

```sh
PLUGIN_REPO="$(pwd)"
TARGET="${TMPDIR:-/tmp}/agy112-review-target-YYYYMMDD"
git clone "$PLUGIN_REPO" "$TARGET"
git -C "$TARGET" checkout --detach 2a09e6d33528a58a7ab824a39a359b50ee94c198

node "$PLUGIN_REPO/plugins/gemini/scripts/gemini-companion.mjs" review \
  --wait --engine agy --cwd "$TARGET" \
  --base HEAD~1 --scope branch
```

驗收：exit `0`、輸出可解析成插件 review 結構，且配對 transcript 的最終 `PLANNER_RESPONSE` 為 `DONE` 並包含同一份 JSON 結果。

### 5. 無效 model 必須 fail-fast

```sh
AGY_BIN="$(command -v agy)" node - <<'NODE'
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.env.AGY_BIN, [
  "--model", "codex-invalid-model-validation",
  "--print-timeout", "1m"
], {
  input: "This prompt must not run.\n",
  encoding: "utf8",
  timeout: 20_000
});
console.log(JSON.stringify({
  status: result.status,
  signal: result.signal,
  stdout: result.stdout,
  stderr: result.stderr,
  spawnError: result.error?.message ?? null
}, null, 2));
NODE
```

驗收：20 秒內非零退出、signal 為空、stdout 為空、stderr 非空且同時說明 model 無效並列出可用模型。

### 6. 真正 headless OAuth 必須 fail-fast

Node 的 `detached: true` 會在 POSIX 建立沒有 controlling terminal 的新 session；空白暫存 `HOME` 隔離日常憑證。

```sh
AGY_BIN="$(command -v agy)" node - <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy112-headless-"));
const started = Date.now();
const result = spawnSync(process.env.AGY_BIN, ["--print-timeout", "1m"], {
  detached: true,
  input: "This prompt must not run.\n",
  encoding: "utf8",
  timeout: 20_000,
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config")
  }
});

console.log(JSON.stringify({
  elapsedMs: Date.now() - started,
  status: result.status,
  signal: result.signal,
  stdout: result.stdout,
  stderr: result.stderr,
  spawnError: result.error?.message ?? null
}, null, 2));
NODE
```

驗收：20 秒內非零退出、沒有 timeout/kill signal、stdout 為空，stderr 明確要求先互動登入。若保留 controlling terminal，AGY 改從 `/dev/tty` 等待授權碼是另一條預期路徑，不能用來判定真正 headless fail-fast。

### 7. 程序與自動化基線

```sh
pgrep -af agy
npm test
npm run check-version
npm run verify-contracts
git status --short
```

驗收：沒有本次測試遺留的 AGY/MCP 程序；完整測試、版本與契約檢查通過；正式 repo 保持乾淨。

## 2026-07-14 執行結果

### 平台結論

| 平台 | 實際環境 | 結論 | 說明 |
|---|---|---|---|
| Linux x86_64 | Ubuntu 24.04.4 LTS，WSL2 kernel `6.18.33.2-microsoft-standard-WSL2` | **PASS（WSL2）** | 真實 Linux AGY 1.1.2 binary、服務端、OAuth、stdout 與 transcript 均已執行。WSL2 不等同 bare-metal Linux，若 v0.8.0 要承諾原生 distro，可再補一台非 WSL 主機。 |
| macOS | 無可用主機；repository self-hosted runners 為 0 | **OPTIONAL / NOT RUN** | 只確認官方 Darwin x64/arm64 manifest 皆為 1.1.2；未執行 binary、登入、stdin 或 transcript。這不阻塞純 Node/plugin 邏輯或 v0.8.0；也不得宣稱 macOS 1.1.2 已 live verified。 |

### Linux 證據

- 隔離 binary：官方 Linux x64 tarball 的 SHA-512 驗證通過，`agy --version` 為 `1.1.2`；既有 `/root/.local/bin/agy` 仍為 `1.1.1`，未覆寫。
- 正式插件：從公開 tag `v0.7.1` clone，commit 與版本分別為 `6115ee184b02c429c3a220ade9ac7313c19a9283`、`0.7.1`。
- brain root：AGY 1.1.2 實際使用 `/root/.gemini/antigravity-cli/brain`；`/root/.antigravity-cli/brain` 不存在。
- 原生 stdin：7.4 秒、exit `0`、stdout 精確為 `LINUX_AGY112_DIRECT_20260714`；conversation `81b6706c-56b9-49b3-8cdd-42af62f4a797` 的 transcript 含相同 marker。
- 前景 task：6.6 秒、exit `0`；conversation `a877ac93-7de8-43c4-8a2f-63460d7c95c1` 的 `USER_INPUT` 與 `PLANNER_RESPONSE status=DONE` 配對成功。
- 背景 task：job `task-mrke927m-d90f31a1b9` 於 4 秒完成；thread `6f006db2-ee2a-4522-bf2b-d4f7ad53aa45`、`result.rawOutput`、transcript marker 一致，`touchedFiles=[]`。
- Review：7.3 秒、exit `0`、結構化 verdict `approve`；conversation `7d6d2927-caa7-4f19-9d07-d245aa29b616` 的最終 response 為 `DONE` 且包含同一 JSON。
- 無效 model：3.2 秒內 exit `1`、無 signal、stdout 空；stderr 說明 model 無效並列出 8 個可用模型。
- OAuth with TTY：隔離空白 `HOME` 時，AGY 顯示授權 URL 並宣告 60 秒等待，證實 prompt stdin 已占用時會改讀 controlling terminal；驗證 harness 於 20 秒上限終止。
- OAuth truly headless：Node `detached: true`、隔離空白 `HOME`，745 ms 內 exit `1`；stderr 明確要求先執行互動登入，沒有 timeout 或 signal。
- 程序清理：未發現本次 binary 的殘留 AGY 程序。
- 自動化：Linux 完整測試 `237/237`；`npm run check-version` 與 `npm run verify-contracts` 通過。

### 剩餘決策閘門

- macOS 真實 1.1.2 全套驗證尚未執行，但它是額外平台信心，不是 v0.8.0 的必要進入條件。
- 本次證明 Linux stdout 可用，但 transcript 仍提供 `DONE`、conversation ID、thinking 與可靠配對；不能據此移除 transcript recovery。
- 本次只驗證 AGY 原生無效 model 的上游行為，未授權插件開始傳遞 `--model`；公開參數契約仍未改變。

### 下一次租用 macOS 的觸發條件

預設不租用 macOS。只有以下任一條件成立時，才建立 macOS live-validation issue，並在相關變更合併前執行本清單：

- 修改 `agyBrainRoots()`、Darwin 路徑解析、transcript discovery/matching、mtime 或 conversation 配對邏輯。
- 修改 POSIX process group、signal、timeout、stdio、detached session 或 controlling-terminal 行為。
- 修改 OAuth code 的 stdin／`/dev/tty` 路徑，或 AGY 上游 changelog 明示 Darwin-specific 變更。
- 準備對外宣稱「macOS + AGY 1.1.2（或後續指定版本）已 live verified」。
- 收到可重現的 macOS-specific 安裝、執行、transcript 或清理缺陷。

若以上條件均未成立，Windows live、真實 Linux AGY 與 POSIX integration tests 即為本 adapter 的必要驗證集合；不得僅為一般 Node/plugin 邏輯租用 Mac。

### 本次暫存項目

- WSL 驗證資料位於 `/tmp/agy112-verify-20260714-1`、`/tmp/gemini-plugin-cc-v071-verify`、`/tmp/agy112-linux-review-target` 與隔離 headless HOME。
- 一次失敗的 PowerShell/Bash 變數傳遞將已校驗但未執行的 tarball 放在 WSL `/agy.tar.gz`。依刪除授權規範，本次未自行刪除。
