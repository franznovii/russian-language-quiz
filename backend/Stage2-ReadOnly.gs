/**
 * вы́Читать — этап 2. ПРОВЕРКА ЧТЕНИЯ ВОПРОСОВ ИЗ GOOGLE SHEETS.
 *
 * Временный тестовый GAS Web App, не продакшен!
 * Использовать в НОВОМ проекте Apps Script, НЕ в действующем боте.
 * Действующие листы и история не изменяются.
 *
 * Требуется Script Property: QUIZ_SHEET_ID = ID таблицы.
 * Никаких токенов Telegram на этом этапе не требуется.
 *
 * Поддерживает:
 *   GET ?action=health&callback=xxx
 *   GET ?action=questions&callback=xxx
 *   GET ?action=status&nonce=...&callback=xxx
 *   POST {"action":"probe","nonce":"..."}
 *
 * В публичном ответе НЕТ правильных ответов и объяснений.
 */
const PREVIEW_CONFIG = Object.freeze({
  questionsSheet: 'Вопросы',
  expectedQuestions: 6,
  cachePrefix: 'quiz_transport_probe_',
  cacheTtlSeconds: 300
});

function doGet(e) {
  const p = (e && e.parameter) || {};
  const cb = String(p.callback || '');
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/.test(cb)) {
    return ContentService.createTextOutput('Invalid callback')
      .setMimeType(ContentService.MimeType.TEXT);
  }
  let result;
  try {
    switch (p.action) {
      case 'health':
        result = {ok: true, service: 'quiz-transport-probe', timestamp: new Date().toISOString()};
        break;
      case 'status': {
        const nonce = String(p.nonce || '');
        result = {
          ok: true,
          received: validProbeNonce_(nonce) &&
            CacheService.getScriptCache().get(PREVIEW_CONFIG.cachePrefix + nonce) === '1'
        };
        break;
      }
      case 'questions':
        result = {ok: true, questions: publicQuestions_()};
        break;
      default:
        result = {ok: false, error: 'Неизвестная команда'};
    }
  } catch (err) {
    // Не показываем публично spreadsheetId, внутреннюю ошибку или данные таблицы.
    console.error('Ошибка тестового API: ' + String(err));
    result = {ok: false, error: 'Не удалось загрузить вопросы. Проверь настройки GAS.'};
  }
  // JSONP применяем здесь только к публичным учебным материалам.
  // В будущем персональные ответы будем доставлять и проверять иначе.
  const json = JSON.stringify(result).replace(/</g, '\\u003c');
  return ContentService.createTextOutput(cb + '(' + json + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action !== 'probe' || !validProbeNonce_(body.nonce)) {
      throw new Error('Bad probe request');
    }
    CacheService.getScriptCache().put(
      PREVIEW_CONFIG.cachePrefix + body.nonce,
      '1', PREVIEW_CONFIG.cacheTtlSeconds
    );
    return ContentService.createTextOutput('accepted');
  } catch (_) {
    return ContentService.createTextOutput('invalid');
  }
}

function validProbeNonce_(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,64}$/.test(value);
}

function publicQuestions_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('QUIZ_SHEET_ID');
  if (!sheetId) throw new Error('Отсутствует Script Property QUIZ_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName(PREVIEW_CONFIG.questionsSheet);
  if (!sheet) throw new Error('Не найден лист Вопросы');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('На листе Вопросы нет данных');

  // Загружаем все 10 колонок, но возвращаем только безопасные поля.
  // A номер, B время, C вопрос, D:G варианты, H ключ, I объяснение, J описание.
  const rows = sheet.getRange(2, 1, lastRow - 1, 10).getDisplayValues();
  const questions = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!String(r[0]).trim()) continue;
    const id = Number(r[0]);
    const options = r.slice(3, 7).map(String);
    while (options.length && !options[options.length - 1]) options.pop();
    const correctKeys = String(r[7] || '').trim().split(/[,;\s]+/).filter(Boolean).map(Number);
    if (!Number.isInteger(id) || id < 1 || id > PREVIEW_CONFIG.expectedQuestions ||
        !String(r[2]).trim() || options.length < 2 ||
        options.some(s => !s.trim()) || correctKeys.length === 0 ||
        new Set(correctKeys).size !== correctKeys.length ||
        correctKeys.some(n => !Number.isInteger(n) || n < 1 || n > options.length)) {
      throw new Error('Некорректная строка Вопросов: ' + (i + 2));
    }
    questions.push({
      id: id,
      question: String(r[2]),
      description: String(r[9] || ''),
      options: options,
      multiple: correctKeys.length > 1
    });
  }
  if (questions.length !== PREVIEW_CONFIG.expectedQuestions ||
      new Set(questions.map(q => q.id)).size !== PREVIEW_CONFIG.expectedQuestions) {
    throw new Error('Ожидаются ровно шесть вопросов с уникальными номерами');
  }
  return questions.sort((a, b) => a.id - b.id);
}
