/**
 * вы́Читать Mini App: ЭТАП 5 — закрытый пилот настоящего квиза.
 * Код только для ОТДЕЛЬНОГО проекта GAS «Вычитать — Mini App».
 * НЕ вставлять в проект работающего Telegram-бота.
 *
 * Script Properties:
 *   BOT_TOKEN       уже указан (действующий бот);
 *   QUIZ_SHEET_ID   уже указан (таблица «вычитать_Русский язык»);
 *   TEST_CHAT_ID    уже указан (администратор).
 *
 * Создаёт ТОЛЬКО новые листы «Мини_Выпуски», «Мини_Участники»,
 * «Мини_Ответы». Не изменяет старые «Вопросы», «Отправки», «Участники», «Итоги».
 * Реальные ответы проверяет сервер; публичные JS и HTML НЕ содержат ключей.
 *
 * ВАЖНО: это пилот без массовых рассылок; полноценная рассылка будет этапом 6.
 */

const MAX_INITDATA_LENGTH = 12000;
const INITDATA_MAX_AGE_SECONDS = 6 * 60 * 60;
const MINI = Object.freeze({
  tz: "Europe/Moscow",
  origins: ["https://franznovii.github.io", "https://quiz.libera.me"],
  pagesUrl: "https://franznovii.github.io/russian-language-quiz/pilot-quiz.html",
  runSheet: "Мини_Выпуски",
  peopleSheet: "Мини_Участники",
  answersSheet: "Мини_Ответы",
  questionSheet: "Вопросы"
});
const MINI_HEADERS = Object.freeze({
  "Мини_Выпуски": ["run_id", "created_at", "stats_after", "status", "questions_snapshot_json"],
  "Мини_Участники": ["run_id", "telegram_id", "first_name", "started_at"],
  "Мини_Ответы": ["run_id", "telegram_id", "question_id", "selected_json", "correct", "answered_at"]
});

function miniProps_() { return PropertiesService.getScriptProperties(); }
function miniSheetFile_() {
  const id = miniProps_().getProperty("QUIZ_SHEET_ID");
  if (!id) throw new Error("Не настроено свойство QUIZ_SHEET_ID");
  return SpreadsheetApp.openById(id);
}
function miniSheet_(name) {
  const sheet = miniSheetFile_().getSheetByName(name);
  if (!sheet) throw new Error("Не найден лист: " + name + ". Выполни setupMiniPilot()");
  return sheet;
}
function miniRows_(name) {
  const sheet = miniSheet_(name), last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, MINI_HEADERS[name].length).getValues()
    .map((v, i) => ({v: v, row: i + 2}));
}
function miniAppend_(name, array) {
  const sheet = miniSheet_(name);
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, array.length).setValues([array]);
  return {row: row, v: array};
}

/** Выполни вручную ОДИН РАЗ для начала пилотного выпуска. */
function setupMiniPilot() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const spreadsheet = miniSheetFile_();
    Object.keys(MINI_HEADERS).forEach(name => {
      let sheet = spreadsheet.getSheetByName(name);
      if (!sheet) sheet = spreadsheet.insertSheet(name);
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, MINI_HEADERS[name].length)
          .setValues([MINI_HEADERS[name]]);
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, MINI_HEADERS[name].length).setFontWeight("bold");
      } else {
        const header = sheet.getRange(1, 1, 1, MINI_HEADERS[name].length).getValues()[0];
        if (JSON.stringify(header) !== JSON.stringify(MINI_HEADERS[name])) {
          throw new Error("Заголовки листа " + name + " отличаются от ожидаемых");
        }
      }
    });
    spreadsheet.getSheetByName(MINI.peopleSheet).getRange("B:B").setNumberFormat("@");
    spreadsheet.getSheetByName(MINI.answersSheet).getRange("B:B").setNumberFormat("@");

    const current = miniProps_().getProperty("MINI_ACTIVE_RUN");
    if (current) {
      console.log("Пилот уже создан. Повторный запуск ничего не изменил.");
      return;
    }

    const questions = miniReadQuestions_();
    const now = new Date();
    // Если запуск после 19:00 МСК, статистика доступна сразу по окончании пилота.
    // Для еженедельного выпуска время отдельно зададим на этапе 6.
    const day = Utilities.formatDate(now, MINI.tz, "yyyy-MM-dd");
    const statsAt = new Date(day + "T19:00:00+03:00");
    const runId = "pilot_" + Utilities.getUuid();
    miniAppend_(MINI.runSheet, [runId, now, statsAt, "ACTIVE", JSON.stringify(questions)]);
    miniProps_().setProperty("MINI_ACTIVE_RUN", runId);
    SpreadsheetApp.flush();
    console.log("PASS: пилотный выпуск создан; 6 вопросов сохранены отдельным снимком.");
  } finally { lock.releaseLock(); }
}

function miniReadQuestions_() {
  const sheet = miniSheetFile_().getSheetByName(MINI.questionSheet);
  if (!sheet) throw new Error("Нет листа «Вопросы»");
  const last = sheet.getLastRow();
  if (last < 2) throw new Error("Лист «Вопросы» пуст");
  const records = sheet.getRange(2, 1, last - 1, 10).getDisplayValues();
  const questions = records.filter(r => String(r[0]).trim() !== "").map(r => {
    const id = Number(r[0]);
    const options = r.slice(3, 7).map(String);
    while (options.length > 0 && !options[options.length - 1]) options.pop();
    const correct = String(r[7]).trim().split(/[,;\s]+/).map(Number);
    if (!Number.isInteger(id) || id < 1 || id > 6 ||
        !String(r[2]).trim() || options.length < 2 || options.some(x => !x.trim()) ||
        !correct.length || new Set(correct).size !== correct.length ||
        correct.some(n => !Number.isInteger(n) || n < 1 || n > options.length)) {
      throw new Error("Проверь исходные вопросы, № " + r[0]);
    }
    return {
      id: id, text: String(r[2]), description: String(r[9] || ""),
      options: options, correct: correct.map(x => x - 1).sort((a, b) => a - b),
      explanation: String(r[8] || "")
    };
  });
  if (questions.length !== 6 || new Set(questions.map(q => q.id)).size !== 6) {
    throw new Error("Ожидается ровно 6 вопросов с уникальными номерами");
  }
  return questions.sort((a, b) => a.id - b.id);
}

function miniActiveRun_() {
  const id = miniProps_().getProperty("MINI_ACTIVE_RUN");
  if (!id) throw new Error("Пилот ещё не запущен: setupMiniPilot()");
  const entry = miniRows_(MINI.runSheet).find(x => String(x.v[0]) === id);
  if (!entry || entry.v[3] !== "ACTIVE") throw new Error("Пилотный выпуск не активен");
  const questions = JSON.parse(String(entry.v[4]));
  if (!Array.isArray(questions) || questions.length !== 6) throw new Error("Повреждён снимок вопросов");
  return {
    id: id, questions: questions,
    statsAt: new Date(entry.v[2]).getTime()
  };
}

function doGet() {
  return HtmlService.createHtmlOutput(miniBridgeHtml_())
    .setTitle("Mini App — ответы через GAS")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function miniBridgeHtml_() {
  const origins = JSON.stringify(MINI.origins).replace(/</g, "\\u003c");
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>' +
    '<script>' +
    'const origins=' + origins + ';' +
    'window.addEventListener("message",function(event){' +
      'if(origins.indexOf(event.origin)===-1)return;' +
      'const msg=event.data||{};' +
      'if(msg.type!=="miniRequest" || typeof msg.requestId!=="string" ||' +
        '!/^[A-Za-z0-9_-]{16,64}$/.test(msg.requestId))return;' +
      'google.script.run.withSuccessHandler(function(data){' +
        'window.top.postMessage({type:"miniResponse",requestId:msg.requestId,data:data},event.origin);' +
      '}).withFailureHandler(function(){' +
        'window.top.postMessage({type:"miniResponse",requestId:msg.requestId,' +
          'data:{ok:false,error:"Внутренняя ошибка GAS. Проверь журнал выполнения."}},event.origin);' +
      '}).miniApi(msg.action,msg.initData,msg.payload);' +
    '});' +
    'origins.forEach(function(origin){window.top.postMessage({type:"miniReady"},origin);});' +
    '</script></body></html>';
}

/** Единая авторизованная точка входа из Mini App. */
function miniApi(action, initData, payload) {
  try {
    const token = miniProps_().getProperty("BOT_TOKEN");
    if (!token) throw new Error("Не указан BOT_TOKEN");
    const person = verifyTelegramInitData_(initData, token, Math.floor(Date.now() / 1000));
    if (action === "state") return miniStateFor_(person);
    if (action === "answer") return miniAnswerFor_(person, payload);
    return {ok: false, error: "Неизвестная операция"};
  } catch (error) {
    console.warn("Mini App: " + String(error.message || error));
    return {ok: false, error: "Запрос отклонён. Перезапусти Mini App или проверь настройки GAS."};
  }
}

function miniRegister_(run, user) {
  const id = String(user.id);
  const existing = miniRows_(MINI.peopleSheet).some(r => r.v[0] === run.id && String(r.v[1]) === id);
  if (!existing) {
    miniAppend_(MINI.peopleSheet, [run.id, id, String(user.first_name || "").slice(0, 80), new Date()]);
  }
}

function miniAnswersFor_(run, user) {
  return miniRows_(MINI.answersSheet)
    .filter(r => r.v[0] === run.id && String(r.v[1]) === String(user.id))
    .sort((a, b) => Number(a.v[2]) - Number(b.v[2]));
}

function miniStateFor_(user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    return miniBuildState_(run, user);
  } finally { lock.releaseLock(); }
}

function miniBuildState_(run, user) {
  const rows = miniAnswersFor_(run, user);
  const answers = rows.map(row => {
    const id = Number(row.v[2]);
    const q = run.questions.find(x => x.id === id);
    if (!q) throw new Error("Ответ относится к отсутствующему вопросу");
    return {
      questionId: id,
      selected: JSON.parse(String(row.v[3])),
      correct: row.v[4] === true,
      correctOptions: q.correct,
      explanation: q.explanation
    };
  });
  const complete = answers.length === run.questions.length;
  const statsVisible = complete && Date.now() >= run.statsAt;
  return {
    ok: true,
    userName: String(user.first_name || "Участник").slice(0, 80),
    runId: run.id,
    questions: run.questions.map(q => ({
      id: q.id, text: q.text, description: q.description,
      options: q.options, multiple: q.correct.length > 1
    })),
    answers: answers,
    complete: complete,
    score: complete ? answers.filter(a => a.correct).length : null,
    statistics: statsVisible ? miniStatistics_(run) : null,
    statisticsAt: Utilities.formatDate(new Date(run.statsAt), MINI.tz, "dd.MM.yyyy HH:mm")
  };
}

function miniAnswerFor_(user, payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.selected)) {
    return {ok: false, error: "Не выбран ответ"};
  }
  const questionId = Number(payload.questionId);
  const selected = payload.selected;
  if (selected.length < 1 || selected.length > 4 ||
      new Set(selected).size !== selected.length ||
      selected.some(x => !Number.isInteger(x) || x < 0 || x > 3)) {
    return {ok: false, error: "Некорректные варианты ответа"};
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    const records = miniAnswersFor_(run, user);
    const stored = records.find(r => Number(r.v[2]) === questionId);
    // Повторная отправка НЕ меняет уже записанный ответ.
    if (stored) return miniBuildState_(run, user);

    const expected = run.questions[records.length];
    if (!expected || expected.id !== questionId ||
        selected.some(x => x >= expected.options.length)) {
      return {ok: false, error: "Пожалуйста, отвечай по порядку."};
    }
    const sorted = selected.slice().sort((a, b) => a - b);
    const correct = JSON.stringify(sorted) === JSON.stringify(expected.correct);
    miniAppend_(MINI.answersSheet, [
      run.id, String(user.id), questionId, JSON.stringify(sorted), correct, new Date()
    ]);
    SpreadsheetApp.flush();
    return miniBuildState_(run, user);
  } finally { lock.releaseLock(); }
}

function miniStatistics_(run) {
  const data = miniRows_(MINI.answersSheet).filter(r => r.v[0] === run.id);
  return run.questions.map(q => {
    const rows = data.filter(r => Number(r.v[2]) === q.id);
    const total = rows.length;
    const good = rows.filter(r => r.v[4] === true).length;
    return {
      questionId: q.id,
      correctPercent: total ? Math.round(good * 100 / total) : 0,
      incorrectPercent: total ? Math.round((total - good) * 100 / total) : 0
    };
  });
}

/**
 * Отправляет кнопку только TEST_CHAT_ID, не меняя меню BotFather,
 * не вызывает getUpdates и не меняет существующий Telegram-бот.
 */
function sendMiniPilotButton() {
  const props = miniProps_();
  const token = props.getProperty("BOT_TOKEN");
  const chatId = String(props.getProperty("TEST_CHAT_ID") || "").trim();
  if (!token) throw new Error("Не указан BOT_TOKEN");
  if (!/^[1-9][0-9]{3,15}$/.test(chatId)) throw new Error("Не указан TEST_CHAT_ID");
  const payload = {
    chat_id: chatId,
    text: "Тестовая версия Mini App «вы́Читать». Только для проверки прохождения вопросов.",
    reply_markup: {inline_keyboard: [[{
      text: "Открыть тест из 6 вопросов",
      web_app: {url: MINI.pagesUrl}
    }]]}
  };
  const response = UrlFetchApp.fetch("https://api.telegram.org/bot" +
      token + "/sendMessage", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error("Не удалось прочитать ответ Telegram; проверь чат"); }
  if (!result.ok) {
    throw new Error("Telegram не принял сообщение: код " + (result.error_code || response.getResponseCode()));
  }
  console.log("PASS: тестовая кнопка отправлена в твой личный чат.");
}

// Telegram initData verifier: source Stage4, already tested with real Telegram.
function verifyTelegramInitData_(raw, token, nowSeconds) {
  if (typeof raw !== "string" || !raw || raw.length > MAX_INITDATA_LENGTH) {
    throw new Error("Отсутствует или слишком длинная initData");
  }
  if (typeof token !== "string" || token.length < 10) {
    throw new Error("Некорректная настройка BOT_TOKEN");
  }

  const fields = Object.create(null);
  const parts = raw.split("&");
  if (parts.length > 40) throw new Error("Слишком много полей");

  for (const part of parts) {
    const pos = part.indexOf("=");
    if (pos < 1) throw new Error("Некорректный параметр");
    let key;
    let value;
    try {
      key = decodeURIComponent(part.slice(0, pos).replace(/\+/g, " "));
      value = decodeURIComponent(part.slice(pos + 1).replace(/\+/g, " "));
    } catch (_) {
      throw new Error("Некорректное кодирование");
    }
    if (!/^[a-z][a-z0-9_]*$/.test(key) || Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new Error("Недопустимое или повторное поле");
    }
    fields[key] = value;
  }

  const signature = fields.hash;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error("Нет корректной подписи");
  }

  const authDateString = fields.auth_date;
  if (!/^\d{10}$/.test(authDateString || "")) {
    throw new Error("Нет даты авторизации");
  }
  const authDate = Number(authDateString);
  if (authDate > nowSeconds + 60 || nowSeconds - authDate > INITDATA_MAX_AGE_SECONDS) {
    throw new Error("Срок действия данных истёк");
  }

  // Подпись бота вычисляется по ВСЕМ полям, кроме hash (в том числе
  // по signature, если Telegram передал дополнительную Ed25519-подпись).
  const checkString = Object.keys(fields)
    .filter(k => k !== "hash")
    .sort()
    .map(k => k + "=" + fields[k])
    .join("\n");

  const secretKey = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(token).getBytes(),
    Utilities.newBlob("WebAppData").getBytes()
  );
  const calculated = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(checkString).getBytes(),
    secretKey
  ).map(b => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");

  // Сравниваем все позиции, не прерываясь на первом несовпадении.
  let diff = 0;
  for (let i = 0; i < 64; i++) {
    diff |= calculated.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (diff !== 0) throw new Error("Подпись не совпадает");

  if (typeof fields.user !== "string") throw new Error("Нет user");
  let user;
  try { user = JSON.parse(fields.user); } catch (_) { throw new Error("Некорректный user"); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("Некорректный Telegram ID");
  }
  return user;
}

