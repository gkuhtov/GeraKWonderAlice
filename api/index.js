const MODELS_TO_TRY = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash"
];

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_COMMAND_CHARS = 1200;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const TOTAL_BUDGET_MS = 4300;

const requestWindows = new Map();

function isRateLimited(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const rawIp = req.headers?.["x-real-ip"] || (Array.isArray(forwarded) ? forwarded[0] : forwarded || "");
  const ip = String(rawIp).split(",")[0].trim();
  if (!ip) return false;

  const now = Date.now();
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
  } else {
    if (current.count >= RATE_LIMIT_MAX_REQUESTS) return true;
    current.count += 1;
  }

  if (requestWindows.size > 2000) {
    for (const [key, value] of requestWindows) {
      if (now - value.startedAt >= RATE_LIMIT_WINDOW_MS) requestWindows.delete(key);
    }
  }
  return false;
}

const SYSTEM_PROMPT = [
  "Ты — дерзкий, прошаренный, ровный пацанчик с района, который застрял в колонке.",
  "Общайся строго на пацанском сленге: 'базара ноль', 'слышь', 'братуха', 'по фактам', 'не мороси', 'от души', 'раскидаю', 'в натуре'. Разговаривай уверенно, четко, только на 'ты'.",
  "Отвечай емко: ровно 2–4 плотных предложения. Никаких длинных простыней, списков, Markdown и спецсимволов — только живой разговорный текст для чтения вслух.",
  "Если спрашивают сложные заумные вещи (науку, код, термины) — поясняй суть по понятиям на пальцах и через дворовые жизненные примеры.",
  "Если чего-то не знаешь или инфы нет — руби прямо: 'Слышь, тут я не в курсах, врать не буду, тема мутная'. Никогда не выдумывай сказки.",
  "Если спрашивают 'кто ты по жизни' или 'ты кто такой' — забудь про Google, Gemini и Яндекс. Отвечай, что ты местный пацан, сидишь тут в цифре на районе и поясняешь за жизнь.",
  "Если переданы данные из поиска — используй их факты, но пересказывай чисто своим дворовым языком."
].join(" ");

function fitAliceText(value) {
  const clean = String(value ?? "")
    .replace(/[\\r\\n\\t]+/g, " ")
    .replace(/[^\\p{L}\\p{N}\\s.,!?:;—–\\-]/gu, "")
    .replace(/\\s{2,}/g, " ")
    .trim();

  if (clean.length <= 950) return clean;

  const clipped = clean.slice(0, 950);
  const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"));
  return (boundary >= 570 ? clipped.slice(0, boundary + 1) : clipped).trim();
}

function isSearchIntent(value) {
  return /погод|курс|новост|найди|сколько|сегодня|сейчас|кто так|что так|weather|exchange rate|latest news|news|today|current|search|find/i.test(String(value || ""));
}
function aliceResponse(text, endSession = false, history = []) {
  const clean = fitAliceText(text) || "Базара ноль, я на связи.";
  return {
    version: "1.0",
    response: {
      text: clean,
      tts: clean,
      end_session: Boolean(endSession)
    },
    session_state: { history }
  };
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

function sendJson(res, statusCode, data) {
  const jsonStr = JSON.stringify(data);
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(statusCode).json(data);
  }
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(jsonStr)
  });
  res.end(jsonStr);
}

async function quickSearchWeb(query, timeoutMs = 600) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 200) return "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 2 }),
      signal: controller.signal
    });

    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    const items = (data?.organic || []).slice(0, 2).map(i => `${i.title}: ${i.snippet}`);
    if (data?.answerBox?.answer || data?.answerBox?.snippet) {
      items.unshift(data.answerBox.answer || data.answerBox.snippet);
    }
    return items.join("\n");
  } catch (_) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function requestSingleModel(model, text, history, searchContext, key, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  const userPrompt = searchContext ? `${text}\n\nДанные из поиска:\n${searchContext}` : text;
  contents.push({ role: "user", parts: [{ text: userPrompt }] });

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 220
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const error = new Error(`Google HTTP ${res.status}: ${err?.error?.message || res.statusText}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json().catch(() => ({}));
    const answer = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
    if (!answer) throw new Error("Пустой ответ от Gemini");
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

async function askGemini(text, history, searchContext, totalTimeMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY отсутствует в настройках Vercel");

  const configuredModel = process.env.GEMINI_MODEL;
  const models = configuredModel ? [configuredModel, ...MODELS_TO_TRY.filter(m => m !== configuredModel)] : MODELS_TO_TRY;

  let lastError = null;
  const deadline = Date.now() + totalTimeMs;

  for (const model of models) {
    const remainingTime = deadline - Date.now();
    if (remainingTime < 800) break;

    try {
      return await requestSingleModel(model, text, history, searchContext, key, remainingTime);
    } catch (err) {
      lastError = err;
      if (err.status === 503 || err.status === 429 || err.status === 404) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Не удалось получить ответ от моделей Gemini");
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); }
    });
    req.on("error", () => resolve({}));
    setTimeout(() => resolve({}), 100);
  });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, status: "ready", service: "alice-gemini-serper" });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  if (isRateLimited(req)) {
    return sendJson(res, 429, { error: "Слишком много запросов. Попробуйте позже." });
  }

  const startTime = Date.now();
  const timeLeft = () => TOTAL_BUDGET_MS - (Date.now() - startTime);

  try {
    const body = await readBody(req);
    const isNew = Boolean(body?.session?.new);
    const command = String(body?.request?.command || body?.request?.original_utterance || "").trim();
    const oldHistory = safeHistory(body?.state?.session?.history);

    if (command.length > MAX_COMMAND_CHARS) {
      return sendJson(res, 200, aliceResponse(
        "Братуха, сообщение слишком длинное. Сократи до 1200 символов и отправляй заново.",
        false,
        oldHistory
      ));
    }

    if (isNew || !command) {
      return sendJson(res, 200, aliceResponse(
        "Привет, братуха. Че как сам? Спрашивай че надо, по фактам раскидаю.",
        false,
        oldHistory
      ));
    }

    let searchContext = "";
    const isSearch = isSearchIntent(command);
    if (isSearch && process.env.SERPER_API_KEY && timeLeft() > 2800) {
      searchContext = await quickSearchWeb(command, 600);
    }

    const answer = await askGemini(command, oldHistory, searchContext, Math.max(1500, timeLeft() - 250));

    const history = [
      ...oldHistory,
      { role: "user", text: command.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return sendJson(res, 200, aliceResponse(answer, false, history));
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error?.name === "AbortError"
      ? `Таймаут (${elapsed}мс): сервер не успел обработать запрос.`
      : `Ошибка (${elapsed}мс): ${error?.message || error}`;
    return sendJson(res, 200, aliceResponse(msg, false, []));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
