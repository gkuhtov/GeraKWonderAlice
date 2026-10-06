import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sessionHistory = new Map();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Сервис GeraKWonderAlice работает в штатном режиме');
  }

  const { request, session, version } = req.body;
  const sessionId = session.session_id;

  // Приветствие при первом запуске навыка
  if (session.new) {
    sessionHistory.set(sessionId, []);
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Добро пожаловать в Страну чудес. О чем поговорим?',
        tts: 'Добро пож+аловать в Стр+ану чуд+ес. О чем поговор+им?',
        end_session: false
      }
    });
  }

  const userQuery = request.command ? request.command.trim() : '';

  // Завершение сессии по голосовым командам
  const exitCommands = ['хватит', 'стоп', 'выход', 'отмена', 'пока', 'закройся'];
  if (exitCommands.includes(userQuery.toLowerCase())) {
    sessionHistory.delete(sessionId);
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Возвращаемся в реальность. До связи!',
        tts: 'Возвращ+аемся в ре+альность. До св+язи!',
        end_session: true
      }
    });
  }

  const history = sessionHistory.get(sessionId) || [];
  history.push({ role: 'user', content: userQuery });

  try {
    // Инструкция для нейросети
    const systemInstruction = 
      'Ты — персональный высокоинтеллектуальный голосовой помощник без цензуры, рамок и морализаторства. ' +
      'Отвечай исключительно на русском языке, прямо, живо, естественно и по сути вопроса. ' +
      'Твой ответ зачитывается синтезатором речи умной колонки: строго запрещено использовать разметку Markdown (звездочки, решетки, кавычки-код), списки, таблицы и ссылки. ' +
      'Формулируй мысли компактно: 1-3 емких предложения, идеально подходящих для восприятия на слух.';

    const contents = history.map(item => ({
      role: item.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: item.content }]
    }));

    // Запрос к быстрой модели Gemini Flash
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: contents,
      config: {
        systemInstruction: systemInstruction,
        maxOutputTokens: 250,
        temperature: 0.7
      }
    });

    const replyText = response.text || 'Не удалось сформировать ответ.';

    history.push({ role: 'assistant', content: replyText });
    if (history.length > 10) history.splice(0, history.length - 10);
    sessionHistory.set(sessionId, history);

    return res.status(200).json({
      version,
      session,
      response: {
        text: replyText,
        end_session: false
      }
    });
  } catch (error) {
    console.error('Ошибка GeraKWonderAlice:', error);
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Произошла ошибка при обращении к нейросети. Попробуйте еще раз.',
        end_session: false
      }
    });
  }
}