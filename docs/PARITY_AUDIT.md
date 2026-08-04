# gemini-plugin-cc × codex-plugin-cc 鏡像度與可用性稽核報告

> 對象：`arcobaleno64/gemini-plugin-cc` v0.6.0（下稱 **port**）
> 基準：`openai/codex-plugin-cc` v1.0.4（下稱 **upstream**）
> 日期：2026-06-02 ｜ 方法：靜態原始碼回讀 + 既有測試 + 實跑採樣（Gemini/AGY 引擎，Windows）
> 原則：不採信 README 自述；每項評分皆回溯 file:line、測試或實跑輸出。

---

## 〇、修復狀態（Remediation status — v0.6.1）

> 下方第一～七節為 **v0.6.0 時點之評估快照**，原樣保留以資對照。
> 此處彙整本報告所列修正清單於 **v0.6.1** 之落實狀態。**分數未在此重評**——完整重新評分留待下一次詳細對比（屆時應反映以下修復後的提升）。

| 原修正項 | 狀態 | 落實摘要 |
|---|---|---|
| **v0.10.0** `/gemini:transfer` 與 AGY 1.1.10 對齊 | ✅ 已補（v0.10.1 補正註冊） | 實作 `/gemini:transfer` Session handoff 命令，對齊 upstream v1.0.5 功能；補強機密檔案過濾、Git conflict 鎖定、Per-file 截斷、LRU 快照清理與 Posix/PowerShell 引號安全轉義。**更正**：v0.10.0 之命令檔誤以 `commands/transfer.json` 形式交付，Claude Code 命令載入器僅辨識 `.md`，故該版之 `/gemini:transfer` 從未實際註冊，僅腳本存在；v0.10.1 改為 `commands/transfer.md` 並以「`commands/` 不得含非 `.md` 檔」之測試守則鎖定。 |
| **P0** rescue `available`↔`found` | ✅ 已修 | companion 改回 `available`（棄 `found`），rescue 續接提示得以觸發;守則測試鎖定欄位名。 |
| **P1** 背景 review 無持久化 | ✅ 已修 | 新增 `review-worker`（仿 task-worker），背景 review 結果可持久化並經 `/status`/`/result` 取回。 |
| **P1** 死碼 `renderNativeReviewResult` | ✅ 已修 | 移除。 |
| **P1** stop-gate 靜默 fail-open | ✅ 已修 | 失敗時 `systemMessage`+stderr 可見化（保 fail-open）;顯式 `--scope working-tree`。 |
| **P1** AGY macOS path 未驗 | ✅ 已記 | README EN+zh-TW 標明僅驗於 Windows/Linux、macOS 未驗（不虛構路徑）。 |
| **P2** 進度列標籤錯置 | ✅ 已修 | `runGeminiReview` 模式感知（`isAdversarial`）。 |
| **P2** stderr 雜訊滲入輸出 | ✅ 已修 | `extractReasoningSummary` 取末五行前濾除 DEP0190/256-color/ripgrep。 |
| **P2** preview 模型漂移 | ✅ 已修 | `/gemini:setup` 顯示別名數/preview 數/lastVerified。 |
| **P2** DEP0190 說明 | ✅ 已記 | README 註明屬無害（提示走 stdin，不入 argv）。 |
| **P3** `gemini-prompting/references/` 缺 | ✅ 已補 | 補 blocks/recipes/antipatterns 三檔＋SKILL 連結。 |
| 附帶（對抗式驗證揪出） | ✅ 已修 | README 既有舊誤「AGY 互動選模」更正為「鎖定 Gemini 3.5 Flash High、忽略 model/effort」。 |

**把關**：測試 154→159（含背景 review-worker、available 守則、setup 漂移、stop-gate hook）全綠;check-version／verify-contracts 過;實跑＋雲端 CI＋5 路對抗式驗證。詳見 [CHANGELOG](../plugins/gemini/CHANGELOG.md) v0.6.1。

---

## 一、總評

| 維度 | 分數（/5） | 說明 |
|---|---|---|
| **鏡像度 fidelity** | **3.9** | 指令面、job 模型、schema、skill/hook 佈局高度吻合；少數契約於移植時引入破綻，且 review 機制由 native 改為 prompt-based（已誠實註記）。 |
| **可用性 usability**（②–⑥平均） | **4.0** | 核心 review/rescue 路徑實測運作且回饋品質優；扣分集中於 AGY 邊界、背景 review 無持久化、stderr 雜訊與少數靜默失敗。 |

**一句話結論**：這是一個**高保真、實際可用**的移植。README 的 Compatibility Matrix 大體屬實，但有一個 **P0 契約破綻（`available`↔`found`）** 與數個 P1 可用性缺口應修。回饋品質（使用者實際看到的 review 輸出）在 gemini 與 AGY 兩引擎上**皆實測為優**。

---

## 二、評分軸（rubric）

各項功能依六軸各評 1–5（越高越好）：

1. **① 鏡像度**：指令/flag/契約/輸出 schema 與 upstream 對應項的吻合度。
2. **② 功能可靠性**：端到端能否真正運作、不 hang、不靜默失敗。
3. **③ 回饋品質**：使用者實際看到的輸出是否清晰、結構化、有用。
4. **④ 失敗透明度**：錯誤處理是否 fail-loud、訊息可操作、不誤導。
5. **⑤ 設定/發現摩擦**：上手成本、auth、文件正確性。
6. **⑥ 跨平台/穩定性**：Windows/macOS/Linux、preview 模型漂移、AGY 限制。

頂層「可用性」＝ ②–⑥ 平均。

---

## 三、逐項評分矩陣

| # | 功能 | ① | ② | ③ | ④ | ⑤ | ⑥ | 可用性 | 關鍵審核註解 |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| 1 | `/setup` | 4 | 4 | 4 | 5 | 4 | 4 | 4.2 | 刻意分歧：查 `oauth_creds.json`＋`readyState`(ready/partial/not-ready)＋AGY fallback＋2026-06-18 personal EOL 警告。誠實標示 AGY auth 不可驗。 |
| 2 | `/rescue` | 3 | 3 | 4 | 3 | 4 | 4 | 3.6 | **P0**：`rescue.md:29,37` 判 `available`，但 `gemini-companion.mjs:789-790` 回 `found` → resume 續接提示恐永不觸發（upstream 兩端皆用 `available`）。 |
| 3 | `/review` | 3 | 5 | 5 | 3 | 4 | 4 | 4.2 | 機制分歧：upstream 為 **native** reviewer，port 為 **prompt-based**（已註記）。**實跑：5/5 植入瑕疵全中**，severity+file:line+next steps 齊備。進度列誤印「adversarial」。 |
| 4 | `/adversarial-review` | 4 | 5 | 5 | 3 | 4 | 4 | 4.2 | 最接近 1:1（upstream 亦 prompt+schema）。**實跑：扣準 focus**（auth-bypass/data-loss）。同樣 stderr 雜訊。 |
| 5 | `/status` | 5 | 5 | 4 | 4 | 4 | 4 | 4.2 | 1:1：job 表、`--all` 跨 session、`--wait`/`--timeout-ms`。測試覆蓋完整。 |
| 6 | `/result` | 4 | 5 | 4 | 4 | 4 | 4 | 4.2 | 刻意分歧（增益）：輸出 engine-aware resume 提示（`gemini --resume` / `agy --conversation`）。 |
| 7 | `/cancel` | 4 | 4 | 4 | 4 | 4 | 4 | 4.0 | 程序樹終止 1:1，但**只能殺 OS 程序**，無 upstream 的 `turn/interrupt` 中斷模型回合（無 app-server）。 |
| 8 | `gemini-rescue` 子代理 | 4 | 4 | 4 | 3 | 4 | 4 | 3.8 | Bash-only forwarder 契約對齊。失敗時「回傳空」可能對使用者不透明。 |
| 9 | skills（3 個） | 3 | 4 | 4 | 4 | 3 | 5 | 4.0 | cli-runtime/result-handling 對齊；**`gemini-prompting` 缺 `references/` 子目錄**（upstream `gpt-5-4-prompting` 有 3 份 reference）。 |
| 10 | hooks（lifecycle/gate） | 4 | 4 | 4 | 3 | 4 | 4 | 3.8 | 對齊，但 stop-gate **fail-open**（review 失敗即放行；upstream timeout/異常 fail-closed），且 gate 不指定 diff target 恐空審。 |
| 11 | engine routing（stdin/AGY transcript） | — | 4 | 4 | 4 | 3 | 3 | 3.5 | **原創**（無 upstream 對應）。gemini stdin 投遞穩固（測試含 metacharacter 矩陣）。**實跑驗證：AGY transcript-recovery 於 Windows 可運作**；惟 macOS path 為 TODO、並發無鎖。 |
| 12 | background job model | 4 | 3 | 4 | 3 | 4 | 4 | 3.6 | 檔案式 state＋detached worker，lifecycle 對齊。**缺口：背景 review 無 worker**，僅靠 Claude 層 `run_in_background`，中斷即失結果（背景 task 則有持久化）。 |
| 13 | model/effort（model-map） | 4 | 4 | 4 | 4 | 4 | 3 | 3.8 | 單一真理來源＋測試對 README。9 別名中 **5 個指向 `*-preview`**（`lastVerified 2026-05`）有漂移風險；AGY 靜默忽略 `--model/--effort`。 |
| 14 | manifests & tooling | 5 | 5 | 5 | 5 | 5 | 5 | 5.0 | 四檔版本同步、`bump-version`、`verify-contracts`、CI、**154 測試全綠**、license attribution 完備。 |

> ⑪ 為原創功能，鏡像度不適用（以「—」表示），不計入鏡像度平均。

---

## 四、與 README 自評 Compatibility Matrix 的對照

README 宣稱（節錄）對照本次實測：

| README 宣稱 | 實測判定 |
|---|---|
| `/rescue` 「1:1 parity」 | **不全然**：forwarder 契約 1:1，但 resume-candidate 欄位 `available`↔`found` 破綻使續接提示失效（P0）。 |
| `/review` 「best-effort equivalent（prompt-based, 非 native）」 | **屬實且誠實**：實跑證實 prompt-based，回饋品質優。 |
| `/adversarial-review` 「best-effort equivalent」 | **屬實**：focus-aware，最接近 1:1。 |
| `/status`、`/cancel` 「1:1 parity」 | **大體屬實**：status 1:1；cancel 少了 `turn/interrupt` 語義（無 app-server，先天差異）。 |
| `/result` 「Gemini-specific divergence（resume id）」 | **屬實**：增益分歧。 |
| `/setup` 「Gemini-specific divergence」 | **屬實**：readyState/AGY/EOL 警告皆到位。 |
| 「stdin 投遞消除注入風險」 | **屬實**：測試含 metacharacter 矩陣；惟 Windows `shell:true` 仍觸發 DEP0190 警告（prompt 走 stdin 不受影響）。 |

**結論**：自評誠實度高，唯一與宣稱明顯不符者為 `/rescue` 的「1:1」。

---

## 五、實跑證據附錄

**環境**：Windows 11，`node/npm/gemini/agy` 具備，gemini OAuth 有效。樣本 `auth.js` 植入 5 瑕疵（SQL 注入、硬編 JWT 密鑰、缺 null 檢查、明文 `==` 密碼比對、未捕捉 `JSON.parse`）。

| 實跑 | 結果 |
|---|---|
| `gemini review`（gemini 引擎） | ✅ 命中 5/5；verdict=needs-attention；severity+file:line+recommendation+next steps 完整。 |
| `gemini adversarial-review "Focus on auth bypass & data-loss"` | ✅ 扣準 focus；3 條 critical/high 串回 auth-bypass/data-loss。 |
| `gemini review --engine agy` | ✅ **transcript-recovery 於 Windows 實際取回完整結構化 review（5 findings）**；「Reasoning」段顯示 agy thinking。 |
| `node --test`（port） | ✅ **tests 154 / pass 154 / fail 0**（182 s）。 |
| `codex review`（對照，登入後重跑） | ✅ native reviewer 運作：agentic 探查檔系，抓到 SQLi(P1)、硬編密鑰(P1)、**未宣告 `jsonwebtoken` 依賴(P2)**、**未追蹤 `.omc/state` 不應提交(P2)**。 |
| `node --test`（upstream） | ⚠️ 1 測試於 Windows 因 `taskkill /T /F` exit=128 競態而 fail（環境 flake，非 codex 缺陷）。 |

### native（codex）vs prompt-based（gemini）回饋對照

對同一樣本，兩者揭露的問題集**不同且互補**：

| 面向 | codex（native, agentic） | gemini（prompt-based, diff-scoped） |
|---|---|---|
| repo 脈絡問題 | ✅ 抓到缺依賴宣告、未追蹤 state 外洩 | ❌ 僅見 diff，漏 repo 脈絡 |
| in-diff 程式瑕疵 | 此次僅列 SQLi＋密鑰（聚焦 blocking） | ✅ 另抓 null 檢查、明文 `==` 密碼、`JSON.parse` |
| severity 詞彙 | `P1/P2/P3` | `critical/high/medium/low`（同 upstream **adversarial** schema，但**異於** codex **native** 的 P-label） |
| 取證方式 | 實跑 git/檔系指令探查 | 單次 prompt＋預組 diff 脈絡 |

**啟示**：port 的 review「回饋品質」於 diff 範圍內優異，但因無 native reviewer 的 agentic 探查，**先天看不到 diff 以外的 repo 脈絡問題**（缺依賴、未追蹤檔等）。此為 native→prompt 分歧的可觀察後果，亦使 `/review` 的鏡像度封頂於 ①=3。severity 詞彙與 codex native 不一致（與 adversarial schema 一致）亦為一處可議的鏡像落差。

**實跑中發現的次要瑕疵**：
- 標準 `review`（含 agy）進度列誤印 `[gemini] Starting adversarial review...`（標籤錯置）。
- stderr 雜訊（DEP0190、256-color、ripgrep fallback、agy thinking）滲入輸出尾「Reasoning:」段——影響④失敗透明度/觀感，不影響結構化內容解析。

---

## 六、修正清單（依優先級）

### P0 — 契約破綻（應立即修）
1. **rescue `available`↔`found` 欄位對齊**
   - 證據：`plugins/gemini/commands/rescue.md:29,37`（判 `available`）vs `plugins/gemini/scripts/gemini-companion.mjs:789-790`（回 `found`）。
   - 修法：擇一統一。建議改 companion 輸出為 `available`（與 upstream 一致，line 898 codex 即用 `available: Boolean(candidate)`），並保留 `found` 為相容別名；或改 rescue.md 改判 `found`。前者鏡像度較佳。
   - 受影響軸：①③④。並補一條測試斷言該欄位名，納入 `verify-contracts` 防回歸。

### P1 — 可用性缺口
2. **背景 review 無持久化**：背景 review 僅靠 Claude 層 `run_in_background`，無 `review-worker`，中斷即失結果。
   - 修法：比照 `task-worker` 增 `review-worker`，或在 review.md 明示「背景 review 不可恢復，重要審查請用前景」。受影響軸②④。
3. **死碼 `renderNativeReviewResult`**：`plugins/gemini/scripts/lib/render.mjs:303` 定義但全庫無呼叫點（含測試）。移除以免誤導維護者。受影響軸①。
4. **AGY macOS brain path 未驗**：`agy-transcript.mjs` 標 TODO；macOS 上 `detectEngine` 會於 spawn 前 throw。
   - 修法：補 macOS 候選路徑或在 setup/README 明示 AGY 僅驗於 Windows/Linux。受影響軸⑥。
5. **stop-gate fail-open 與空審**：review 失敗即放行、且不指定 diff target。
   - 修法：失敗時至少 log 警示；gate 內顯式帶入本回合變更的 target。受影響軸④。

### P2 — 觀感與穩定
6. **進度列標籤錯置**：標準 review 印「adversarial」。修 `runGeminiReview` 進度訊息依模式分流。受影響軸④。
7. **stderr 雜訊滲入輸出**：過濾 DEP0190/256-color/ripgrep/thinking 等非結果文字，勿併入「Reasoning」。受影響軸③④。
8. **preview 模型漂移機制**：5 個 `*-preview` 別名 `lastVerified 2026-05`。
   - 修法：CI 增「別名解析健檢」或在 model-map 註記「逾期 N 月即警告」。受影響軸⑥。

### P3 — 完整度
9. **`gemini-prompting/references/` 補齊**：對齊 upstream `gpt-5-4-prompting` 的 reference 三件（blocks/recipes/antipatterns 的 Gemini 版）。受影響軸①⑤。
10. **DEP0190**：Windows `shell:true` 觸發；prompt 已走 stdin 不受影響，但可評估 `execFileSync` + 顯式 `.cmd` 解析以消警告。受影響軸⑥。

---

## 七、範圍與限制
- 本報告僅評「外掛把模型回饋呈現給使用者」之品質與對 upstream 的吻合度，不評斷 Gemini 模型本身優劣。
- codex native review 因本機未登入無法取得對照輸出；其「回饋品質」以設計面（native reviewer + schema）論。
- 實跑於單一平台（Windows）；macOS/Linux 之 AGY 路徑未實測。
