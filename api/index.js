const MODELS_TO_TRY = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash"
];

const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_ALICE_TEXT = 1024;
const TOTAL_BUDGET_MS = 4400;

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
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";
  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("! "), candidate.lastIndexOf("? "));
  if (sentenceEnd >= 200) return candidate.slice(0, sentenceEnd + 1).trim();
  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 150 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
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
    return sendJson(res, 200, { ok: true, status: "ready" });
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const startTime = Date.now();
  const timeLeft = () => TOTAL_BUDGET_MS - (Date.now() - startTime);

  try {
    const body = await readBody(req);
    const isNew = Boolean(body?.session?.new);
    const command = String(body?.request?.command || body?.request?.original_utterance || "").trim();
    const oldHistory = safeHistory(body?.state?.session?.history);

    if (isNew || !command) {
      return sendJson(res, 200, aliceResponse(
        "Здорово, братуха. Че как сам? Спрашивай че надо, по фактам раскидаю.",
        false,
        oldHistory
      ));
    }

    let searchContext = "";
    const isSearch = /погод|курс|новост|найди|сколько|сегодня|сейчас|кто так|что так/i.test(command);
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
