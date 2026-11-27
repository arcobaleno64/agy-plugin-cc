# 與 codex-plugin-cc 的對應

English: [`parity.md`](parity.md)

本外掛為 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的高保真移植版。公開的斜線命令介面、背景工作模型，以及 state/result/status/cancel 流程皆鏡像上游；執行後端則為第一級支援的 Gemini CLI 與 AGY 引擎，而非 Codex app server。

本檔描述的是**當前**狀態。有日期的稽核快照另存於旁——保留它們是因為它們回答「行為是何時改變的」：[`PARITY_AUDIT.md`](PARITY_AUDIT.md)（v0.6.0 基準，含 v0.6.1 修復彙整表）與 [`PARITY_AUDIT_v0.11.1.md`](PARITY_AUDIT_v0.11.1.md)（2026-08-04，對照上游 v1.0.6）。

## 相容性對照表

| 上游（Codex） | 本外掛（Gemini） | 對應程度 |
|---|---|---|
| `/codex:setup` | `/gemini:setup` | **Gemini 專屬差異** — 依所選第一級引擎檢查 Gemini OAuth 或 AGY binary readiness，而非 Codex 認證 |
| `/codex:review` | `/gemini:review` | **最佳等效** — prompt／CLI adapter 審查，非原生審查器 |
| `/codex:adversarial-review` | `/gemini:adversarial-review` | **最佳等效** — 對同一 diff target 施以對抗性 prompt |
| `/codex:rescue` | `/gemini:rescue` | **刻意差異** — 相同的委派介面，但本外掛預設為唯讀意圖；上游預設為受 sandbox 限制的可寫入執行 |
| `/codex:transfer` | `/gemini:transfer` | **1:1 對等** — 匯出會話快照並產生 AGY / Gemini CLI 移交接手啟動命令 |
| `/codex:status` | `/gemini:status` | **1:1 對等** — 相同工作模型；`--all` 跨 Claude session |
| `/codex:result` | `/gemini:result` | **引擎專屬差異** — 顯示 Gemini session id 與 `gemini --resume`，或 AGY conversation id 與 `agy --conversation` |
| `/codex:cancel` | `/gemini:cancel` | **1:1 對等** — 相同的 process-tree 終止（POSIX 與 Windows） |

上游沒有與本外掛 MCP server 對應的東西；該介面提供什麼、又刻意不提供什麼，見 [MCP 工具](../README.zh-TW.md#mcp-工具)。

## Codex app server 與 Gemini CLI adapter

- **執行時**：Codex 使用常駐 app-server，具原生審查與持久 thread。本外掛則於*每次命令*直接呼叫所選的第一級 Gemini CLI 或 AGY 引擎（無共享執行時）；`auto` 採 Gemini→AGY 的 capability-based 順序。
- **標準審查**：Codex 外掛之 `/codex:review` 為*原生*審查器；本外掛之 `/gemini:review` 為 **prompt／CLI adapter 等效實作**——將 diff 連同務實審查 prompt 送交 Gemini 並解析回傳之結構化 JSON，並非原生 Gemini 審查器。
- **沙箱**：Codex 提供 `read-only`／`workspace-write` 沙箱，並將可寫入的執行限制在工作區內。**Gemini CLI 與 AGY 皆未提供本外掛可施加的對應路徑邊界**，故本外掛亦無。AGY 的 `--sandbox` 不是——1.1.10 實測，啟用它的執行仍透過編輯工具與 shell 指令寫到工作區外（1.5.16 亦同，且放任讀取 `.env` 與工作區外檔案）；它限制的是終端機指令能碰到什麼（網路、`.git`），不是誰能寫到哪。不過從本外掛這端，**當 `agy --help` 宣告支援 `--settings` 時（1.5.16 實測），`--write` 未啟用會在工具層疊加一層軟性的單次 `--settings` `permissions.deny` 護欄**，拒絕編輯、shell、MCP、URL 與受掃描上限（最多 5,000 筆、深度 6）約束的工作區機密讀取（見 [`THREAT-MODEL.md`](THREAT-MODEL.md) §7.2），而這不改變 AGY 自身無工作區寫入沙箱的事實。Gemini CLI 同名旗標則是**容器**沙箱，未安裝 Docker 或 Podman 即拒絕啟動，故未實測，亦不強制使用者安裝。`--write` 在兩引擎的意義不同，且只有在 gemini 上它才是一道能力閘門：那裡它加的是 `--yolo`，不加時模型根本不會被提供寫入與 shell 工具。**在 AGY 上 `--write` 也不是原生沙箱邊界，但決定執行時的單次設定模式（`read-only` vs `write` 僅對檔案工具限制 `.git/` 與掃描機密而保留 `command`）。** 每次執行定位方式：非 `--deep` 唯讀 diff 審查不分新舊版一律在空暫存 `cwd` 隔離執行（支援 `--settings` 時並套用 `review-diff` 規則封鎖 `read_file(*)` 等工具）；`--deep` 審查與一般工作（`task`/`rescue`）則在啟動前於 `cwd` 至 Git 根目錄之間（最多 64 層，若權限或 Git 根目錄無法查證亦 fail-closed）檢查 `.agents`/`.agent`/`_agents`/`_agent` 的 `hooks.json`/`mcp_config.json`/`plugins.json`/`plugins` 並在發現時拒跑（原生 CLI 支援嚴格布林 `--allow-repo-hooks` 放行，MCP 工具刻意不提供），通過後 `--deep` 審查與唯讀新工作以 `--add-dir`、全新 `--write` 工作以 `--new-project` 定位到版本庫，續接對話則以 `--conversation <id>` 沿用原對話工作區（`--write` 續接須經過工作區綁定驗證，且結束後會核對 `init.cwd`）。詳見 [`THREAT-MODEL.md`](THREAT-MODEL.md) §7.2。兩個引擎的 plan 模式皆不採用：gemini 的 `--approval-mode plan` 會把寫入工具重新宣告給模型並注入規劃流程提示，比什麼都不加更弱；AGY 的 `--mode plan` 則只擋編輯工具，shell 指令照樣寫得進同一個檔案（1.1.13 實測），且只要傳了 `--disable-slash-commands` 就會被整個停用（1.5.16 實測確認兩者依然無效）。
- **Thread／session 接續**：Codex 於 app-server 持久化 thread。本外掛從所選引擎的輸出或舊版 transcript 擷取 thread id；`/gemini:result` 會印出該引擎專用的接續命令，而 `--resume-last` 接續*當前 Claude session* 之最新 thread。在 AGY 上 conversation id 以 `--conversation` 釘住；在 gemini 上釘不住，因為 `--resume` 只接受 `latest` 或索引，故改為比對實際落點與追蹤中的 session id，不一致就回報。
