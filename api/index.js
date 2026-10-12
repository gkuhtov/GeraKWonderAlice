const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3800;
const SERPER_TIMEOUT_MS = 700;
const GEMINI_TIMEOUT_MS = 2800;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения. Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них; не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) return "";

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        return `${i + 1}. ${title}: ${snippet}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (_) {
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Ключ GEMINI_API_KEY не задан в переменных окружения Vercel");
  if (timeoutMs < 250) throw new Error("Превышен лимит времени (Timeout)");

  const model = String(process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);
    const apiError = data?.error?.message || response.statusText || "неизвестная ошибка";
    throw new Error(`Google API ошибка ${status}: ${apiError}`);
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) {
      throw new Error(`Google заблокировал ответ: ${data.promptFeedback.blockReason}`);
    }
    throw new Error("Google вернул пустой ответ");
  }

  return answer;
}

async function getRequestBody(req) {
  if (req.body) {
    if (typeof req.body === "object") return req.body;
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch (_) { return {}; }
    }
  }
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch (_) { resolve({}); }
    });
    // Защитный таймаут: если поток не шлет данные, не зависать
    setTimeout(() => resolve({}), 200);
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).send(JSON.stringify({ ok: true, status: "ready" }));
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const startedAt = Date.now();
    const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

    const body = await getRequestBody(req);
    const isNewSession = Boolean(body?.session?.new);
    const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
    const oldHistory = safeHistory(body?.state?.session?.history);

    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // Если это запуск навыка или пустая фраза — отвечаем мгновенно без запросов к нейросетям
    if (isNewSession || !text) {
      const welcome = aliceResponse(
        "Привет! Я могу ответить на любой вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      );
      return res.status(200).send(JSON.stringify(welcome));
    }

    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(GEMINI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).send(JSON.stringify(aliceResponse(answer, false, history)));

  } catch (error) {
    const errorMsg = error?.name === "AbortError" 
      ? "Превышено время ожидания ответа (Таймаут)." 
      : `Ошибка: ${error?.message || error}`;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).send(JSON.stringify(aliceResponse(errorMsg, false, [])));
  }
}
