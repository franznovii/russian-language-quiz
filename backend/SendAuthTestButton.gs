/**
 * Одноразовая личная кнопка для тестирования Mini App.
 *
 * ДОБАВЬ В КОНЕЦ `Код.gs` НОВОГО GAS-проекта.
 * Не заменяй основной код Stage4-TelegramAuth.gs!
 *
 * Script Properties:
 *   BOT_TOKEN    = токен действующего бота (уже указан в новом GAS)
 *   TEST_CHAT_ID = твой цифровой Telegram user ID
 *
 * Никаких изменений в BotFather, webhook, getUpdates или старом боте.
 * При запуске вручную отправляет одно сообщение только в TEST_CHAT_ID.
 */
function sendAuthTestButton() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('BOT_TOKEN');
  const chatId = String(props.getProperty('TEST_CHAT_ID') || '').trim();
  if (!token) throw new Error('В свойствах скрипта не указан BOT_TOKEN.');
  if (!/^[1-9][0-9]{3,15}$/.test(chatId)) {
    throw new Error('Добавь свой цифровой Telegram ID в Script Properties как TEST_CHAT_ID.');
  }
  const testPageUrl = 'https://quiz.libera.me/telegram-auth-test.html';
  const payload = {
    chat_id: chatId,
    text: 'Тест Mini App «вы́Читать». Эта кнопка только для проверки личности в Telegram. Ответы не записываются.',
    reply_markup: {inline_keyboard: [[{
      text: 'Открыть проверку Mini App',
      web_app: {url: testPageUrl}
    }]]}
  };
  let response;
  try {
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' +
      token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (_) {
    throw new Error('Не удалось связаться с Telegram. Сообщение могло быть отправлено — проверь свой чат.');
  }
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error('Telegram вернул неожиданный ответ. Проверь свой чат.'); }
  if (!result.ok) {
    // Не записываем ни токен, ни Telegram ID, ни тело API-ответа в логи.
    throw new Error('Telegram не принял запрос: HTTP ' + response.getResponseCode() +
      ' (Bot API ' + (Number(result.error_code) || 'unknown') + '). ' +
      'Проверь, что ранее нажал /start у нужного бота и указал свой TEST_CHAT_ID.');
  }
  console.log('Готово: тестовая кнопка отправлена в указанный личный чат.');
}
