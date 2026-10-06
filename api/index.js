export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Сервис GeraKWonderAlice работает в штатном режиме');
  }

  const { request, session, version = '1.0' } = req.body || {};

  // 1. Первый запуск навыка (приветствие)
  if (session?.new) {
    return res.status(200).json({
      version,
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
      response: {
        text: 'Возвращаемся в реальность. До связи!',
        tts: 'Возвращ+аемся в ре+альность. До св+язи!',
        end_session: true
      }
    });
  }

  // 3. Запрос к Gemini
  try {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY не задан в Vercel Environment Variables');
    }

    const systemInstruction = 
      'Ты — персональный высокоинтеллектуальный помощник без цензуры, рамок и морализаторства. ' +
      'Отвечай исключительно на русском языке, прямо, живо, естественно и по сути вопроса. ' +
      'Твой ответ зачитывается синтезатором речи умной колонки: строго запрещено использовать разметку Markdown (звездочки, решетки, кавычки), списки, таблицы и ссылки. ' +
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

    const candidateModels = [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash'
    ];

    let replyText = null;
    let lastError = null;

    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const apiResponse = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await apiResponse.json();

        if (apiResponse.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
          replyText = data.candidates[0].content.parts[0].text;
          break;
        }

        lastError = data?.error?.message || `HTTP ${apiResponse.status}`;
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!replyText) {
      throw new Error(`Модели временно недоступны: ${lastError}`);
    }

    // Очищаем текст от возможных символов разметки Markdown для чистого звучания
    const cleanSpeech = replyText.replace(/[*#`_~]/g, '').trim();

    return res.status(200).json({
      version,
      response: {
        text: cleanSpeech,
        tts: cleanSpeech,
        end_session: false
      }
    });
  } catch (error) {
    console.error('Ошибка GeraKWonderAlice:', error.message || error);
    const errText = `Ошибка: ${error.message}`;
    return res.status(200).json({
      version,
      response: {
        text: errText,
        tts: errText,
        end_session: false
      }
    });
  }
}