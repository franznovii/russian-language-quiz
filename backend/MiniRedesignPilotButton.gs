/**
 * «вы́Читать» — отправить владельцу кнопку НОВОГО дизайна Mini App.
 *
 * Добавляется ОТДЕЛЬНЫМ .gs файлом в действующий GAS проект
 * «Вычитать — Mini App». Не меняет webhook, меню, таблицу или D1.
 *
 * Используются существующие Script Properties:
 *   BOT_TOKEN — токен бота (никогда не вставлять в код!)
 *   TEST_CHAT_ID — Telegram ID личного чата владельца с ботом.
 *
 * ВАЖНО: эта функция не создаёт выпуск. Для нового прохождения
 * предварительно вручную выполнить cfActivateNewPilot().
 */
function cfSendRedesignPilotButton() {
  const props = PropertiesService.getScriptProperties();
  const botToken = String(props.getProperty("BOT_TOKEN") || "").trim();
  const chatId = String(props.getProperty("TEST_CHAT_ID") || "").trim();
  if (!botToken) throw new Error("В свойствах GAS отсутствует BOT_TOKEN");
  if (!/^[1-9][0-9]{4,19}$/.test(chatId)) {
    throw new Error("В свойствах GAS некорректный TEST_CHAT_ID: нужен числовой ID личного чата");
  }
  const webAppUrl =
    "https://franznovii.github.io/russian-language-quiz/pilot-cloudflare-redesign.html?pilot=design-20261012";
  const payload = {
    chat_id: chatId,
    text: "«вы́Читать» · Проверка НОВОГО дизайна. Только для администратора. 6 вопросов, реальные таймеры и сохранение ответов в Cloudflare.",
    reply_markup: {
      inline_keyboard: [[{
        text: "Проверить новый дизайн",
        web_app: {url: webAppUrl}
      }]]
    }
  };
  const response = UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + botToken + "/sendMessage", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error("Telegram вернул ответ не в формате JSON. HTTP " + response.getResponseCode()); }
  if (!result.ok) {
    throw new Error("Telegram не отправил тестовую кнопку. HTTP " + response.getResponseCode() +
      ", код " + String(result.error_code || "неизвестен") +
      ", сообщение: " + String(result.description || "нет описания"));
  }
  console.log("Готово: тестовая кнопка отправлена только в TEST_CHAT_ID.");
  return "Кнопка нового дизайна отправлена в личный чат владельца.";
}
