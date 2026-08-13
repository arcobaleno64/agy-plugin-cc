// Reader for AGY's `--output-format stream-json` event stream.
//
// WHY THIS EXISTS
// ---------------
// Under `--output-format json` a run that is cut off has nothing to show for
// itself: the envelope only arrives at the end, and when AGY's own print timeout
// fires it emits `{"status":"ERROR","response":""}`. The on-disk transcript does
// not cover that case either — measured on a run that spent 193,772 tokens
// before timing out, the transcript's response was likewise empty, because the
// turn never reached the point of writing an answer.
//
// stream-json emits progress as it happens, so a cut-off run can at least say
// how far it got, and a run cut off *while answering* keeps the part it wrote.
//
// No async rewrite is needed to collect it. spawnSync keeps what the child had
// written when its timeout kills it — measured against a child emitting a line
// every 20ms, 20/46/94 lines survived timeouts of 800/1500/3000ms, with
// `signal: SIGTERM`. (Two earlier measurements suggesting otherwise were wrong:
// the child had failed on a `node -e` quoting error and written nothing, which
// shows up as `status: 1, signal: null` rather than a signal.) So the existing
// synchronous runCommand is enough, and the streaming path that was written for
// this was removed rather than kept as a second spawn implementation.
//
// THE SHAPE, AS MEASURED (AGY 1.1.12)
// -----------------------------------
// One JSON object per line, keyed by `event` — not `type`:
//
//   {"event":"init","conversation_id":"…","init":{cwd,tools,permission_mode}}
//   {"event":"step_update","step_update":{conversation_id,step_index,state,step_type,…}}
//   {"event":"result","result":{conversation_id,status,response,duration_seconds,num_turns,usage}}
//
// `step_type` has been seen as user_input, unknown, agent_response and
// checkpoint; `state` as ACTIVE and DONE. `text_delta` appears only on
// agent_response steps and is incremental — concatenating every delta reproduces
// `result.response` exactly. A read-only slash command such as /quota emits
// `command_result` instead of any step, and no turn is billed.
//
// Nothing here requires that list to be complete. An unrecognised event, an
// unparseable line, or a missing field is counted and skipped: this reader's job
// is to salvage what it can, so it must never be the thing that fails.

const AGENT_RESPONSE_STEP = "agent_response";

export function createAgyStreamReader() {
  const state = {
    conversationId: null,
    text: "",
    envelope: null,
    steps: [],
    lastStep: null,
    events: 0,
    eventfulLines: 0,
    unparsedLines: 0,
    unknownEvents: new Map()
  };

  function noteConversationId(candidate) {
    if (typeof candidate === "string" && candidate && !state.conversationId) {
      state.conversationId = candidate;
    }
  }

  function accept(line) {
    const text = String(line ?? "").trim();
    if (!text) return;

    let event;
    try {
      event = JSON.parse(text);
    } catch {
      state.unparsedLines += 1;
      return;
    }
    if (!event || typeof event !== "object") {
      state.unparsedLines += 1;
      return;
    }

    state.events += 1;
    const name = typeof event.event === "string" ? event.event : null;
    // A plain `--output-format json` envelope is one valid JSON line too, and
    // it must not be mistaken for a one-event stream. Only a line carrying an
    // `event` key counts towards "this is a stream".
    if (name) state.eventfulLines += 1;
    noteConversationId(event.conversation_id);

    if (name === "init") {
      return;
    }

    if (name === "step_update") {
      const step = event.step_update;
      if (!step || typeof step !== "object") return;
      noteConversationId(step.conversation_id);

      const record = {
        index: typeof step.step_index === "number" ? step.step_index : null,
        type: typeof step.step_type === "string" ? step.step_type : "unknown",
        state: typeof step.state === "string" ? step.state : null
      };
      state.steps.push(record);
      state.lastStep = record;

      // Only an agent_response delta is answer text. A delta on any other step
      // type would be something else entirely, and appending it would corrupt
      // the very output this exists to preserve.
      if (record.type === AGENT_RESPONSE_STEP && typeof step.text_delta === "string") {
        state.text += step.text_delta;
      }
      return;
    }

    if (name === "result") {
      const result = event.result;
      if (result && typeof result === "object") {
        state.envelope = result;
        noteConversationId(result.conversation_id);
      }
      return;
    }

    if (name === "command_result") {
      // A read-only slash command answered without starting a turn.
      return;
    }

    if (name) state.unknownEvents.set(name, (state.unknownEvents.get(name) ?? 0) + 1);
  }

  return {
    accept,
    get state() {
      return state;
    },
    /**
     * Whether this output is a stream at all. A `--output-format json` envelope
     * parses as one JSON line, so the caller needs to tell the two apart before
     * trusting anything else here.
     */
    looksLikeStream() {
      return state.eventfulLines > 0;
    },
    /** What was written before the stream ended, if anything. */
    partialText() {
      return state.text;
    },
    /** The terminal envelope, when one arrived. */
    envelope() {
      return state.envelope;
    },
    /**
     * A one-line description of how far the run got, for a report that would
     * otherwise say only that it timed out.
     */
    progressLabel() {
      if (!state.lastStep) return state.events > 0 ? "started, no step reported" : "no output received";
      const { index, type, state: stepState } = state.lastStep;
      const position = index === null ? "" : `step ${index} `;
      return `${position}${type}${stepState ? ` (${stepState})` : ""}`;
    }
  };
}

/**
 * Read a whole stream-json payload at once — for stdout captured without a live
 * line handler, and for tests.
 */
export function readAgyStream(rawStdout) {
  const reader = createAgyStreamReader();
  for (const line of String(rawStdout ?? "").split(/\r?\n/)) reader.accept(line);
  return reader;
}
