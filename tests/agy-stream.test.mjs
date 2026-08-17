import assert from "node:assert/strict";
import test from "node:test";

import { createAgyStreamReader, readAgyStream } from "../plugins/gemini/scripts/lib/agy-stream.mjs";

// Captured verbatim from AGY 1.1.12 answering "Count from 1 to 40, one number
// per line, nothing else." Kept as-is rather than hand-written, so a change in
// the upstream shape shows up here as a failure rather than as a reader that
// silently returns nothing.
const CONV = "44d667f8-dcda-4c7b-86ef-87a19f484dcd";
const MEASURED_STREAM = [
  `{"event":"init","conversation_id":"${CONV}","init":{"cwd":"C:\\\\tmp","tools":["ask_permission"],"permission_mode":"default"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.0019596}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"1\\n2\\n3"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\\n","usage":{"output_tokens":246}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":3,"state":"DONE","step_type":"checkpoint","duration_seconds":0.6089184}}`,
  `{"event":"result","result":{"conversation_id":"${CONV}","status":"SUCCESS","response":"1\\n2\\n3\\n","duration_seconds":4.15,"num_turns":1,"usage":{"total_tokens":14301}}}`
].join("\n");

test("concatenated agent_response deltas reproduce the final response", () => {
  const reader = readAgyStream(MEASURED_STREAM);
  assert.equal(reader.partialText(), reader.envelope().response);
});

test("the terminal envelope is exposed as the engine returned it", () => {
  const envelope = readAgyStream(MEASURED_STREAM).envelope();
  assert.equal(envelope.status, "SUCCESS");
  assert.equal(envelope.usage.total_tokens, 14301);
});

test("the conversation id is picked up even before the result arrives", () => {
  const reader = createAgyStreamReader();
  reader.accept(MEASURED_STREAM.split("\n")[0]);
  assert.equal(reader.state.conversationId, CONV);
});

test("a delta on a step that is not agent_response is never treated as answer text", () => {
  // The failure this guards against is silent corruption of the one output the
  // reader exists to preserve.
  const reader = readAgyStream(
    [
      `{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"tool_call","text_delta":"rm -rf /"}}`,
      `{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"real answer"}}`
    ].join("\n")
  );
  assert.equal(reader.partialText(), "real answer");
});

test("a stream cut off mid-answer keeps what was written", () => {
  // Everything up to and including the first agent_response delta, then nothing:
  // the shape of a run killed by a timeout.
  const truncated = MEASURED_STREAM.split("\n").slice(0, 4).join("\n");
  const reader = readAgyStream(truncated);
  assert.equal(reader.partialText(), "1\n2\n3");
  assert.equal(reader.envelope(), null, "no terminal envelope arrived");
  assert.match(reader.progressLabel(), /agent_response/);
});

test("an unparseable line is counted, not thrown on", () => {
  const reader = readAgyStream(`not json at all\n${MEASURED_STREAM}`);
  assert.equal(reader.state.unparsedLines, 1);
  assert.equal(reader.partialText(), "1\n2\n3\n", "the rest of the stream still parses");
});

test("an unrecognised event type does not stop the run", () => {
  const reader = readAgyStream(
    [
      `{"event":"something_upstream_added_later","payload":{"whatever":1}}`,
      `{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"agent_response","text_delta":"ok"}}`
    ].join("\n")
  );
  assert.equal(reader.partialText(), "ok");
  assert.equal(reader.state.unknownEvents.get("something_upstream_added_later"), 1);
});

test("a read-only slash command emits no steps and no text", () => {
  const reader = readAgyStream(
    [
      `{"event":"command_result","command":{"name":"usage","data":{}}}`,
      `{"event":"result","result":{"conversation_id":"","status":"SUCCESS","response":"98%"}}`
    ].join("\n")
  );
  assert.equal(reader.partialText(), "");
  assert.equal(reader.envelope().status, "SUCCESS");
});

test("progress is reportable before anything has been answered", () => {
  const reader = readAgyStream(MEASURED_STREAM.split("\n").slice(0, 2).join("\n"));
  assert.match(reader.progressLabel(), /step 0 user_input/);
});

test("an empty stream reports that nothing arrived rather than failing", () => {
  const reader = readAgyStream("");
  assert.equal(reader.partialText(), "");
  assert.equal(reader.envelope(), null);
  assert.equal(reader.progressLabel(), "no output received");
});

test("CRLF line endings parse identically", () => {
  const reader = readAgyStream(MEASURED_STREAM.replace(/\n(?={")/g, "\r\n"));
  assert.equal(reader.partialText(), "1\n2\n3\n");
});

// --- through the real turn path ---------------------------------------------

import { runGeminiTurn } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { supportsAgyStreamJson } from "../plugins/gemini/scripts/lib/engine.mjs";

function agyEngine(version) {
  return () => ({ engine: "agy", binary: "/fake/agy.exe", version });
}

function stubRun({ stdout = "", stderr = "", status = 0 } = {}) {
  const calls = [];
  const fn = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return { stdout, stderr, status };
  };
  fn.calls = calls;
  return fn;
}

function outputFormatOf(call) {
  const at = call.args.indexOf("--output-format");
  return at === -1 ? null : call.args[at + 1];
}

test("the stream-json gate opens at the version it was measured on", () => {
  assert.equal(supportsAgyStreamJson("1.1.12"), true);
  assert.equal(supportsAgyStreamJson("1.1.11"), false);
  assert.equal(supportsAgyStreamJson("1.2.0"), true);
});

test("AGY 1.1.12 is asked for stream-json", async () => {
  const runCommandFn = stubRun({ stdout: MEASURED_STREAM });
  await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine("1.1.12")
  });
  assert.equal(outputFormatOf(runCommandFn.calls[0]), "stream-json");
});

test("AGY 1.1.11 keeps plain json, which still works", async () => {
  const envelope = { conversation_id: "c", status: "SUCCESS", response: "done", num_turns: 1 };
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(envelope)}\n` });
  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine("1.1.11")
  });
  assert.equal(outputFormatOf(runCommandFn.calls[0]), "json");
  assert.equal(result.finalMessage, "done");
  assert.equal(result.failure ?? null, null);
});

test("a successful stream-json turn reads the response from its final event", async () => {
  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: MEASURED_STREAM }),
    detectEngineFn: agyEngine("1.1.12")
  });
  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "1\n2\n3");
  assert.equal(result.threadId, CONV);
  assert.equal(result.failure ?? null, null);
});

test("a print-timeout that empties the envelope still returns what was written", async () => {
  // The exact failure this whole change exists for: AGY's own timeout emits a
  // well-formed envelope whose response is empty, so every earlier path reported
  // nothing at all despite the deltas having already arrived.
  const timedOut = [
    `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"half an answer"}}`,
    `{"event":"result","result":{"conversation_id":"${CONV}","status":"ERROR","response":"","error":"timeout waiting for response","usage":{"output_tokens":31622}}}`
  ].join("\n");

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: timedOut, status: 1 }),
    detectEngineFn: agyEngine("1.1.12")
  });

  assert.equal(result.finalMessage, "half an answer", "the salvaged text is the output");
  assert.ok(result.failure, "and it is still reported as a failure, because it is partial");
  assert.notEqual(result.status, 0, "a cut-off run must never pass for a complete one");
});

test("salvaged text never overrides a response the envelope actually carried", async () => {
  const both = [
    `{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"agent_response","text_delta":"deltas"}}`,
    `{"event":"result","result":{"conversation_id":"${CONV}","status":"SUCCESS","response":"authoritative","num_turns":1}}`
  ].join("\n");

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: both }),
    detectEngineFn: agyEngine("1.1.12")
  });
  assert.equal(result.finalMessage, "authoritative");
});

test("a single-line json envelope is not mistaken for a one-event stream", () => {
  const envelope = { conversation_id: "c", status: "SUCCESS", response: "hi" };
  const reader = readAgyStream(`${JSON.stringify(envelope)}\n`);
  assert.equal(reader.looksLikeStream(), false);
  assert.equal(reader.envelope(), null, "it carries no `event` key, so it is not a stream event");
});

test("a real stream is recognised as one", () => {
  assert.equal(readAgyStream(MEASURED_STREAM).looksLikeStream(), true);
});

test("a timed-out run says how far it got, not just that it timed out", async () => {
  // The case that started this: the timeout landed before any answer was
  // written, so there is no text to salvage — but "reached step 2 tool_call"
  // is the difference between a report and a shrug.
  const beforeAnswering = [
    `{"event":"step_update","step_update":{"conversation_id":"${CONV}","step_index":2,"state":"ACTIVE","step_type":"tool_call"}}`,
    `{"event":"result","result":{"conversation_id":"${CONV}","status":"ERROR","response":"","error":"timeout waiting for response"}}`
  ].join("\n");

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: beforeAnswering, status: 1 }),
    detectEngineFn: agyEngine("1.1.12")
  });

  assert.ok(result.failure, "still a failure");
  assert.match(result.failure.summary, /reached step 2 tool_call/);
  assert.doesNotMatch(result.failure.summary, /partial output preserved/, "there was none to preserve");
});

test("when partial output survives, the summary says so", async () => {
  const withText = [
    `{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"half"}}`,
    `{"event":"result","result":{"conversation_id":"${CONV}","status":"ERROR","response":"","error":"timeout"}}`
  ].join("\n");

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: withText, status: 1 }),
    detectEngineFn: agyEngine("1.1.12")
  });

  assert.match(result.failure.summary, /partial output preserved/);
  assert.equal(result.finalMessage, "half");
});

test("a successful run's summary is not annotated", async () => {
  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: MEASURED_STREAM }),
    detectEngineFn: agyEngine("1.1.12")
  });
  assert.equal(result.failure ?? null, null, "nothing to annotate on success");
});

test("a SUCCESS envelope with an empty response does not let salvaged text pass for success", async () => {
  // The envelope is the authority on completeness. If it claims SUCCESS but
  // carries no response, the deltas are all there is — and there is no way to
  // know whether they are the whole answer. Returning them is right; calling
  // the run successful is not.
  const emptySuccess = [
    `{"event":"step_update","step_update":{"step_index":0,"state":"ACTIVE","step_type":"agent_response","text_delta":"maybe all of it, maybe not"}}`,
    `{"event":"result","result":{"conversation_id":"${CONV}","status":"SUCCESS","response":"","num_turns":1}}`
  ].join("\n");

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn: stubRun({ stdout: emptySuccess, status: 0 }),
    detectEngineFn: agyEngine("1.1.12")
  });

  assert.equal(result.finalMessage, "maybe all of it, maybe not", "the text is still handed over");
  assert.ok(result.failure, "but completeness was never established, so this is not success");
  assert.notEqual(result.status, 0);
});
