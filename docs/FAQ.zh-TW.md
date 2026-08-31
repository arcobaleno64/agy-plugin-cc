# 常見問題

English: [`FAQ.md`](FAQ.md)

這份 FAQ 只提供通往 repository 現行證據的短路徑；行為變更時，仍以連結的來源文件為準。

## agy-plugin-cc 是什麼？

它是獨立維護的 Claude Code companion，透過 Gemini CLI 或 Antigravity CLI（`agy`）執行跨模型任務委派與程式碼審查。它與 Google、Anthropic 均無隸屬、背書或贊助關係，也不是通用型 multi-agent framework。

依據：[`README.md`](../README.md) · [`COMPARISON.md`](COMPARISON.md)

## 我該選哪個引擎？

安裝並認證其中一個引擎即可，不必兩者都裝。個人帳號實務上以 AGY 為預設選擇；若具備支援的存取資格，且需要 Gemini CLI 特有的模型與 JSON 行為，則可選 Gemini CLI。`auto` 會先檢查已認證的 Gemini CLI，再檢查 AGY；明確指定 `--engine` 會覆蓋此選擇。

依據：[`README.md`](../README.md) · [`engine.mjs`](../plugins/gemini/scripts/lib/engine.mjs)

## 實用型與對抗性審查有何不同？

`/gemini:review` 尋找具體缺陷與未完成的程式路徑。`/gemini:adversarial-review` 會挑戰做法本身，並接受選用的聚焦文字；兩者加上 `--deep` 後，都可檢查 diff 以外的相關 repository 脈絡。

依據：[`README.md`](../README.md) · [`review.md`](../plugins/gemini/commands/review.md) · [`adversarial-review.md`](../plugins/gemini/commands/adversarial-review.md)

## 被委派的工作可以寫入檔案嗎？

除非明確傳入 `--write`，否則 `/gemini:rescue` 不會以寫入意圖派送。審查命令雖以唯讀意圖派送，但本外掛無法保證每種引擎設定都會阻止寫入；它會在執行後比對 workspace，並回報偵測到的變更。

依據：[`PRIVACY.md`](../PRIVACY.md) · [`THREAT-MODEL.md`](THREAT-MODEL.md)

## 被委派的引擎有 sandbox 或檔案系統邊界嗎？

本外掛不提供可一概而論的此類邊界。AGY 權限取決於使用者設定；Gemini CLI 雖有 container sandbox，但本外掛不會啟用或要求它。不要把審查命令或 MCP annotation 視為可強制執行的 filesystem sandbox。

依據：[`PRIVACY.md`](../PRIVACY.md) · [`THREAT-MODEL.md`](THREAT-MODEL.md)

## 哪些資料可能離開我的電腦？

本外掛不營運任何 hosted service；它啟動你安裝的 engine CLI，由該 CLI 將組合後的 prompt 傳給 Google。審查內容可能包含 git status、diff 與符合條件的 untracked file 內容，而 agentic engine 在派送後仍可能自行讀取其他 workspace 資料。選用的 Stop review gate 是唯一的自動傳送路徑，且在使用者啟用前預設關閉。

依據：[`PRIVACY.md`](../PRIVACY.md) · [`SECURITY.md`](../SECURITY.md)

## MCP 提供哪些功能？

MCP server 提供背景任務委派、實用型與對抗性審查，以及工作狀態、結果與取消工具。它不涵蓋所有 slash command；安全 annotation 描述的是保守的最壞情況，不是對引擎行為或所有 MCP client 相容性的保證。

依據：[`README.md`](../README.md) · [`gemini-mcp.mjs`](../plugins/gemini/scripts/gemini-mcp.mjs)

## 如何安裝外掛？

將 `arcobaleno64/agy-plugin-cc` 加入 Claude Code marketplace、安裝 `gemini@agy-plugin-cc`，再執行 `/reload-plugins`。所選的 Gemini CLI 或 AGY 引擎必須另外安裝並完成認證。

依據：[`README.md`](../README.md)

## 如何更新？

release-channel marketplace 會追蹤 `main`，但既有安裝只會在 manifest 版本變更後更新。第三方 marketplace 預設關閉自動更新；README 同時記載啟用方式與明確更新命令，完成後需執行 `/reload-plugins`。

依據：[`README.md`](../README.md) · [`version-sources.md`](version-sources.md)

## 如何釘選特定版本？

以 `arcobaleno64/agy-plugin-cc@<release-tag>` 加入 marketplace，再安裝外掛並重新載入。即使 marketplace 已啟用自動更新，釘選後仍會停在該 git tag；如需移至其他版本，必須用新 tag 重新加入 marketplace。

依據：[`README.md`](../README.md) · [`version-sources.md`](version-sources.md)
