const MODELS_TO_TRY = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-1.5-flash"];
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_MESSAGE_CHARS = 800;
const MAX_ALICE_TEXT = 1024;
const TOTAL_BUDGET_MS = 4200;

const SYSTEM_PROMPT = 
  "Ты — полезный голосовой помощник в Яндекс Алисе. Отвечай кратко, по-русски (1–3 предложения), без Markdown, списков и ссылок.";

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

async function quickSearchWeb(query, timeoutMs = 700) {
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
          temperature: 0.3,
          maxOutputTokens: 200
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
    if (remainingTime < 1000) break;

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

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, status: "ready" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startTime = Date.now();
  const timeLeft = () => TOTAL_BUDGET_MS - (Date.now() - startTime);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const isNew = Boolean(body?.session?.new);
    const command = String(body?.request?.command || body?.request?.original_utterance || "").trim();
    const oldHistory = safeHistory(body?.state?.session?.history);

    // Мгновенный ответ при первом запуске или пустом запросе
    if (isNew || !command) {
      return res.status(200).json(aliceResponse(
        "Привет! Я готова ответить на любой вопрос или найти информацию в сети. Что вас интересует?",
        false,
        oldHistory
      ));
    }

    let searchContext = "";
    const isSearch = /погод|курс|новост|найди|сколько|сегодня|сейчас|кто так|что так/i.test(command);
    if (isSearch && process.env.SERPER_API_KEY && timeLeft() > 2800) {
      searchContext = await quickSearchWeb(command, 700);
    }

    const answer = await askGemini(command, oldHistory, searchContext, Math.max(1500, timeLeft() - 300));

    const history = [
      ...oldHistory,
      { role: "user", text: command.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const msg = error?.name === "AbortError"
      ? `Таймаут (${elapsed}мс): сервер не успел обработать запрос.`
      : `Ошибка (${elapsed}мс): ${error?.message || error}`;
    return res.status(200).json(aliceResponse(msg, false, []));
  }
}
