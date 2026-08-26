# Roadmap — playbook 逐項分類

繁體中文。這份文件的對象是維護者，不是使用者。

[`HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md`](HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md)（v3.8.1）列了大約三十個待辦。它寫得很細，但它是**計畫**，而 `docs/README.md` 開宗明義說過：把計畫當成現況讀，是這個目錄最容易犯的錯。

這份文件做三件事：**查證前提**、**分類**、**擋住不該做的**。

> **查證基準**：commit `41b719b`，2026-08-26，plugin v0.23.0。
> playbook 自己的 baseline 是 `22b93a7` / v0.22.2 / 2026-08-21，已漂移三個 release。
> 本文件同樣會過期。**動工當天重新查證那一項的前提，不要採信這裡的欄位。**
> 每一列都註明查證方式，就是為了讓重驗只花幾秒。

分類共五類，優先級由上而下遞減：

| | 類別 | 意義 |
|---|---|---|
| **A** | 已經做掉 | playbook 仍列為待辦，實際已存在 |
| **B** | 前提成立、該做 | 已對 HEAD 查證，有真實使用者情境 |
| **C** | 前置條件不存在 | 前置物做出來之前，做了也沒有消費者 |
| **D** | 內容有錯或矛盾 | 照抄會出事，需先修正 |
| **E** | 不做 | Non-goal，或順序根本反了 |

---

## A — 已經做掉，playbook 還列為待辦

| 項目 | playbook 說 | 實際 | 查證 |
|---|---|---|---|
| §4.9 AEO benchmark | 「⚠️ 待補齊」 | **已實作**：`scripts/aeo-benchmark.mjs` + `tests/aeo-benchmark.test.mjs` | `ls scripts/` |
| §5.3 認證指引視覺化 | 「包在長篇段落中，掃描型開發者容易忽略」 | **對送審面已不成立**：`plugins/gemini/README.md` 的 Install 區是一張三行需求表。根 `README.md` 的認證段落確實仍長，但那不是審查員第一眼看的檔案 | `plugins/gemini/README.md` §Install |
| §7.3 `SECURITY.md` | `[CURRENT]` | 正確，仍存在 | `SECURITY.md` |
| §1「MCP 啟動穩定性」 | v3.8.1 已從「合規」降為「部分合規」 | 這個降級是對的。無啟動探測 ≠ 通過 MCP 合規驗證 | — |

**§4.9 有一個缺陷要記下來。** `scripts/aeo-benchmark.mjs:76-82` 的 `Q5_ENTERPRISE_SARIF` 期待 AI 回答裡出現 `sarif export`、`rendersarif` 這些關鍵字——**而這個功能不存在**（§7.2 仍是 `[PLANNED]`，全 repo 無 SARIF 實作）。這條 query 若哪天「通過」，通過的原因是模型幻覺出一個功能，不是這個 repo 做對了什麼。

這正是 benchmark 最典型的失效方式：**它量的是關鍵字出現率，代理的是「這個工具被正確描述」，而兩者可以反向脫鉤。** 要嘛先實作 SARIF，要嘛把 Q5 降級成 `[PLANNED]` 專用、不計入 pass rate。現在兩者都沒做。

---

## B — 前提經查證成立，該做，但都在上架之後

按建議順序排列。**每一項的前提都對 HEAD 查過，成立。**

### B1. §6.2 `SAFE_MODEL_ID` 放寬 — 唯一有真實使用者情境的

- **前提查證**：`plugins/gemini/scripts/lib/engine.mjs:36` 目前是 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`，單一 segment，**確實擋掉 `/` 與 `@`**。
- **真實情境**：Vertex AI 模型路徑（`publishers/google/models/…`）與版本標籤（`…@001`）現在會被拒絕。這是使用者現在就會撞到的，不是假想的。
- **playbook 的 `[CAUTION]` 是對的，照它做**：舊提案的 `(?:[A-Za-z0-9_.-]+\/)*` 開頭會接受 `--yolo/foo`、`-x/foo`、`../foo`，破壞「首字元不得為 `-`」這個原始安全不變量。修正版要求**每個 path segment 首字元均為 alphanumeric**。
- **動工前必做**（playbook 自己列的，別跳過）：確認下游 CLI 真的接受 `/`；確認 Gemini CLI 與 AGY 的 model-id namespace 同規則；確認 `/` `@` 不會改變 CLI 的 argument parsing 語意。**單純放寬 character allowlist 不等於安全**——若下游只吃固定幾種前綴，known-prefix allowlist 比 regex 正確。

### B2. §7.1 `action.yml`

- **前提查證**：不存在。
- 它是 B3 與 C1 的前置物。playbook §7.1 已列出已知缺陷（action path、output-format wiring、verdict/exit 語意、engine/quota/timeout、SARIF upload permissions），**那些要先解掉再發布 action**，不要先發布再補。

### B3. §7.2 SARIF 2.1.0 輸出

- **前提查證**：全 repo 無 SARIF 實作。
- 純序列化／匯出層，風險低。**但要守住 playbook 自己的界線**：SARIF 只是輸出格式，不得反過來讓 SARIF schema 決定 core finding model；plugin 的 finding 不是 release authority。
- 做完這項，A 類記的那個 Q5 缺陷才會自然消失。

### B4. §6.4 `doctor`

- **前提查證**：`plugins/gemini/commands/` 下無 `doctor`，只有 `setup`。
- 價值不高（`setup` 已涵蓋大部分），但成本也低。**照 playbook 的守則做**：擴充既有的 `buildSetupReport` / `handleSetup`，不要新建平行模組。

---

## C — 前置條件不存在，現在做等於為空氣蓋橋

### C1. §6.1 `GEMINI_GATE_STRICT`（CI fail-closed）

- **前提查證**：`plugins/gemini/scripts/stop-review-gate-hook.mjs:110-118` 確實 fail-open，且已附可見警告（`systemMessage` + stderr）。playbook 對現狀的描述正確。
- **但它存在的唯一目的是服務 §7.1 的 `action.yml`，而 `action.yml` 不存在。**
- 這違反 playbook **自己的** Complexity Guardrail 第 1 條：「現在是否已有兩個真實 use case？」——目前零個。
- **解除條件**：B2 完成，且 CI 端出現真實的 fail-closed 需求。在那之前，一個沒有消費者的環境變數只是多一條要維護的分支。

### C2. §4 全部（robots.txt / llms.txt / JSON-LD / Preferred Sources / Glama / Smithery）

- **前提查證**：`smithery.yaml`、`robots.txt`、`llms.txt`、`llms-full.txt` 皆不存在；**GitHub Pages 未啟用**（`gh api repos/…/pages` 回 404）。
- `robots.txt` 與 JSON-LD 需要一個 host 得起來的網站。**沒有網站的 robots.txt 不會被任何爬蟲讀到。**
- **解除條件**：先有 Pages 站台，再談上面那些檔案。

### C3. §9.1 MIT → Apache-2.0

- **解除條件**：playbook §9.5 自己列的 Relicensing Provenance Gate。
- **額外複雜度，playbook 沒寫**：本 repo 已是 Apache-2.0 上游（`openai/codex-plugin-cc`）的衍生作品，且目前是 MIT + Apache-2.0 雙授權（見 `NOTICE`、`LICENSE-APACHE-2.0`）。換授權要同時處理外部貢獻者 provenance **和**既有雙授權結構，不是單純換一個 `LICENSE` 檔。

---

## D — 內容有錯或自我矛盾，照抄會出事

### D1. §3.2 OpenAI Codex for OSS 申請範本與 §2 牴觸

playbook §3.2 建議的 Project Description 是：

> An open-source multi-agent code review & adversarial consensus framework

**同一份文件的 §2 明確否定這個定位**：「不擁有上層 multi-agent orchestration」「不在本插件內實作通用 multi-agent workflow engine」「不以模型投票或 max severity 自動建立 finding authority」。

照這個範本送出，等於提交一份與自己架構文件矛盾的描述。**要送就照 §2 的定位寫**：一個 Gemini / AGY capability provider。

**另外**：§3.2 自己註明評審看 broad adoption。查證當日 **10 stars / 4 forks**，repo 三個月大。**上架取得實際採用數據之後再申請**，否則最強的那一格是空的。

### D2. §1 評估矩陣至少兩格已隨 v0.23.0 過期

v0.23.0 改動了 `gemini_review` / `gemini_adversarial_review` 的 `readOnlyHint`，以及 `--resume` + `--write` 的語意（見 CHANGELOG 0.23.0）。矩陣未反映。**這不是 playbook 的錯**（它標了 baseline），但它示範了為什麼矩陣欄位不能直接採信。

### D3. §6.3 security-weighted budgeting 是古德哈特陷阱

- **前提查證屬實**：`plugins/gemini/scripts/lib/git.mjs:224` 的 `allocateBudget` 是最小優先的 fair-share，無安全加權。
- **但這一項不該照做。** 把 Tier 1/2/3 權重塞進預算分配，直接抬高的是「安全相關檔案有被送進 review」這個**數字**，而它代理的是「安全問題有被發現」。兩者可以在不改善任何東西的情況下脫鉤：權重讓一個檔案進了 payload，不表示模型在那個檔案上找到了東西。
- **正確順序**：`bench/` 已經是量發現率的工具。**先用它量出「flat 配額漏掉了安全檔案裡的真實缺陷」，再改配額邏輯。** 沒有那個量測，這項改動無法被證明有效，也無法被證明無效。
- playbook 的 start prompt 自己寫了「security-weighted review budget **if evidence supports it**」。目前沒有 evidence。
- **守住這個**：`allocateBudget(sizes, budget)` 是匯出的純函式、以數字陣列為輸入，`tests/git.test.mjs` 依賴其簽名。**嚴禁改參數簽名**（已查證此守則屬實）。

---

## E — 不做

來自 playbook §2 的 Non-Goals 與其 start prompt 的 Scope Boundary。**這一節存在的目的就是防止失焦**：以下每一項在某次對話裡聽起來都會很合理。

1. **通用 multi-agent workflow / orchestration engine** — 本 plugin 是 capability provider，不是 orchestrator。
2. **consensus / voting engine、Claude adjudicator、Triad release policy、generic multi-agent DAG** — 不在本 repo 實作。
3. **以模型投票或 `max severity` 自動建立 finding authority** — plugin 的 finding 不是 release verdict。
4. **宣稱 Gemini / AGY 是 filesystem sandbox** — 它不是，而且 `docs/THREAT-MODEL.md` §7.2 有實測說明它不是。
5. **為提高 review recall 而擴大 payload surface** — 隱私邊界優先於召回率。

另外兩條是順序問題，不是 non-goal，但同樣會失焦：

- **上架前做 SEO / AEO** — directory 上架本身就是散佈通路。**在還沒被列上去之前優化漏斗，是在優化一個沒有入口的漏斗。**
- **上架前打 1.0.0** — 見 `README.md` 的 Versioning 一節，1.0.0 的條件已寫成可檢驗的形式。

---

## 怎麼用這份文件

1. **要動 playbook 的某一節之前，先在這裡找到它。** 若它落在 C、D、E，先讀完那一段再決定。
2. **B 類動工前，重跑該項的「前提查證」那一欄。** 每一列都寫了怎麼查，通常一個 `grep` 或 `ls`。
3. **查證結果與這裡不符時，改這份文件，不要改 playbook。** playbook 是 dated 的計畫；這份是 current 的分類。
4. **完成一項就把它移到 A 類**，並註明實作它的 commit。

相關：[`evidence.md`](evidence.md)（本 repo 的查證規則）、[`THREAT-MODEL.md`](THREAT-MODEL.md)（§7.2 是任何「read-only」宣稱的前置閱讀）。
