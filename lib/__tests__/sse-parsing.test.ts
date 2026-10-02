/**
 * SSE event-splitting.
 *
 * This guards the single most damaging bug found in the whole audit: every
 * stream parser split events on the literal string "\n\n", but Gemini
 * terminates SSE events with CRLF CRLF. "\r\n\r\n" contains no "\n\n"
 * substring, so the split matched NOTHING — every chunk stayed in the buffer,
 * zero events were parsed, and the stream returned an empty string while
 * reporting success.
 *
 * The visible symptom was "Gemini returns empty output, then fails schema
 * validation" — which had been written off in a code comment as Gemini
 * "occasionally" returning empty text. It was not occasional. Gemini streaming
 * had never worked, and Gemini is the app's headline free-tier provider.
 */
import { describe, it, expect } from "vitest";
import { SSE_EVENT_DELIMITER } from "../providers/types";

/** Mirrors the parsing in every provider's stream(): split, keep remainder. */
function parseEvents(buffer: string): { events: string[]; remainder: string } {
  const events = buffer.split(SSE_EVENT_DELIMITER);
  const remainder = events.pop() ?? "";
  return { events, remainder };
}

/** Mirrors the data-line extraction. */
function dataLines(ev: string): string[] {
  return ev
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, "").trim())
    .filter((l) => l && l !== "[DONE]");
}

describe("SSE_EVENT_DELIMITER", () => {
  it("splits LF LF events (Anthropic, OpenAI-compatible hosts)", () => {
    const buf = 'data: {"a":1}\n\ndata: {"a":2}\n\n';
    const { events } = parseEvents(buf);
    expect(events).toHaveLength(2);
    expect(dataLines(events[0])).toEqual(['{"a":1}']);
  });

  it("splits CRLF CRLF events (Gemini) — the case that was silently broken", () => {
    const buf = 'data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n';
    const { events } = parseEvents(buf);
    expect(events, "CRLF events must be parsed, not swallowed").toHaveLength(2);
    expect(dataLines(events[0])).toEqual(['{"a":1}']);
    expect(dataLines(events[1])).toEqual(['{"a":2}']);
  });

  it("proves the old implementation parsed ZERO Gemini events", () => {
    const buf = 'data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n';
    // The previous code: buffer.split("\n\n")
    const old = buf.split("\n\n");
    old.pop(); // remainder
    expect(old, "regression witness: old splitter yielded no events").toHaveLength(0);
  });

  it("keeps a partial trailing event in the remainder for the next chunk", () => {
    const buf = 'data: {"a":1}\r\n\r\ndata: {"par';
    const { events, remainder } = parseEvents(buf);
    expect(events).toHaveLength(1);
    expect(remainder).toBe('data: {"par');
  });

  it("reassembles an event split across two network chunks", () => {
    let buffer = "";
    const seen: string[] = [];
    for (const chunk of ['data: {"text":"hel', 'lo"}\r\n\r\ndata: {"text":"world"}\r\n\r\n']) {
      buffer += chunk;
      const { events, remainder } = parseEvents(buffer);
      buffer = remainder;
      for (const ev of events) seen.push(...dataLines(ev));
    }
    expect(seen).toEqual(['{"text":"hello"}', '{"text":"world"}']);
  });

  it("strips the trailing CR so JSON.parse succeeds", () => {
    const [line] = dataLines('data: {"ok":true}\r');
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toEqual({ ok: true });
  });

  it("handles a multi-line event with an event: field before data:", () => {
    const ev = 'event: message\r\ndata: {"v":9}\r';
    expect(dataLines(ev)).toEqual(['{"v":9}']);
  });

  it("ignores [DONE] sentinels", () => {
    expect(dataLines("data: [DONE]")).toEqual([]);
  });
});
