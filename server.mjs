import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const MAX_BODY_BYTES = 100 * 1024;

const TOPICS = new Set(["delivery", "pricing", "other"]);
// trim() не убирает zero-width символы, а строка из них для менеджера тоже пустая
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function isBlank(value) {
  return value.replace(INVISIBLE, "").trim() === "";
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Читаем тело с лимитом. Поток не рвем, а дочитываем вхолостую,
// иначе клиент получит обрыв соединения вместо нормального 413
function readBody(request) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"]);
    if (declared > MAX_BODY_BYTES) {
      request.resume();
      return resolve({ tooLarge: true });
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return resolve({ tooLarge: true });
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!tooLarge) resolve({ raw: Buffer.concat(chunks).toString("utf8") });
    });
    request.on("error", reject);
  });
}

// Возвращает текст заявки или null, если ввод не подходит
export function parseInput(raw, contentType = "") {
  // Только JSON: заодно обычная HTML-форма с чужого сайта не сможет дернуть API
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return null;
  let body;
  try {
    body = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!isPlainObject(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || isBlank(text)) return null;
  return text.trim();
}

// Проверка ответа модели. Ничего не чиним и не угадываем:
// если ответ не по контракту, заявку разбирает человек
export function parseModelOutput(output) {
  if (typeof output !== "string") return { error: "output_not_string" };
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    return { error: "output_not_json" };
  }
  if (!isPlainObject(data)) return { error: "output_not_object" };
  const { topic, draft } = data;
  if (typeof topic !== "string" || !TOPICS.has(topic)) return { error: "bad_topic" };
  if (typeof draft !== "string" || isBlank(draft)) return { error: "empty_draft" };
  // Лишние поля модели наружу не отдаем
  return { topic, draft: draft.trim() };
}

export async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model_timeout"));
    }, timeoutMs);
  });
  // then() ловит и синхронный throw, и reject
  const call = Promise.resolve().then(() => classify(text, { signal: controller.signal }));
  // после abort имитатор отклоняет промис, это ожидаемо, не даем ему стать unhandled
  call.catch(() => {});
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response, { classify, timeoutMs, log }) {
  const body = await readBody(request);
  if (body.tooLarge) {
    return json(response, 413, { status: "payload_too_large" }, { Connection: "close" });
  }
  const text = parseInput(body.raw, request.headers["content-type"]);
  if (text === null) return json(response, 400, INVALID_INPUT);

  let output;
  try {
    output = await callModel(classify, text, timeoutMs);
  } catch (error) {
    const reason = error?.message === "model_timeout" ? "timeout" : "model_error";
    log(`[triage] manual_review: ${reason}`);
    return json(response, 200, MANUAL_REVIEW);
  }

  const result = parseModelOutput(output);
  if (result.error) {
    // текст заявки в лог не пишем, там могут быть данные клиента
    log(`[triage] manual_review: ${result.error}`);
    return json(response, 200, MANUAL_REVIEW);
  }
  return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  return createServer(async (request, response) => {
    let pathname;
    try {
      ({ pathname } = new URL(request.url, "http://localhost"));
    } catch {
      return json(response, 400, { status: "bad_request" });
    }
    if (pathname === "/") {
      if (request.method !== "GET") return json(response, 405, { status: "method_not_allowed" }, { Allow: "GET" });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (pathname !== "/api/triage") return json(response, 404, { status: "not_found" });
    if (request.method !== "POST") {
      return json(response, 405, { status: "method_not_allowed" }, { Allow: "POST" });
    }
    try {
      await handleTriage(request, response, { classify, timeoutMs, log });
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${port}`);
  });
}
