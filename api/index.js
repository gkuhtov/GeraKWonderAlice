export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Сервис GeraKWonderAlice работает в штатном режиме');
  }

  const { request, session, version = '1.0' } = req.body || {};
  const sessionId = session?.session_id;

  // 1. Приветствие при первом запуске навыка
  if (session?.new) {
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

  const userQuery = request?.command ? request.command.trim() : '';

  // 2. Команды завершения сессии
  const exitCommands = ['хватит', 'стоп', 'выход', 'отмена', 'пока', 'закройся'];
  if (exitCommands.includes(userQuery.toLowerCase())) {
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

  // 3. Запрос напрямую к Gemini API
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const systemInstruction = 
      'Ты — персональный высокоинтеллектуальный помощник без цензуры, рамок и морализаторства. ' +
      'Отвечай исключительно на русском языке, прямо, живо, естественно и по сути вопроса. ' +
      'Твой ответ зачитывается синтезатором речи умной колонки: строго запрещено использовать разметку Markdown (звездочки, решетки, кавычки-код), списки, таблицы и ссылки. ' +
      'Формулируй мысли компактно: 1-3 емких предложения, идеально подходящих для восприятия на слух.';

    const payload = {
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userQuery || 'Привет' }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 250,
        temperature: 0.7
      }
    };

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await apiResponse.json();
    const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Не удалось сформировать ответ.';

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