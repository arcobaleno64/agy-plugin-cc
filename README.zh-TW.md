# Gemini / Antigravity Companion for Claude Code

> 在 Claude Code 內使用 Gemini CLI 或 Antigravity CLI (`agy`) 進行 task delegation、pragmatic code review 與 adversarial review。

**為 Google Gemini CLI 到 Antigravity CLI 的遷移期而準備。**
`gemini-plugin-cc` 保留熟悉的 Claude Code slash-command workflow；Gemini CLI 可用時可走 Gemini CLI，遷移到 Antigravity CLI (`agy`) 的使用者則可改走 AGY engine。

本外掛移植自 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Apache-2.0），在保留熟悉的斜線命令與背景工作模型之同時，將行為調適至 Gemini/AGY 能力並記錄刻意之差異。

---

## 為什麼選這個外掛？

`gemini-plugin-cc` 是 Claude Code-native 的 companion bridge，適合在 Google Gemini CLI transition 期間同時保留 Gemini CLI 與 Antigravity CLI (`agy`) 路徑的使用者。

相較於 AGY-only、多宿主外掛，本專案保留 Gemini CLI 可用時的路徑，同時提供明確的 `--engine agy` 給正在遷移到 Antigravity CLI 的使用者。

- Claude Code-native 的 `/gemini:*` slash commands。
- 對目前 diff 或 branch 執行 pragmatic code review 與 adversarial review。
- 用 background task delegation 處理較長時間的 companion-agent 工作。
- Gemini model aliases、graceful model fallback 與 transient review retry。
- 具版本分流的 AGY prompt transport，並以 transcript recovery 為權威來源。
- Gemini 與 AGY 1.1.2 以上採用較安全的 stdin prompt delivery。

| 需求 | 適合使用本外掛的情境 |
|---|---|
| Gemini CLI 仍可用 | 你需要 model selection、JSON output 與 stdin prompt delivery。 |
| 正在遷移到 AGY | 使用 `--engine agy` 作為完整支援的 Antigravity CLI 後端。 |
| 需要 adversarial review | 使用 `/gemini:adversarial-review`，可加 focus text。 |
| 需要 AGY-only 多宿主支援 | 可考慮 AGY-only plugin。 |

---

## 功能特色

- **`/gemini:rescue`** — 將調查、除錯或實作任務委派給所選的 Gemini CLI 或 AGY 引擎。可在前景執行或以背景工作方式分離執行。
- **`/gemini:transfer`** — 匯出當前工作區情境（git status、diff、接續指令）為結構化 JSON 快照，並輸出單引號跳脫之 AGY / Gemini CLI 接手命令（各平台皆印 POSIX Bash 形式，Windows 另加印 PowerShell 形式）。
- **`/gemini:review`** — 對當前 diff 或分支執行標準（務實）程式碼審查，找出真實 bug、缺漏之錯誤處理與未竟之程式路徑。加 `--deep` 可進行 agentic 探查、看 diff 以外的 repo 脈絡。
- **`/gemini:adversarial-review`** — 對當前 diff 或分支執行對抗性程式碼審查，挑戰設計決策，回傳含嚴重程度評級的結構化發現。
- **`/gemini:setup`** — 檢查 Gemini CLI / AGY 的可用性與 OAuth 狀態。
- **`/gemini:status`** — 查看作用中與已完成的背景工作。
- **`/gemini:result`** / **`/gemini:cancel`** — 取得或取消背景工作。
- **引擎自動偵測** — 兩個引擎皆為第一級支援；`auto` 因 JSON／model 合約先檢查 `gemini`，再檢查 `agy`。
- **版本感知的 stdin 提示傳遞** — Gemini 固定走 stdin；AGY 1.1.2 以上走自動 print 的 stdin 路徑，舊版或版本不明時保留 positional 相容路徑。
- **會話生命週期掛鉤** — 自動注入 `GEMINI_COMPANION_SESSION_ID`；會話結束時清理殘留工作。

---

## 系統需求

| 項目 | 版本 | 安裝方式 |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| Gemini CLI | ≥ 0.40；使用 `gemini` 引擎時必須安裝 | `npm install -g @google/gemini-cli` |
| AGY | ≥ 1.0.3；建議 ≥ 1.1.2，已於 Windows／Ubuntu WSL2 live 驗證 | _(安裝指令見下)_ |
| Claude Code | 任意版本 | [claude.ai/code](https://claude.ai/code) |

**安裝 AGY**（使用 `--engine agy` 時必須安裝）：`curl -fsSL https://antigravity.google/cli/install.sh | bash`

**認證**：兩個引擎各自認證。Gemini 引擎請執行一次 `gemini`；AGY 引擎請互動式執行一次 `agy`。AGY 1.1.10+ 亦支援 Application Default Credentials (ADC) 與 Gemini Enterprise / Workforce Identity Federation (WIF)。Headless setup probe 無法可靠驗證 AGY 認證，因此 `/gemini:setup --engine agy` 會將其標為 unknown，直到真實 AGY 命令成功。不需要 API 金鑰。

> **重要提示（貼近現實）：**
> - **2026-06-18 consumer transition**：Google 宣布免費／個人版、Google AI Pro、Google AI Ultra 的 Gemini CLI requests 於此日期後停止服務；Standard/Enterprise access 維持。詳見 Google 的 [Gemini CLI to Antigravity CLI announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)。
> - **模型可用性會隨 CLI 版本漂移。** 2026-06-02 以 gemini CLI 0.44.1 實測時，`gemini-3.5-*` 回 `404 ModelNotFound`；新版 CLI 可能不同。若所請求 id 不可用，外掛會優雅降級至 GA 模型。詳見 [模型別名](#模型別名) 與 [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md)。

---

## 安裝

### 發布通道（marketplace 來源追蹤 `main`）

```
# 1. 加入 marketplace
/plugin marketplace add arcobaleno64/gemini-plugin-cc

# 2. 安裝外掛
/plugin install gemini@gemini-plugin-cc

# 3. 重新載入外掛
/reload-plugins
```

此 marketplace 的來源追蹤 repository 的 `main` 分支，但這**不表示**每次啟動 Claude Code 都一定會自動安裝並啟用新程式碼：

- Claude Code 依本外掛 manifest 中的明確版本號辨識更新。既有安裝只會在該版本號提高時更新（通常隨正式發布進行）；若 `main` 只有新 commit、manifest 版本號不變，該 commit 不會被當成外掛更新交付。
- 第三方 marketplace 預設關閉自動更新。如要啟用，請開啟 `/plugin`，選擇 **Marketplaces** → **gemini-plugin-cc** → **Enable auto-update**。啟用後，Claude Code 會在啟動時檢查 marketplace，並更新 resolved version 已變更的已安裝外掛。
- 若 Claude Code 顯示外掛已更新，請先執行 `/reload-plugins`，再於目前 session 使用。因此，僅打開 Claude Code 不能保證剛發布的版本已經生效。

若不啟用自動更新，可明確執行：

```
/plugin marketplace update gemini-plugin-cc
/plugin update gemini@gemini-plugin-cc
/reload-plugins
```

### 釘選發布版（指定某個已發布版本）

將 marketplace 釘到某個 release 標籤——例如 `v0.9.1`：

```
/plugin marketplace add arcobaleno64/gemini-plugin-cc@v0.9.1
/plugin install gemini@gemini-plugin-cc
/reload-plugins
```

> Claude Code 從 git tree 安裝外掛，**並非**從 GitHub Releases 的 tarball——`@<tag>` 選的是 [Release](https://github.com/arcobaleno64/gemini-plugin-cc/releases) 背後的 git 標籤。即使啟用 marketplace 自動更新，釘選的 marketplace 仍會停在該標籤。若要移至另一個 release，請先移除既有 marketplace（這也會解除安裝由它安裝的外掛），再以新標籤加入 repository、重新安裝外掛，最後執行 `/reload-plugins`。

接著對 `auto`／Gemini 執行 `/gemini:setup`，或對 AGY 執行 `/gemini:setup --engine agy`。只需安裝所選引擎的 dependency；若缺少，setup 會提供對應安裝選項。

若 Gemini 已安裝但尚未完成認證，請執行：

```
!gemini
```

---

## 快速開始

```
# 將任務委派給 Gemini（前景執行）
/gemini:rescue 調查為什麼 auth middleware 對有效 token 回傳 401

# 背景執行，稍後查看結果
/gemini:rescue --background 為 UserService 類別新增單元測試
/gemini:status

# 對當前 diff 執行對抗性審查
/gemini:adversarial-review

# 聚焦特定面向的審查
/gemini:adversarial-review 重點關注工作佇列中的競態條件
```

---

## 命令說明

### `/gemini:rescue [提示]`

將任務委派給 Gemini。若未提供提示，則從 stdin 讀取。

| 旗標 | 說明 |
|---|---|
| `--background` | 分離執行；立即回傳工作 ID |
| `--write` | 允許 Gemini 修改檔案（`--yolo` / `--dangerously-skip-permissions`） |
| `--resume-last` | 繼續最近一次的 Gemini 工作階段 |
| `--fresh` | 強制開啟全新 Gemini 工作階段，忽略可接續的執行緒 |
| `--engine <gemini\|agy\|auto>` | 覆蓋引擎選擇 |
| `--model <別名\|ID>` | 指定模型。Gemini 解析其別名；AGY 1.1.10+ 要求使用 `agy models` 列出的精確 model ID。AGY 的模型選擇不可與 `--effort` 或雙引擎（`--engines gemini,agy`）審查合併。 |
| `--effort <low\|medium\|high\|xhigh>` | Gemini 將 effort 映射為模型；AGY 1.1.10+ 在未指定 AGY model 時，原生傳遞 `low`、`medium` 或 `high` 推理強度。 |

### `/gemini:transfer [instructions...]`

匯出當前工作區情境（git diff、status、接續指令），並產生可直接複製執行的 CLI 接手命令（`agy`/`gemini`），移交給獨立終端機進行互動開發。包含自動化機密遮蔽（`.env*`、憑證）與 Git 衝突安全鎖定。產生的命令僅供使用者自行貼上執行，plugin 不會代為執行。

| 旗標 | 說明 |
|---|---|
| `--engine <gemini\|agy\|auto>` | 決定輸出哪一種接手命令；`auto`（預設）兩種都印 |
| `--model <ID>` | 帶入產生命令的模型指定。AGY 要求使用 `agy models` 列出的精確 ID |
| `--effort <low\|medium\|high\|xhigh>` | 帶入產生之 AGY 命令的推理強度，不可與 `--model` 併用 |

### `/gemini:review`

對當前工作樹或分支 diff 執行標準、務實之審查——真實 bug、缺漏之錯誤處理、未竟之程式路徑。不可導向、不接受焦點文字；如需挑戰特定決策請用 `/gemini:adversarial-review`。

| 旗標 | 說明 |
|---|---|
| `--wait` / `--background` | 前景或分離執行 |
| `--deep` | Agentic 審查——讓 Gemini 探查 diff 以外的 repo 脈絡（較慢、較耗 token；gemini 引擎） |
| `--base <ref>` | 與特定 git ref 比較 |
| `--scope <auto\|working-tree\|branch>` | Diff 範圍 |
| `--engine <gemini\|agy\|auto>` | 覆蓋引擎 |
| `--model <別名\|ID>` | 指定模型 |
| `--effort <level>` | Gemini 的模型選擇；未指定 AGY model 時的 AGY 1.1.10+ 原生推理強度（`low`、`medium`、`high`） |

### `/gemini:adversarial-review [焦點]`

對當前工作樹或分支 diff 執行對抗性審查。

| 旗標 | 說明 |
|---|---|
| `--deep` | Agentic 審查——讓 Gemini 探查 diff 以外的 repo 脈絡（較慢、較耗 token；gemini 引擎） |
| `--base <ref>` | 與特定 git ref 比較 |
| `--scope <auto\|working-tree\|branch>` | Diff 範圍 |
| `--engine <gemini\|agy\|auto>` | 覆蓋引擎 |
| `--model <別名\|ID>` | 指定模型 |
| `--effort <level>` | Gemini 的模型選擇；未指定 AGY model 時的 AGY 1.1.10+ 原生推理強度（`low`、`medium`、`high`） |

### `/gemini:setup`

印出 Node、Gemini CLI 與 AGY 的可用性及認證狀態。

### `/gemini:status [工作-ID]`

列出作用中與近期的背景工作。傳入工作 ID 以查看單一工作。

| 旗標 | 說明 |
|---|---|
| `--wait` | 阻塞直到工作完成（需提供工作 ID） |
| `--all` | 顯示所有工作，不限本次會話 |

### `/gemini:result [工作-ID]`

取得已完成工作的輸出內容。若工作帶有 Gemini session ID，輸出中會包含 `Resume in Gemini: gemini --resume <session-id>`——將該命令貼到終端機即可直接在 Gemini CLI 中接續工作階段。

### `/gemini:cancel [工作-ID]`

取消執行中或佇列中的背景工作。

---

## Review Gate（可選）

可選的停止時審查閘門，當本次 session 有 `--write` 工作完成時，在 Claude Code 停止前自動執行對抗性審查。預設停用。

透過 `/gemini:setup` 啟用或停用：

```
# 啟用
/gemini:setup --enable-review-gate

# 停用
/gemini:setup --disable-review-gate
```

啟用後，若審查回傳 `needs-attention`，Claude Code 將被阻止停止並顯示發現摘要。執行 `/gemini:adversarial-review --wait` 查看完整發現，決定是否接受或修正後再繼續。

---

## 模型別名

| 別名 | 對應模型 | 說明 |
|---|---|---|
| `flash` / `flash3` | `gemini-3-flash-preview` | Gemini 3 Flash（preview） |
| `pro` / `pro3` | `gemini-3.1-pro-preview` | Gemini 3.1 Pro（preview） |
| `flash25` | `gemini-2.5-flash` | 穩定 2.5 Flash（GA） |
| `pro25` | `gemini-2.5-pro` | 穩定 2.5 Pro（GA） |
| `lite` / `fast` | `gemini-2.5-flash-lite` | 高效低成本（GA） |
| `lite3` | `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite（GA，低成本） |

### 模型別名說明

- 別名與努力等級集中於單一來源——`plugins/gemini/scripts/lib/model-map.mjs`——且 `npm test` 會以其驗證上表，二者不致漂移。
- **努力對映**（於提供 `--effort` 但未給 `--model` 時套用）：`none`/`minimal` → `gemini-2.5-flash-lite`；`low`/`medium` → `gemini-3-flash-preview`；`high`/`xhigh` → `gemini-3.1-pro-preview`。
- **CLI probe snapshot。** 上表反映 2026-06-02 以 gemini CLI 0.44.1 進行的 model-map 實測；新版 Gemini CLI 可能提供不同 model ID。若某別名無法解析，以 `--model <精確 ID>` 覆蓋——任何非已知別名之值將原樣透傳給 CLI。
- **Gemini 3.5 可用性會漂移。** 2026-06-02 以 gemini CLI 0.44.1 實測時，`gemini-3.5-flash` 與 `gemini-3.5-pro` 回 `404 ModelNotFound`；新版 CLI 可能不同。未知或不可用 model ID 會優雅降級至 GA fallback。
- **模型優雅降級。** 若所請求之 model id 在你的 gemini CLI 上找不到（preview/已退役 id，或 CLI 版本落差），外掛會**以 GA fallback `gemini-2.5-flash` 重試一次**並印出明確提示——讓過時 id 優雅降級，而非硬性失敗。
- **AGY model selection 尚未由本外掛管理。** 部分 AGY 版本提供自己的 `--model` 介面，但 `--engine agy` 目前走 AGY 的 configured/default model；本外掛不會把 `--model` 或 `--effort` 翻譯成 AGY 參數。若要由外掛管理 model selection，請用 `--engine gemini`。

---

## 引擎路由

在 `auto` 模式下，外掛依以下優先順序選擇可用引擎：

1. **`gemini` CLI** — 透過 stdout 輸出；支援 stdin 提示傳遞。
2. **`agy`** — 第一級支援引擎及 `auto` 的第二候選；AGY 1.1.2 以上以 stdin 接收 prompt 且不帶 `--print`，舊版或版本不明時保留 `agy --print <prompt>`。

可透過 `--engine` 旗標或 `GEMINI_ENGINE` 環境變數覆蓋。

> **AGY 1.1.10+ 選擇機制：** 使用 `agy models` 所列的 `--model <精確 ID>`，或使用 `--effort <low|medium|high>` 二者之一。Gemini alias 不是有效的 AGY model ID，model 與 effort 不可合併；雙引擎審查不可使用 `--model`，因為 model ID 具引擎特性。Gemini 仍維持其獨立的 alias 與 effort-to-model 映射。

> **AGY transcript recovery 仍是權威來源。** 舊版 positional `agy --print` 沒有 piped response（上游 [google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466)，已於 macOS AGY 1.0.7 重現）。外掛 v0.7.1 對 AGY 1.1.2 以上改走自動 print 的 stdin 路徑，但完成回應、DONE 狀態、thinking 與 conversation ID 仍取自磁碟 transcript。已知 brain root 為 `~/.gemini/antigravity-cli/brain`（已於 Windows、macOS AGY 1.0.7 與 Linux AGY 1.1.2 驗證）及 `~/.antigravity-cli/brain`（較舊的 Linux 1.0.2，回報）。1.1.2 stdin 路徑已於 Windows 與 Ubuntu 24.04 WSL2 live 驗證，並有 POSIX integration fixture；真實 macOS 1.1.2 驗證刻意列為 optional，尚未執行。若找不到 brain root，請先執行一次 `agy` 或開 issue 回報實際位置。

---

## 安全性

- **Stdin 傳遞**：Gemini prompt 與 AGY 1.1.2 以上 prompt 透過 Node.js `spawnSync` 的 `input` 傳遞，不進入 argv。AGY 1.1.2 以下或版本無法解析時保留 positional 相容路徑與 24,000 字元上限；處理不可信內容時請使用 Gemini 或 AGY 1.1.2 以上。
- **Windows process 邊界**：Gemini 的 npm `.cmd` shim 以 `shell:true` 啟動，但 prompt 留在 stdin，argv 只有已驗證旗標。AGY 必須解析成絕對 `.exe`，並固定以 `shell:false` 啟動。
- **Git process 邊界**：repository-derived ref 一律以 literal argv 與 `shell:false` 傳給 Git（Windows 亦同）；Git helper 不繼承 `.cmd` wrapper fallback。此處與上游 Codex 外掛 [v1.0.6 移除 Git shell expansion](https://github.com/openai/codex-plugin-cc/releases/tag/v1.0.6) 的 hardening 方向一致。
- **DEP0190 警告屬無害**：於 Windows 上可能見到 `(node:NNN) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.`。此處**可安心忽略**——該 deprecation 針對的是在 `shell: true` 下把*提示內容*放入 argv，但本外掛的 gemini 引擎從不如此：提示走 stdin，僅受控旗標進入 argv（且各自驗證，如 model id 須符合 `^[A-Za-z0-9][A-Za-z0-9._-]*$`）。此警告是 Node 對該通用模式的提醒，並非本程式路徑中的實際注入點。
- **AGY transport 回退**：只有可穩定解析為 1.1.2 以上的版本才啟用 stdin；未知版與 prerelease 字串一律 fail closed 至既有 positional 路徑，不假設上游能力。
- **AGY 1.1.10+ `.git` 沙箱規則**：AGY 1.1.10 在沙箱模式下實作 `.git` 目錄唯讀防護規則，保護版本庫 metadata 與 commit 歷史在審查及子代理人任務期間不被意外修改。
- **憑證處理**：`~/.gemini/oauth_creds.json` 之 OAuth 憑證僅用於 `getGeminiLoginStatus()` 檢查 token 是否過期；本外掛從不記錄、複製或傳輸之。
- **`.gitignore`**：`.omc/` 狀態目錄（工作日誌、會話狀態）已排除於版本控制之外。

---

## 安裝與認證疑難排解

| 症狀 | 原因 | 解法 |
|---|---|---|
| `gemini: not found` | 未安裝 Gemini CLI | `npm install -g @google/gemini-cli`，或執行 `/gemini:setup` 接受安裝提示 |
| `npm: not found` | PATH 中缺 Node/npm | 自 [nodejs.org](https://nodejs.org) 安裝 Node.js ≥ 18 |
| setup 顯示 `gemini auth: No credentials …` | 未完成 OAuth | 執行一次 `!gemini` 並完成瀏覽器登入 |
| setup 顯示 `… token expired` | OAuth token 已過期 | 再次執行 `!gemini` 以更新憑證 |
| `Status: partial (AGY available …)` | Gemini CLI 不可用但 AGY 存在 | 直接使用 `--engine agy`；setup 因無法非互動驗證 AGY 的獨立 OAuth flow，會維持 auth `unknown` |
| Windows：命令可解析但執行失敗 | `.cmd` wrapper／PATH | 確認 `where gemini` 可解析；外掛以 `shell: true` 啟動裸命令名以尋得 `.cmd` shim |
| `--engine agy` 回報找不到 brain 根目錄 | AGY 尚未建立 brain 目錄，或其位於未知位置 | 先執行一次 `agy` 讓其建立 brain 目錄。已知路徑：`~/.gemini/antigravity-cli/brain`（已於 Windows、macOS AGY 1.0.7 與 Linux AGY 1.1.2 驗證）與 `~/.antigravity-cli/brain`（較舊的 Linux 1.0.2，回報）；若不同請開 issue 回報其位置 |

Gemini 引擎請執行一次 **`!gemini`**——外掛即以呼叫 `gemini` 自身完成 OAuth，**並無** `gemini login` 子命令。AGY 引擎請互動式執行一次 `agy`；其獨立 OAuth 狀態不由 Gemini 的 `~/.gemini/oauth_creds.json` 推定。AGY binary 存在但 auth 無法驗證時，setup 會回報 `partial`。

---

## 運作原理

```
Claude Code
  └─ /gemini:rescue "提示"
       └─ gemini-companion.mjs task
            ├─ detectEngine()        → gemini | agy
            ├─ buildCliArgs()        → 依版本組合引數
            ├─ runCommand()          → spawnSync
            │    input: prompt       ← Gemini + AGY ≥1.1.2
            │    argv: prompt        ← 舊版／未知版 AGY（24K 上限）
            └─ renderTaskResult()   → Markdown 輸出至 Claude
```

背景模式會產生一個分離的 `task-worker` 子程序並立即回傳工作 ID。狀態持久化於 `.omc/state/`，可透過 `/gemini:status` 查詢。

---
            └─ renderTaskResult()   → Markdown 輸出至 Claude
```

背景模式會產生一個分離的 `task-worker` 子程序並立即回傳工作 ID。狀態持久化於 `.omc/state/`，可透過 `/gemini:status` 查詢。

---

## 與 codex-plugin-cc 的對應

本外掛為 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的高保真移植版。公開的斜線命令介面、背景工作模型，以及 state/result/status/cancel 流程皆鏡像上游；執行後端則為第一級支援的 Gemini CLI 與 AGY 引擎，而非 Codex app server。

### 相容性對照表

| 上游（Codex） | 本外掛（Gemini） | 對應程度 |
|---|---|---|
| `/codex:setup` | `/gemini:setup` | **Gemini 專屬差異** — 依所選第一級引擎檢查 Gemini OAuth 或 AGY binary readiness，而非 Codex 認證 |
| `/codex:review` | `/gemini:review` | **最佳等效** — prompt／CLI adapter 審查，非原生審查器 |
| `/codex:adversarial-review` | `/gemini:adversarial-review` | **最佳等效** — 對同一 diff target 施以對抗性 prompt |
| `/codex:rescue` | `/gemini:rescue` | **1:1 對等** — 相同的 forwarder／subagent 合約與旗標 |
| `/codex:transfer` | `/gemini:transfer` | **1:1 對等** — 匯出會話快照並產生 AGY / Gemini CLI 移交接手啟動命令 |
| `/codex:status` | `/gemini:status` | **1:1 對等** — 相同工作模型；`--all` 跨 Claude session |
| `/codex:result` | `/gemini:result` | **Gemini 專屬差異** — 顯示 Gemini session id 與 `gemini --resume` |
| `/codex:cancel` | `/gemini:cancel` | **1:1 對等** — 相同的 process-tree 終止（POSIX 與 Windows） |

### Codex app server 與 Gemini CLI adapter

- **執行時**：Codex 使用常駐 app-server，具原生審查與持久 thread。本外掛則於*每次命令*直接呼叫所選的第一級 Gemini CLI 或 AGY 引擎（無共享執行時）；`auto` 採 Gemini→AGY 的 capability-based 順序。
- **標準審查**：Codex 外掛之 `/codex:review` 為*原生*審查器；本外掛之 `/gemini:review` 為 **prompt／CLI adapter 等效實作**——將 diff 連同務實審查 prompt 送交 Gemini 並解析回傳之結構化 JSON，並非原生 Gemini 審查器。
- **沙箱**：Codex 提供 `read-only`／`workspace-write` 沙箱。Gemini 無對應沙箱；寫入權由 `--write`（`--yolo`）把關，否則以 prompt 強制唯讀紀律。（不採 `--approval-mode plan`：其需 TTY，與 stdin 提示傳遞衝突。）
- **Thread／session 接續**：Codex 於 app-server 持久化 thread。本外掛之接續依賴自 JSON 信封擷取之 Gemini CLI **session id**；`/gemini:result` 會印出 `gemini --resume <session-id>`，而 `--resume-last` 接續*當前 Claude session* 之最新 thread。

---

## 技能

本外掛捆綁三個供 Claude Code 使用的技能：

| 技能 | 用途 |
|---|---|
| `gemini-cli-runtime` | 執行時合約 — 如何呼叫 `gemini-companion task` |
| `gemini-result-handling` | 結果呈現規則（嚴重程度、推理、證據邊界） |
| `gemini-prompting` | 提示組合指南（XML 標籤、輸出合約） |

---

## 已知限制

以下為已記錄之非阻塞限制——詳見所連結之章節：

- **模型與存取可用性會漂移。** Google 已宣布 2026-06-18 consumer Gemini CLI transition；Gemini CLI 提供的 model IDs 也會隨版本變動。對不可用的 Gemini model ID，本外掛保留 GA fallback。詳見 [模型別名說明](#模型別名說明) 與 [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md)。
- **`/gemini:review` 為 prompt／CLI adapter，非原生審查器。** 其將 diff 連同審查 prompt 送出並解析結構化 JSON，而非透過 app-server 審查器，故反饋深度有別於原生。詳見 [Codex app server 與 Gemini CLI adapter](#codex-app-server-與-gemini-cli-adapter)。

---

## 更新日誌

詳見 [CHANGELOG.md](plugins/gemini/CHANGELOG.md)。

---

## 授權與上游歸屬

MIT © 2026 arcobaleno64。

本專案為 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)（Copyright 2026 OpenAI，Apache License 2.0）之衍生作品。沿用部分仍受 Apache-2.0 規範（見 [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0) 與 [`NOTICE`](NOTICE)）；Gemini/AGY 專屬之變更採 MIT（見 [`LICENSE`](LICENSE)）。

**衍生自上游**（沿用，Apache-2.0）：斜線命令結構、背景工作模型（enqueue／worker／status／result／cancel）、`.omc/state` 持久化與 job-control 模式、停止時 review-gate 模式、skill 合約佈局，以及 version／manifest 工具（`bump-version`）。

**本倉儲原創**（MIT）：Gemini/AGY 引擎偵測與路由、stdin 提示傳遞、`model-map` 別名／努力來源、AGY 引擎處理、OAuth 狀態檢查，以及 contract 驗證腳本。
