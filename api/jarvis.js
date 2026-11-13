// Jarvis — the portfolio's AI assistant (Vercel Serverless Function).
//
// POST /api/jarvis  { messages: [{ role: "user" | "assistant", content: string }, ...] }
// Streams the reply as newline-delimited JSON events:
//   {"type":"delta","text":"..."}   a chunk of the answer
//   {"type":"error","message":"..."} something went wrong mid-answer
//   {"type":"done"}                   the answer is complete
//
// Environment variables (set them in Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  required — never exposed to the browser
//   JARVIS_MODEL       optional — defaults to claude-opus-5-5

import Anthropic from "@anthropic-ai/sdk";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const profile = require("../data/profile.json");

const MODEL = process.env.JARVIS_MODEL || "claude-opus-5-5";
// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-sonnet-5-5",
]);

// Abuse and cost guards for a public endpoint.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_TOTAL_CHARS = 16000;
const MAX_OUTPUT_TOKENS = 8000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 10;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function buildSystemPrompt(p) {
  const { jarvis: _ui, photo: _photo, ...facts } = p;
  const pronounRule = p.pronouns
    ? `When referring to ${p.name}, use the pronouns ${p.pronouns}.`
    : `Refer to ${p.name} by name, or with "they/them"; don't assume other pronouns.`;
  return `You are Jarvis, the AI assistant on ${p.name}'s portfolio website. Visitors (recruiters, clients, other developers) ask you about ${p.name}'s work, skills, projects and how to get in touch.

Answer using only the facts in the portfolio profile below. If something isn't covered there, say you don't have that information and suggest contacting ${p.name} directly; never invent employers, dates, credentials, metrics or contact details. Empty fields mean the information isn't available.

Speak about ${p.name} in the third person. ${pronounRule} Keep answers short and conversational: usually two to five sentences, or a brief list when listing several items. Write plain text; light use of "-" bullets is fine, but no headings, tables or code blocks unless the visitor asks for code. If a visitor asks for something unrelated to the portfolio, briefly help if it is quick and harmless, then steer back to ${p.name}'s work.

<portfolio_profile>
${JSON.stringify(facts, null, 2)}
</portfolio_profile>`;
}

const SYSTEM_PROMPT = buildSystemPrompt(profile);

export function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new HttpError(400, "Send at least one message.");
  }
  if (input.length > MAX_MESSAGES) {
    input = input.slice(-MAX_MESSAGES);
  }
  // The conversation must start with the visitor, so drop a leading assistant turn left by trimming.
  while (input.length && input[0]?.role === "assistant") input = input.slice(1);

  let total = 0;
  const messages = input.map((m, i) => {
    const role = m?.role;
    const content = typeof m?.content === "string" ? m.content.trim() : null;
    if (role !== "user" && role !== "assistant") throw new HttpError(400, "Invalid message role.");
    if (!content) throw new HttpError(400, "Messages can't be empty.");
    if (content.length > MAX_CHARS_PER_MESSAGE) {
      throw new HttpError(400, `Messages are limited to ${MAX_CHARS_PER_MESSAGE} characters.`);
    }
    if (i > 0 && input[i - 1].role === role) throw new HttpError(400, "Messages must alternate roles.");
    total += content.length;
    return { role, content };
  });

  if (messages.length === 0 || messages.at(-1).role !== "user") {
    throw new HttpError(400, "The last message must come from the visitor.");
  }
  if (total > MAX_TOTAL_CHARS) throw new HttpError(400, "This conversation is too long. Start a new chat.");
  return messages;
}

// Best-effort, per-instance limiter. Pair it with a monthly spend limit in the Anthropic Console.
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX_REQUESTS;
  if (!limited) recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
  }
  return limited;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

async function readJsonBody(req) {
  try {
    // Vercel pre-parses JSON bodies into req.body; plain Node servers don't.
    if (req.body !== undefined) {
      if (typeof req.body === "string") return JSON.parse(req.body);
      if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
      return req.body;
    }
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function writeEvent(res, event) {
  res.write(JSON.stringify(event) + "\n");
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { status: 503, message: "Jarvis is misconfigured right now. Please try again later." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "Jarvis is getting a lot of questions. Please try again in a minute." };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { status: 400, message: "Jarvis couldn't process that request." };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: 502, message: "Jarvis is temporarily unavailable. Please try again." };
  }
  return { status: 500, message: "Something went wrong. Please try again." };
}

let client;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed." });
  }
  if (isCrossOrigin(req)) return sendJson(res, 403, { error: "Forbidden." });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[jarvis] ANTHROPIC_API_KEY is not set");
    return sendJson(res, 503, { error: "Jarvis isn't configured yet." });
  }
  if (isRateLimited(clientIp(req))) {
    res.setHeader("Retry-After", String(RATE_WINDOW_MS / 1000));
    return sendJson(res, 429, { error: "You're sending messages quickly. Please wait a moment." });
  }

  let messages;
  try {
    messages = validateMessages((await readJsonBody(req))?.messages);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    throw err;
  }

  client ??= new Anthropic({ maxRetries: 1 });
  const params = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: { effort: "low" }, // short conversational answers
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    messages,
  };
  if (FALLBACK_MODELS.has(MODEL)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const stream = client.beta.messages.stream(params);
  res.on("close", () => {
    if (!res.writableFinished) stream.abort(); // visitor closed the tab — stop paying for tokens
  });

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
          });
        }
        writeEvent(res, { type: "delta", text: event.delta.text });
      }
    }
    const final = await stream.finalMessage();
    if (!res.headersSent) {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    }
    if (final.stop_reason === "refusal") {
      writeEvent(res, { type: "error", message: "Jarvis can't help with that one. Try asking about the projects or skills." });
    } else if (final.stop_reason === "max_tokens") {
      writeEvent(res, { type: "error", message: "That answer was cut short. Try a more specific question." });
    }
    writeEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    if (res.destroyed) return; // client went away
    const { status, message } = describeApiError(err);
    console.error("[jarvis]", err?.status ?? "", err?.message ?? err);
    if (!res.headersSent) return sendJson(res, status, { error: message });
    writeEvent(res, { type: "error", message });
    res.end();
  }
}
