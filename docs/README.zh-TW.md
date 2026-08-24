# 文件索引

English: [`README.md`](README.md)

這裡放兩種檔案，**分清楚它們比檔案多長更重要**。**參考文件**描述外掛當前的行為，行為變了就跟著更正。**有日期的記錄**描述的是某一天、對特定版本量到的結果，永遠不重寫——它的價值正是回答「某件事是何時改變的」。把有日期的記錄當成現況來讀，正是這一頁存在要防止的錯誤。

請從 [README](../README.zh-TW.md) 開始。這裡沒有任何一份是使用本外掛的必讀。

## 參考文件——持續更新

| 檔案 | 回答什麼 |
|---|---|
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | 不可信的版本庫能讓被委派的 agent 做到什麼，對照 OWASP LLM Top 10。相信任何「唯讀」宣稱之前，先讀 §7.2。 |
| [`parity.zh-TW.md`](parity.zh-TW.md) · [`parity.md`](parity.md) | 本外掛與 `codex-plugin-cc` 的逐命令對應，以及兩者執行時的差異。 |
| [`known-diffs.md`](known-diffs.md) | 與上游的刻意差異，以及每一項保留的理由。 |
| [`COMPARISON.md`](COMPARISON.md) | 相對於 AGY-only 與多宿主外掛的定位——本外掛主張什麼、不主張什麼。 |
| [`MODEL_COMPARISON.md`](MODEL_COMPARISON.md) | 各引擎審查深度為何不同，其中多少是 harness 而非模型造成的。內含有日期的探測記錄，已被取代者皆已標註。 |
| [`adapter-contract.md`](adapter-contract.md) | 引擎 adapter 必須滿足的介面。 |
| [`version-sources.md`](version-sources.md) | 每個版本字串以哪個檔案為準，以及靠什麼維持一致。 |
| [`verifying-without-credentials.md`](verifying-without-credentials.md) | 沒有 Gemini 或 AGY 帳號時，如何演練引擎路徑。 |
| [`evidence.md`](evidence.md) | 本 repo 的調查規則：沒看過它紅過的東西，不算證據。附已經付過學費的陷阱清單。 |
| [`HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md`](HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md) | 企業級交接手冊：增長推廣、MCP 上架、AI 時代 SEO/AEO/GEO 架構規格、自動化驗證與 v1.0.0 路線圖。 |

## 有日期的記錄——永不重寫

| 檔案 | 對照對象 | 被誰取代 |
|---|---|---|
| [`PARITY_AUDIT.md`](PARITY_AUDIT.md) | 外掛 v0.6.0 對上游 v1.0.4，2026-06-02 | `PARITY_AUDIT_v0.11.1.md` |
| [`PARITY_AUDIT_v0.6.1.md`](PARITY_AUDIT_v0.6.1.md) | 外掛 v0.6.1 重評 | `PARITY_AUDIT_v0.11.1.md` |
| [`PARITY_AUDIT_v0.11.1.md`](PARITY_AUDIT_v0.11.1.md) | 外掛 v0.11.1 對上游 v1.0.6，2026-08-04 | 當前狀態見 [`parity.zh-TW.md`](parity.zh-TW.md) |
| [`AGY_1.1.2_MACOS_LINUX_VALIDATION.md`](AGY_1.1.2_MACOS_LINUX_VALIDATION.md) | 外掛 v0.7.1 對 AGY **1.1.2**，macOS/Linux | 無人重跑；見該檔開頭的說明 |

比上述最新一份更晚量到的行為，記在 [CHANGELOG](../plugins/gemini/CHANGELOG.md) 與 `THREAT-MODEL.md` §7.2，兩者各自帶有量測日期。
