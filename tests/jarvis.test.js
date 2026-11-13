// Tests for api/jarvis.js. Runs the real handler over HTTP against a local mock of the
// Anthropic Messages API, so no API key or network access is needed: `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import handler, { validateMessages, buildSystemPrompt } from "../api/jarvis.js";
import profile from "../data/profile.json" with { type: "json" };

let mock, app, appUrl;
let scenario = "ok";
let lastUpstream = null;
let ipCounter = 0;

function sse(events) {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function messageStream(chunks, stopReason) {
  return sse([
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...chunks.map((text) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

before(async () => {
  mock = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    lastUpstream = { url: req.url, headers: req.headers, body: JSON.parse(body || "{}") };
    if (scenario === "auth-error") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (scenario === "refusal") return res.end(messageStream([], "refusal"));
    res.end(messageStream(["StayEase ", "uses row locks ", "inside a transaction."], "end_turn"));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));

  app = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${app.address().port}/api/jarvis`;
});

after(() => {
  mock.close();
  app.close();
});

function post(body, headers = {}) {
  return fetch(appUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ipCounter}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ask = (q) => ({ messages: [{ role: "user", content: q }] });

function parseNdjson(text) {
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

test("rejects non-POST requests", async () => {
  const res = await fetch(appUrl);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("returns 503 when ANTHROPIC_API_KEY is missing", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const res = await post(ask("hi"));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /isn't configured/);
});

test("configure key and mock upstream", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-key";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
});

test("validates input", async () => {
  for (const body of [
    {},
    { messages: [] },
    { messages: [{ role: "system", content: "x" }] },
    { messages: [{ role: "user", content: "   " }] },
    { messages: [{ role: "user", content: "x".repeat(2001) }] },
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
    { messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await post("{not json")).status, 400);
});

test("blocks cross-origin browser requests", async () => {
  const res = await post(ask("hi"), { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("streams the answer and sends the expected request upstream", async () => {
  const history = {
    messages: [
      { role: "user", content: "What has been built?" },
      { role: "assistant", content: "StayEase, a hotel booking system." },
      { role: "user", content: "How does it prevent double bookings?" },
    ],
  };
  const host = new URL(appUrl).host;
  const res = await post(history, { origin: `http://${host}` });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);

  const events = parseNdjson(await res.text());
  const text = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.equal(text, "StayEase uses row locks inside a transaction.");
  assert.deepEqual(events.at(-1), { type: "done" });

  const up = lastUpstream;
  assert.equal(up.headers.authorization, "Bearer sk-test-key"); // SDK 1.x sends the key as a bearer token
  assert.match(up.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(up.body.model, "claude-opus-5-5");
  assert.equal(up.body.fallbacks, "default");
  assert.equal(up.body.stream, true);
  assert.deepEqual(up.body.output_config, { effort: "low" });
  assert.deepEqual(up.body.messages, history.messages);
  assert.match(up.body.system, /StayEase/);
  assert.doesNotMatch(up.body.system, /"suggestions"/, "UI-only config should not reach the model");
});

test("turns a refusal into a friendly error event", async () => {
  scenario = "refusal";
  const events = parseNdjson(await (await post(ask("something off-limits"))).text());
  assert.equal(events[0].type, "error");
  assert.deepEqual(events.at(-1), { type: "done" });
  scenario = "ok";
});

test("hides upstream auth errors from visitors", async () => {
  scenario = "auth-error";
  const res = await post(ask("hi"));
  assert.equal(res.status, 503);
  const { error } = await res.json();
  assert.doesNotMatch(error, /x-api-key/);
  scenario = "ok";
});

test("rate limits a single client", async () => {
  const ip = { "x-forwarded-for": "203.0.113.7" };
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await post(ask("hi"), ip)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
});

test("validateMessages trims history to the last 20 turns, starting with the visitor", () => {
  const long = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  const out = validateMessages(long);
  assert.ok(out.length <= 20);
  assert.equal(out[0].role, "user");
  assert.equal(out.at(-1).content, "m24");
});

test("system prompt is built from profile.json", () => {
  const prompt = buildSystemPrompt(profile);
  assert.match(prompt, new RegExp(profile.name));
  assert.match(prompt, /never invent/);
});
