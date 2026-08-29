<!-- captured: 2026-08-24 | assistant: Codex CLI 0.149.0 (codex exec, default model) | web search: 4 events -->

1. MCP cannot make Cursor’s or Claude’s own model context window 1M tokens.

MCP exposes tools/resources to the host model. To use Gemini’s 1M-token window, create an MCP tool that sends the large document or repository context to the Gemini API and returns Gemini’s answer. Cursor/Claude sees only the tool request and returned answer—not the entire 1M-token prompt. This follows MCP’s host/client/server architecture. [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

```text
Cursor or Claude
      │ MCP tool call: analyze_with_gemini(...)
      ▼
Local MCP server
      │ Gemini API request containing large context
      ▼
Gemini model (up to its documented context limit)
      │ concise result
      ▼
Cursor or Claude
```

2. Create a small Node.js MCP server.

```bash
mkdir gemini-mcp
cd gemini-mcp
npm init -y
npm install @modelcontextprotocol/sdk @google/genai zod
```

Add `"type": "module"` to `package.json`, then create `server.js`:

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const server = new McpServer({
  name: "gemini-long-context",
  version: "1.0.0",
});

server.tool(
  "ask_gemini",
  "Analyze large text using Gemini's long context window",
  {
    prompt: z.string(),
    context: z.string(),
  },
  async ({ prompt, context }) => {
    const response = await ai.models.generateContent({
      // Verify the selected model's current token limits before deployment.
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `${prompt}\n\n--- CONTEXT ---\n${context}`,
    });

    return {
      content: [{ type: "text", text: response.text ?? "" }],
    };
  },
);

await server.connect(new StdioServerTransport());
```

Google’s official SDK is `@google/genai`; Gemini models differ in their current input/output limits, which you can inspect through the Models API. Gemini 2.5 Flash is documented with a 1M-token context window. [Gemini long context](https://ai.google.dev/gemini-api/docs/long-context), [token limits](https://ai.google.dev/gemini-api/docs/tokens), [SDK quickstart](https://ai.google.dev/gemini-api/docs/generate-content/get-started)

3. Connect it to Cursor.

Create either:

- Project configuration: `.cursor/mcp.json`
- Global configuration: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "gemini-long-context": {
      "command": "node",
      "args": ["/absolute/path/to/gemini-mcp/server.js"],
      "env": {
        "GEMINI_API_KEY": "YOUR_API_KEY",
        "GEMINI_MODEL": "gemini-2.5-flash"
      }
    }
  }
}
```

Restart Cursor and check the MCP tools/settings page. Cursor officially supports local `stdio` servers configured this way. [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol)

4. Connect it to Claude Desktop.

The easiest current route is to package the server as a Desktop Extension (`.dxt`) and install it through:

```text
Settings → Extensions → Advanced settings → Install Extension
```

Claude Desktop also supports local MCP integrations, but the exact raw-JSON developer configuration can vary by Desktop release. Desktop Extensions are the supported user-facing installation mechanism documented by Anthropic. [Claude Desktop local MCP guide](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

5. Avoid passing a million tokens as an MCP tool argument.

That can still overwhelm the host application before Gemini receives it. A better production interface is:

```text
analyze_files(paths, question)
analyze_directory(root, include, exclude, question)
analyze_uploaded_file(file_uri, question)
continue_analysis(session_id, question)
```

The MCP server should read/upload the files itself and send them directly to Gemini. For repeated analysis, use Gemini file uploads, context caching, or server-side conversation state. Return a concise answer with filenames, citations, and relevant line ranges.

6. Important limitation:

```text
MCP tool backed by Gemini ≠ selecting Gemini as Cursor/Claude’s main model
```

If you want every coding turn to run natively on Gemini with its full context window, Cursor must support that Gemini model directly as a selectable provider/model. Claude Desktop does not become a Gemini frontend merely by connecting an MCP server; Gemini remains a delegated analysis tool.