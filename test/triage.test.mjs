import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createApp, MODEL_TIMEOUT_MS, MAX_BODY_BYTES } from "../server.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };

async function startServer(options = {}) {
  const server = createApp({ log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

function post(url, body, contentType = "application/json") {
  const headers = contentType ? { "Content-Type": contentType } : {};
  return fetch(`${url}/api/triage`, { method: "POST", headers, body });
}

async function triage(url, text) {
  const reply = await post(url, JSON.stringify({ text }));
  return { status: reply.status, body: await reply.json() };
}

describe("с выданным имитатором", () => {
  let app;
  before(async () => { app = await startServer(); });
  after(() => app.close());

  describe("400 invalid_input", () => {
    const cases = [
      ["битый JSON", "{\"text\":", undefined],
      ["пустое тело", "", undefined],
      ["нет поля text", JSON.stringify({ message: "привет" }), undefined],
      ["text = null", JSON.stringify({ text: null }), undefined],
      ["text = число", JSON.stringify({ text: 42 }), undefined],
      ["text = массив", JSON.stringify({ text: ["доставка"] }), undefined],
      ["text = объект", JSON.stringify({ text: { a: 1 } }), undefined],
      ["text = true", JSON.stringify({ text: true }), undefined],
      ["пустая строка", JSON.stringify({ text: "" }), undefined],
      ["только пробелы и переносы", JSON.stringify({ text: "  \n\t  " }), undefined],
      ["неразрывные пробелы", JSON.stringify({ text: "\u00A0\u3000" }), undefined],
      ["только zero-width символы", JSON.stringify({ text: "\u200B\u200D\uFEFF" }), undefined],
      ["тело = массив", JSON.stringify([{ text: "цена" }]), undefined],
      ["тело = null", "null", undefined],
      ["тело = строка", JSON.stringify("цена"), undefined],
      ["тело = число", "123", undefined],
      ["text/plain вместо JSON", JSON.stringify({ text: "цена" }), "text/plain"],
      ["форма вместо JSON", "text=цена", "application/x-www-form-urlencoded"],
      ["без Content-Type", JSON.stringify({ text: "цена" }), null],
    ];
    for (const [name, body, contentType] of cases) {
      test(name, async () => {
        const reply = await post(app.url, body, contentType);
        assert.equal(reply.status, 400);
        assert.deepEqual(await reply.json(), { status: "invalid_input" });
      });
    }
  });

  test("слишком большое тело получает 413, сервер не падает", async () => {
    const reply = await post(app.url, JSON.stringify({ text: "а".repeat(MAX_BODY_BYTES) }));
    assert.equal(reply.status, 413);
    assert.deepEqual(await reply.json(), { status: "payload_too_large" });
    assert.equal((await triage(app.url, "Сколько стоит?")).status, 200);
  });

  describe("успех", () => {
    test("доставка", async () => {
      const { status, body } = await triage(app.url, "Когда будет доставка заказа?");
      assert.equal(status, 200);
      assert.deepEqual(body, { status: "ready", topic: "delivery", draft: "Спасибо за обращение. Уточним детали заявки." });
    });
    test("цена", async () => {
      assert.equal((await triage(app.url, "Какая цена за 10 штук?")).body.topic, "pricing");
    });
    test("прочее, эмодзи и пробелы вокруг", async () => {
      const { body } = await triage(app.url, "  Привет 👋 у меня вопрос  ");
      assert.equal(body.status, "ready");
      assert.equal(body.topic, "other");
    });
    test("Content-Type с charset", async () => {
      const reply = await post(app.url, JSON.stringify({ text: "Стоимость?" }), "application/json; charset=utf-8");
      assert.equal(reply.status, 200);
    });
    test("BOM в начале тела", async () => {
      const reply = await post(app.url, "\uFEFF" + JSON.stringify({ text: "Стоимость?" }));
      assert.equal(reply.status, 200);
    });
  });

  describe("сбои модели дают manual_review", () => {
    for (const label of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
      test(label, async () => {
        const { status, body } = await triage(app.url, `Где доставка? ${label}`);
        assert.equal(status, 200);
        assert.deepEqual(body, MANUAL);
      });
    }

    test("[timeout] укладывается в лимит 300 мс", async () => {
      const started = performance.now();
      const { status, body } = await triage(app.url, "Сколько стоит? [timeout]");
      const elapsed = performance.now() - started;
      assert.equal(status, 200);
      assert.deepEqual(body, MANUAL);
      assert.ok(elapsed >= MODEL_TIMEOUT_MS - 20, `слишком рано: ${elapsed} мс`);
      assert.ok(elapsed < MODEL_TIMEOUT_MS + 250, `слишком долго: ${elapsed} мс`);
    });

    test("метка в другом регистре тоже работает", async () => {
      assert.deepEqual((await triage(app.url, "[ERROR] цена")).body, MANUAL);
    });

    test("параллельные запросы не мешают друг другу", async () => {
      const texts = ["цена", "доставка [timeout]", "привет", "[error]", "доставка"];
      const results = await Promise.all(texts.map((t) => triage(app.url, t)));
      assert.deepEqual(results.map((r) => r.body.topic), ["pricing", null, "other", null, "delivery"]);
    });
  });

  describe("маршруты", () => {
    test("GET / отдает страницу", async () => {
      const reply = await fetch(`${app.url}/`);
      assert.equal(reply.status, 200);
      assert.match(reply.headers.get("content-type"), /text\/html/);
    });
    test("GET /api/triage дает 405", async () => {
      const reply = await fetch(`${app.url}/api/triage`);
      assert.equal(reply.status, 405);
      assert.equal(reply.headers.get("allow"), "POST");
    });
    test("неизвестный путь дает 404", async () => {
      assert.equal((await fetch(`${app.url}/nope`)).status, 404);
    });
  });
});

describe("проверка ответа модели (подменный classify)", () => {
  const cases = [
    ["не строка, а объект", () => ({ topic: "pricing", draft: "Ок" })],
    ["undefined", () => undefined],
    ["JSON-массив", () => JSON.stringify([{ topic: "pricing", draft: "Ок" }])],
    ["JSON null", () => "null"],
    ["тема в другом регистре", () => JSON.stringify({ topic: "Delivery", draft: "Ок" })],
    ["тема с пробелом", () => JSON.stringify({ topic: "pricing ", draft: "Ок" })],
    ["нет темы", () => JSON.stringify({ draft: "Ок" })],
    ["тема из прототипа", () => JSON.stringify({ topic: "constructor", draft: "Ок" })],
    ["черновик не строка", () => JSON.stringify({ topic: "other", draft: 42 })],
    ["черновик из zero-width", () => JSON.stringify({ topic: "other", draft: "\u200B" })],
    ["JSON в markdown", () => "```json\n" + JSON.stringify({ topic: "other", draft: "Ок" }) + "\n```"],
    ["синхронный throw", () => { throw new Error("boom"); }],
    ["reject", () => Promise.reject(new Error("boom"))],
    ["reject не ошибкой", () => Promise.reject("boom")],
    ["чуть дольше лимита", async () => { await delay(MODEL_TIMEOUT_MS + 80); return JSON.stringify({ topic: "other", draft: "Ок" }); }],
    ["вечно висит и игнорирует signal", () => new Promise(() => {})],
  ];
  for (const [name, classify] of cases) {
    test(name, async () => {
      const app = await startServer({ classify });
      try {
        const { status, body } = await triage(app.url, "Вопрос по заказу");
        assert.equal(status, 200);
        assert.deepEqual(body, MANUAL);
      } finally {
        await app.close();
      }
    });
  }

  test("чуть быстрее лимита проходит, лишние поля не утекают, черновик обрезан", async () => {
    const app = await startServer({
      classify: async () => {
        await delay(MODEL_TIMEOUT_MS - 120);
        return JSON.stringify({ topic: "pricing", draft: "  Ок  ", confidence: 0.3, raw: "секрет" });
      },
    });
    try {
      assert.deepEqual((await triage(app.url, "Сколько?")).body, { status: "ready", topic: "pricing", draft: "Ок" });
    } finally {
      await app.close();
    }
  });

  test("по таймауту модель получает abort, в модель уходит обрезанный текст", async () => {
    let signal;
    let received;
    const app = await startServer({
      classify: (text, options) => { received = text; signal = options.signal; return new Promise(() => {}); },
    });
    try {
      await triage(app.url, "  Сколько?  ");
      assert.equal(received, "Сколько?");
      assert.equal(signal.aborted, true);
    } finally {
      await app.close();
    }
  });

  test("в лог пишется причина, но не текст заявки", async () => {
    const lines = [];
    const app = await startServer({ classify: () => "not json", log: (line) => lines.push(line) });
    try {
      await triage(app.url, "Иванов, телефон 123");
      assert.equal(lines.length, 1);
      assert.match(lines[0], /output_not_json/);
      assert.doesNotMatch(lines[0], /Иванов/);
    } finally {
      await app.close();
    }
  });
});
