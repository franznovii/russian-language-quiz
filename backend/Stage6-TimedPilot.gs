/**
 * вы́Читать Mini App: RELEASE CANDIDATE — общий выпуск из шести вопросов.
 * Код только для ОТДЕЛЬНОГО проекта GAS «Вычитать — Mini App».
 * НЕ вставлять в проект работающего Telegram-бота.
 *
 * Script Properties:
 *   BOT_TOKEN       уже указан (действующий бот);
 *   QUIZ_SHEET_ID   уже указан (таблица «вычитать_Русский язык»);
 *   TEST_CHAT_ID    уже указан (администратор);
 *   MINI_WEBAPP_URL адрес GAS /exec (для кнопки в Telegram);
 *   MINI_ACCESS_MODE pilot (по умолчанию) / public (после проверки).
 *
 * Читает вопросы из «Мини_Вопросы» (A–Q), записи хранит в «Мини_Выпуски»,
 * «Мини_Участники», «Мини_Ответы», «Мини_Таймеры».
 * Старые листы «Вопросы», «Отправки», «Участники», «Итоги» не меняет.
 * Реальные ответы проверяет сервер; публичные JS и HTML НЕ содержат ключей.
 *
 * Мини-приложение может работать в режимах pilot (по умолчанию) и public.
 * Вечерних рассылок нет: после 19:00 МСК статистика видна только
 * завершившим тест подписчикам канала вы́Читать; проверка членства
 * проводится на сервере через Telegram getChatMember.
 */

const MAX_INITDATA_LENGTH = 12000;
const INITDATA_MAX_AGE_SECONDS = 6 * 60 * 60;
const MINI = Object.freeze({
  tz: "Europe/Moscow",
  origins: ["https://franznovii.github.io", "https://quiz.libera.me"],
  pagesUrl: "https://franznovii.github.io/russian-language-quiz/pilot-timed.html",
  runSheet: "Мини_Выпуски",
  peopleSheet: "Мини_Участники",
  answersSheet: "Мини_Ответы",
  timersSheet: "Мини_Таймеры",
  questionSheet: "Мини_Вопросы",
  channelUsername: "@posttsop",
  channelUrl: "https://t.me/posttsop"
});
const MINI_QUESTION_HEADERS = Object.freeze([
  "№", "Когда отправить (МСК)", "Описание", "Вопрос",
  "Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4", "Вариант 5",
  "Вариант 6", "Вариант 7", "Вариант 8", "Вариант 9", "Вариант 10",
  "Правильные", "Объяснение", "Время на ответ (сек.)"
]);
const MINI_HEADERS = Object.freeze({
  "Мини_Выпуски": ["run_id", "created_at", "stats_after", "status", "questions_snapshot_json"],
  "Мини_Участники": ["run_id", "telegram_id", "first_name", "started_at"],
  "Мини_Ответы": ["run_id", "telegram_id", "question_id", "selected_json", "correct", "answered_at"],
  "Мини_Таймеры": ["run_id", "telegram_id", "question_id", "started_at", "deadline_at"]
});

function miniProps_() { return PropertiesService.getScriptProperties(); }
function miniSheetFile_() {
  const id = miniProps_().getProperty("QUIZ_SHEET_ID");
  if (!id) throw new Error("Не настроено свойство QUIZ_SHEET_ID");
  return SpreadsheetApp.openById(id);
}
function miniSheet_(name) {
  const sheet = miniSheetFile_().getSheetByName(name);
  if (!sheet) throw new Error("Не найден лист: " + name + ". Выполни setupMiniTimedPilot()");
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

/**
 * Эти функции изменяют административные настройки.
 * Защищаем от вызова публичным HtmlService-клиентом.
 * В редакторе GAS владелец имеет активный и эффективный аккаунт,
 * у обычного публичного посетителя Web App active email отсутствует.
 */
function miniRequireOwnerRun_() {
  const active = Session.getActiveUser().getEmail();
  const owner = Session.getEffectiveUser().getEmail();
  if (!active || !owner || active !== owner) {
    throw new Error("Эту операцию может выполнить только владелец в редакторе GAS.");
  }
}

/**
 * Проверяет структуру отдельного листа «Мини_Вопросы» A–Q.
 * Старые ответы и исходный лист «Вопросы» не затрагиваются.
 */
function miniCheckQuestionHeaders_() {
  const questionSheet = miniSheetFile_().getSheetByName(MINI.questionSheet);
  if (!questionSheet) throw new Error("Нет листа «Мини_Вопросы». Не редактируй старый лист «Вопросы».");
  const current = questionSheet.getRange(1, 1, 1, 17).getValues()[0].map(String);
  if (JSON.stringify(current) !== JSON.stringify(MINI_QUESTION_HEADERS)) {
    throw new Error("Столбцы «Мини_Вопросы» отличаются от ожидаемых A–Q. Ничего не изменено.");
  }
  return questionSheet;
}

function setupMiniTimedPilot() {
  miniRequireOwnerRun_();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const spreadsheet = miniSheetFile_();
    // Проверка нового порядка колонок: не перемещаем столбцы старого бота.
    const qSheet = miniCheckQuestionHeaders_();
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
          throw new Error("Заголовки листа «" + name + "» не совпадают.");
        }
      }
    });
    qSheet.getRange("O:O").setNumberFormat("@");
    spreadsheet.getSheetByName(MINI.timersSheet).getRange("B:B").setNumberFormat("@");
    spreadsheet.getSheetByName(MINI.answersSheet).getRange("B:B").setNumberFormat("@");
    console.log("PASS: новый порядок A–Q в «Мини_Вопросы» проверен. Старые листы не изменены.");
  } finally { lock.releaseLock(); }
}

/**
 * Создаёт новый выпуск из всех шести вопросов «Мини_Вопросы».
 * Время колонки B не учитывается: все вопросы доступны сразу.
 * Время таймера берётся из колонки Q (пусто = 60 секунд).
 * Не запускай повторно без необходимости: каждый запуск — новый выпуск.
 */
function startNewTimedPilot() {
  miniRequireOwnerRun_();
  return miniCreateNewEdition_();
}

/** Закрытый служебный метод для ручного запуска и недельного триггера. */
function miniCreateNewEdition_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    miniSheet_(MINI.timersSheet);
    miniCheckQuestionHeaders_();
    const questions = miniReadQuestions_();
    const now = new Date();
    const day = Utilities.formatDate(now, MINI.tz, "yyyy-MM-dd");
    const statsAt = new Date(day + "T19:00:00+03:00");
    const previousId = miniProps_().getProperty("MINI_ACTIVE_RUN");
    if (previousId) {
      const previous = miniRows_(MINI.runSheet).find(r => r.v[0] === previousId);
      if (previous) miniSheet_(MINI.runSheet).getRange(previous.row, 4).setValue("ARCHIVED");
    }
    const runId = "timed_" + Utilities.getUuid();
    miniAppend_(MINI.runSheet,[runId, now, statsAt, "ACTIVE", JSON.stringify(questions)]);
    miniProps_().setProperty("MINI_ACTIVE_RUN", runId);
    SpreadsheetApp.flush();
    console.log("PASS: новый выпуск из 6 вопросов создан. Статистика после 19:00 МСК; история сохранена.");
  } finally { lock.releaseLock(); }
}

function miniReadQuestions_() {
  // A = №, B = дата, C = описание, D = вопрос, E:N = 10 вариантов,
  // O = правильные (1–10), P = объяснение, Q = таймер (15–300, пусто = 60).
  const sheet = miniCheckQuestionHeaders_();
  const last = sheet.getLastRow();
  if (last < 2) throw new Error("Лист «Мини_Вопросы» пуст");
  const records = sheet.getRange(2, 1, last - 1, 17).getDisplayValues();
  const questions = records.filter(r => String(r[0]).trim() !== "").map(r => {
    const id = Number(r[0]);
    const options = r.slice(4, 14).map(value => String(value).trim());
    while (options.length && !options[options.length - 1]) options.pop();
    const correctText = String(r[14] || "").trim();
    const correct = correctText ? correctText.split(/[,;\s]+/).map(Number) : [];
    const timeRaw = String(r[16] || "").trim();
    const timeSeconds = timeRaw ? Number(timeRaw) : 60;
    if (!Number.isInteger(id) || id < 1 || id > 6 ||
        !String(r[3]).trim() || options.length < 2 || options.length > 10 ||
        options.some(x => !x) || correct.length === 0 ||
        new Set(correct).size !== correct.length ||
        correct.some(n => !Number.isInteger(n) || n < 1 || n > options.length) ||
        !Number.isInteger(timeSeconds) || timeSeconds < 15 || timeSeconds > 300) {
      throw new Error("Проверь строку " + (id + 1) +
        " листа «Мини_Вопросы»: вопрос, варианты, правильные и время.");
    }
    return {
      id: id,
      description: String(r[2] || ""),
      text: String(r[3]),
      options: options,
      correct: correct.map(x => x - 1).sort((a, b) => a - b),
      explanation: String(r[15] || ""),
      timeSeconds: timeSeconds
    };
  });
  if (questions.length !== 6 || new Set(questions.map(q => q.id)).size !== 6) {
    throw new Error("Нужно ровно шесть вопросов с уникальными номерами");
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
    // Режим PUBLIC нужно включить явно через Script Properties перед запуском.
    // В режиме PILOT доступен только владелец; старый бот не затрагиваем.
    const accessMode = String(miniProps_().getProperty("MINI_ACCESS_MODE") ||
      "pilot").toLowerCase().trim();
    if (accessMode !== "pilot" && accessMode !== "public") {
      return {ok:false,error:"Неверно настроен режим доступа Mini App."};
    }
    if (accessMode === "pilot" &&
        String(person.id) !== String(miniProps_().getProperty("TEST_CHAT_ID"))) {
      return {ok: false, error: "Сейчас тест доступен только администратору."};
    }
    // Отправка результата только по явному запросу прошедшего все 6 вопросов.
    if (action === "share") return miniPrepareSharedResult_(person);
    let state;
    if (action === "state" || action === "checkSubscription")
      state = miniStateFor_(person);
    else if (action === "open") state = miniOpenFor_(person);
    else if (action === "answer") state = miniAnswerFor_(person, payload);
    else if (action === "expire") state = miniExpireFor_(person);
    else return {ok: false, error: "Неизвестная операция"};
    // Проверка членства и вычисление статистики за пределами lock.
    // Ни один ответ API не содержит статистику до успешной проверки.
    return miniApplySubscriptionGate_(person, state);
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


function miniTimerFor_(run, user, questionId) {
  return miniRows_(MINI.timersSheet)
    .find(r => r.v[0] === run.id &&
      String(r.v[1]) === String(user.id) && Number(r.v[2]) === questionId) || null;
}
function miniCurrentQuestion_(run, user) {
  const answers = miniAnswersFor_(run, user);
  return run.questions[answers.length] || null;
}
function miniSettleExpiredCurrent_(run, user) {
  const q = miniCurrentQuestion_(run, user);
  if (!q) return false;
  const clock = miniTimerFor_(run, user, q.id);
  if (!clock) return false;
  if (Date.now() < new Date(clock.v[4]).getTime()) return false;
  // [] means no response in time. It is scored as incorrect, and cannot be changed.
  miniAppend_(MINI.answersSheet,
    [run.id, String(user.id), q.id, "[]", false, new Date()]);
  SpreadsheetApp.flush();
  return true;
}
function miniStateFor_(user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    miniSettleExpiredCurrent_(run, user);
    return miniBuildState_(run, user);
  } finally { lock.releaseLock(); }
}
function miniOpenFor_(user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    miniSettleExpiredCurrent_(run, user);
    const q = miniCurrentQuestion_(run, user);
    if (q && !miniTimerFor_(run, user, q.id)) {
      const start = new Date();
      miniAppend_(MINI.timersSheet, [
        run.id, String(user.id), q.id, start,
        new Date(start.getTime() + (q.timeSeconds || 60) * 1000)
      ]);
      SpreadsheetApp.flush();
    }
    return miniBuildState_(run, user);
  } finally { lock.releaseLock(); }
}
function miniExpireFor_(user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    miniSettleExpiredCurrent_(run, user);
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
      timedOut: String(row.v[3]) === "[]",
      correctOptions: q.correct,
      explanation: q.explanation
    };
  });
  const complete = answers.length === run.questions.length;
  const statsReady = complete && Date.now() >= run.statsAt;
  const nextQuestion = run.questions[answers.length];
  const clock = nextQuestion ? miniTimerFor_(run,user,nextQuestion.id) : null;
  return {
    ok: true,
    userName: String(user.first_name || "Участник").slice(0, 80),
    runId: run.id,
    // Будущие вопросы не раскрываем до запуска их таймера.
    // Уже пройденные вопросы и открытый текущий вопрос доступны клиенту.
    // Массив имеет 6 позиций: закрытые будущие вопросы = null.
    questions: run.questions.map((q, index) => {
      if (index > rows.length || (index === rows.length && !clock)) return null;
      return {
        id: q.id, text: q.text, description: q.description,
        options: q.options, multiple: q.correct.length > 1,
        timeSeconds: q.timeSeconds || 60
      };
    }),
    answers: answers,
    activeTimer: clock ? {
      questionId: nextQuestion.id,
      deadlineMs: new Date(clock.v[4]).getTime(),
      durationSec: nextQuestion.timeSeconds || 60
    } : null,
    complete: complete,
    score: complete ? answers.filter(a => a.correct).length : null,
    statistics: null,
    subscriptionStatus: complete ? "checking" : "not_finished",
    statsReady: statsReady,
    statisticsAt: Utilities.formatDate(new Date(run.statsAt), MINI.tz, "dd.MM.yyyy HH:mm")
  };
}

function miniAnswerFor_(user, payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.selected)) {
    return {ok: false, error: "Не выбран ответ"};
  }
  const questionId = Number(payload.questionId);
  const selected = payload.selected;
  if (selected.length < 1 || selected.length > 10 ||
      new Set(selected).size !== selected.length ||
      selected.some(x => !Number.isInteger(x) || x < 0 || x > 9)) {
    return {ok: false, error: "Некорректные варианты ответа"};
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const run = miniActiveRun_();
    miniRegister_(run, user);
    const records = miniAnswersFor_(run, user);
    miniSettleExpiredCurrent_(run, user);
    const stored = miniAnswersFor_(run,user).find(r => Number(r.v[2]) === questionId);
    // Повторная отправка НЕ меняет уже записанный ответ.
    if (stored) return miniBuildState_(run, user);

    const expected = run.questions[records.length];
    if (!expected || expected.id !== questionId ||
        selected.some(x => x >= expected.options.length)) {
      return {ok: false, error: "Пожалуйста, отвечай по порядку."};
    }
    const clock = miniTimerFor_(run,user,questionId);
    if (!clock) return {ok:false,error:"Вопрос ещё не открыт."};
    if (Date.now() >= new Date(clock.v[4]).getTime()) {
      miniSettleExpiredCurrent_(run,user);
      return miniBuildState_(run,user);
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

/**
 * Проверка членства в публичном канале вы́Читать.
 * Срок действия auth Telegram проверяется miniApi ПЕРЕД этим вызовом.
 * Ошибки сети не превращаются в «не подписан».
 */
function miniCheckChannelMember_(userId) {
  const token=miniProps_().getProperty("BOT_TOKEN");
  if (!token) return "unavailable";
  try {
    const response=UrlFetchApp.fetch(
      "https://api.telegram.org/bot"+token+"/getChatMember",{
        method:"post",contentType:"application/json",
        payload:JSON.stringify({chat_id:MINI.channelUsername,user_id:Number(userId)}),
        muteHttpExceptions:true
      }
    );
    const body=JSON.parse(response.getContentText());
    if (!body || body.ok!==true || !body.result ||
        typeof body.result.status!=="string") {
      console.warn("Channel membership: Telegram did not confirm status. HTTP "+
        response.getResponseCode());
      return "unavailable";
    }
    const member=body.result;
    if (member.status==="creator" || member.status==="administrator" ||
        member.status==="member" ||
        (member.status==="restricted" && member.is_member===true)) return "member";
    if (member.status==="left" || member.status==="kicked" ||
        (member.status==="restricted" && member.is_member===false)) return "required";
    return "unavailable";
  } catch(error) {
    console.warn("Channel membership: service temporarily unavailable.");
    return "unavailable";
  }
}

/**
 * Дополняет состояние закрытыми процентами только после проверки подписки.
 * Выполняется отдельно от блокировки таблицы.
 */
function miniApplySubscriptionGate_(user,state) {
  // Проверяем подписку СРАЗУ после завершения теста, независимо от времени.
  // Общая статистика выдаётся лишь после 19:00 МСК.
  if (!state || state.ok!==true || !state.complete)
    return state;
  state.subscriptionStatus=miniCheckChannelMember_(user.id);
  if (state.subscriptionStatus!=="member" || !state.statsReady) return state;
  const entry=miniRows_(MINI.runSheet).find(r=>String(r.v[0])===String(state.runId));
  if (!entry) {
    state.subscriptionStatus="unavailable";
    return state;
  }
  const run={id:String(entry.v[0]),questions:JSON.parse(String(entry.v[4]))};
  state.statistics=miniStatistics_(run);
  return state;
}

/** Ручная проверка из редактора GAS, без публикации и рассылок. */
function checkMiniChannelSetup() {
  miniRequireOwnerRun_();
  const id=String(miniProps_().getProperty("TEST_CHAT_ID") || "").trim();
  if (!/^[1-9]\d{3,15}$/.test(id))
    throw new Error("Не заполнен TEST_CHAT_ID.");
  const result=miniCheckChannelMember_(id);
  if (result!=="member")
    throw new Error(result==="unavailable"
      ? "Telegram не подтвердил доступ к каналу. Проверь права бота."
      : "Тестовый пользователь пока не подписан на вы́Читать.");
  console.log("PASS: бот видит подписку тестового аккаунта на вы́Читать.");
}

function miniStatistics_(run) {
  // Учитываем только первый ответ пользователя на вопрос, чтобы повторные
  // сетевые запросы не искажали публичную и административную статистику.
  const data = miniRows_(MINI.answersSheet);
  const byQuestion = new Map(run.questions.map(q => [Number(q.id), new Map()]));
  data.forEach(entry => {
    const r = entry.v;
    if (String(r[0]) !== run.id) return;
    const group = byQuestion.get(Number(r[2]));
    if (!group) return;
    const uid = String(r[1]);
    if (!group.has(uid)) group.set(uid,
      r[4] === true || String(r[4]).toUpperCase() === "TRUE");
  });
  return run.questions.map(q => {
    const answers = Array.from(byQuestion.get(Number(q.id)).values());
    const total = answers.length, good = answers.filter(Boolean).length;
    return {
      questionId: q.id,
      correctPercent: total ? Math.round(good * 100 / total) : 0,
      incorrectPercent: total ? Math.round((total - good) * 100 / total) : 0
    };
  });
}

/**
 * Отправляет кнопку тестового запуска только TEST_CHAT_ID, не меняя меню BotFather,
 * не вызывает getUpdates и не меняет существующий Telegram-бот.
 */

/**
 * Отправить кнопку ТОЛЬКО TEST_CHAT_ID и только один раз для текущего выпуска.
 * Адрес GAS берётся из MINI_WEBAPP_URL; вводить URL в Mini App не нужно.
 */
function sendTimedPilotButton() {
  miniRequireOwnerRun_();
  const props = miniProps_();
  const runId = props.getProperty("MINI_ACTIVE_RUN");
  if (!runId) throw new Error("Сначала запусти startNewTimedPilot()");
  if (props.getProperty("MINI_TIMED_BUTTON_SENT_RUN") === runId) {
    throw new Error("Кнопка этого выпуска уже отправлена. Проверь чат Telegram.");
  }
  const token = props.getProperty("BOT_TOKEN");
  const chatId = String(props.getProperty("TEST_CHAT_ID") || "").trim();
  if (!token || !/^[1-9][0-9]{3,15}$/.test(chatId)) {
    throw new Error("Проверь BOT_TOKEN и TEST_CHAT_ID");
  }
  // ScriptApp.getService().getUrl() иногда возвращает null при ручном запуске.
  // Для надежности адрес уже опубликованного Web App указывает владелец в Script Properties.
  const gasUrl = String(props.getProperty("MINI_WEBAPP_URL") || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(gasUrl)) {
    throw new Error("Добавь MINI_WEBAPP_URL в свойства скрипта: полный адрес Web App, заканчивающийся на /exec.");
  }
  const appUrl = MINI.pagesUrl + "?gas=" + encodeURIComponent(gasUrl);
  const payload = {
    chat_id: chatId,
    text: "«вы́Читать»: 6 вопросов по русскому языку. На каждый вопрос — свой таймер.",
    reply_markup: {inline_keyboard: [[{
      text: "Пройти 6 вопросов",
      web_app: {url: appUrl}
    }]]}
  };
  const response = UrlFetchApp.fetch("https://api.telegram.org/bot" +
      token + "/sendMessage", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  let result;
  try { result = JSON.parse(response.getContentText()); }
  catch (_) { throw new Error("Не удалось прочитать ответ Telegram. Проверь свой чат."); }
  if (!result.ok) throw new Error("Ошибка Telegram: " +
    (result.error_code || response.getResponseCode()));
  props.setProperty("MINI_TIMED_BUTTON_SENT_RUN",runId);
  console.log("PASS: кнопка с таймером отправлена администратору.");
}


/**
 * Создаёт красивое пересылаемое сообщение с правильными ссылками:
 * канал вы́Читать — кликабельный текст; бот — кнопка «Открыть тест».
 * Получатель запускает бота, а обработчик /start показывает кнопку Web App.
 * В Mini App используется WebApp.shareMessage; fallback в старых клиентах
 * построен на share/url.
 */
function miniPrepareSharedResult_(user) {
  const run=miniActiveRun_();
  const answers=miniAnswersFor_(run,user);
  if (answers.length!==run.questions.length)
    return {ok:false,error:"Сначала заверши все шесть вопросов."};
  const score=answers.filter(x=>x.v[4]===true ||
    String(x.v[4]).toUpperCase()==="TRUE").length;
  const token=miniProps_().getProperty("BOT_TOKEN");
  if (!token) return {ok:false,error:"Не настроен BOT_TOKEN"};
  const botUrl="https://t.me/posttsop_test_bot?start=quiz";
  const message="Я набрал <b>"+score+" из 6</b> в тесте канала "+
    "<a href=\"https://t.me/posttsop\">вы́Читать</a> по русскому языку.\n"+
    "А ты справишься лучше?\n\n"+
    "<a href=\""+botUrl+"\">Пройти тест</a>";
  try {
    const saved=miniTelegramRequest_("savePreparedInlineMessage",token,{
      user_id:Number(user.id),
      result:{
        type:"article",
        id:"quiz_"+String(Utilities.getUuid()).replace(/-/g,"").slice(0,35),
        title:"Мой результат в тесте вы́Читать",
        input_message_content:{
          message_text:message,parse_mode:"HTML",
          link_preview_options:{is_disabled:true}
        },
        reply_markup:{inline_keyboard:[[{
          text:"Открыть тест",url:botUrl
        }]]}
      },
      allow_user_chats:true,allow_group_chats:true,
      allow_bot_chats:false,allow_channel_chats:false
    });
    if(!saved.result || typeof saved.result.id!=="string")
      return {ok:false,error:"Telegram не вернул идентификатор сообщения."};
    return {ok:true,shareId:saved.result.id};
  } catch(e) {
    console.warn("Mini App share: could not prepare Telegram message.");
    return {ok:false,error:"Не удалось подготовить сообщение в Telegram."};
  }
}

/**
 * Служебные инструменты ПОДГОТОВКИ публичного выпуска.
 * Не запускаются сами. До запуска в Script Properties оставь MINI_ACCESS_MODE=pilot.
 * Telegram-бот не имеет права писать пользователю, не начавшему диалог с ботом.
 */

function miniPublicLaunchUrl_() {
  const gasUrl = String(miniProps_().getProperty("MINI_WEBAPP_URL") || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/.test(gasUrl))
    throw new Error("Укажи корректный MINI_WEBAPP_URL (/exec).");
  return MINI.pagesUrl + "?gas=" + encodeURIComponent(gasUrl);
}

function miniTelegramRequest_(method, token, payload) {
  const response = UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + token + "/" + method, {
      method:"post",contentType:"application/json",
      payload:JSON.stringify(payload),muteHttpExceptions:true
    }
  );
  let data;
  try {data = JSON.parse(response.getContentText());}
  catch (_) {throw new Error("Telegram вернул некорректный ответ.");}
  if (!data || !data.ok)
    throw new Error("Telegram " + method + ": " +
      String(data?.description || data?.error_code || response.getResponseCode()));
  return data;
}

/**
 * Однократно при публичном запуске: добавляет кнопку «Пройти тест»
 * в меню ЛИЧНОГО чата с ботом. Не меняет webhook, команды или старого бота.
 * Пока MINI_ACCESS_MODE != public, запуск запрещён.
 */
function configureMiniBotMenu() {
  miniRequireOwnerRun_();
  if (String(miniProps_().getProperty("MINI_ACCESS_MODE")) !== "public")
    throw new Error("Сначала включи MINI_ACCESS_MODE = public, когда пилот проверен.");
  const token = miniProps_().getProperty("BOT_TOKEN");
  if (!token) throw new Error("Нет BOT_TOKEN");
  miniTelegramRequest_("setChatMenuButton",token,{
    menu_button: {type:"web_app",text:"Открыть тест",web_app:{url:miniPublicLaunchUrl_()}}
  });
  // Убираем все старые команды викторины из стандартного меню.
  miniTelegramRequest_("setMyCommands",token,{
    commands:[{command:"start",description:"Открыть тест"}]
  });
  console.log("PASS: кнопка Mini App в меню и только команда /start.");
}

/**
 * По запросу владельца отправляет приглашения ТОЛЬКО тем, кто раньше
 * начал диалог с ботом и отмечен «Активен» в старом листе «Участники».
 * Пакет не больше 20 человек за запуск. Дубли в одном выпуске исключены.
 * Никаких автоматических вечерних сообщений.
 */
function sendMiniInvitationsBatch() {
  miniRequireOwnerRun_();
  const batch=miniSendInvitationsBatch_();
  if(batch.remaining>0) miniScheduleInviteContinuation_();
  return batch;
}
function miniSendInvitationsBatch_() {
  const props=miniProps_();
  if (String(props.getProperty("MINI_ACCESS_MODE")) !== "public" ||
      String(props.getProperty("MINI_INVITES_ENABLED")) !== "yes") {
    throw new Error("Рассылка выключена. Перед публичным запуском явно задай " +
      "MINI_ACCESS_MODE=public и MINI_INVITES_ENABLED=yes.");
  }
  const token=props.getProperty("BOT_TOKEN");
  if (!token) throw new Error("Нет BOT_TOKEN");
  const run=miniActiveRun_();
  const book=miniSheetFile_();
  const old=book.getSheetByName("Участники");
  const launcherContacts=book.getSheetByName("Мини_БотКонтакты");
  if (!old && !launcherContacts)
    throw new Error("Нет списка участников старого или нового бота.");
  const lock=LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    let log=book.getSheetByName("Мини_Приглашения");
    if (!log) {
      log=book.insertSheet("Мини_Приглашения");
      log.getRange(1,1,1,4).setValues([["run_id","telegram_id","sent_at","status"]]);
      log.setFrozenRows(1);
    } else if(!String(log.getRange(1,4).getValue()).trim()){
      log.getRange(1,4).setValue("status");
    }
    const previous=log.getLastRow()>1
      ? log.getRange(2,1,log.getLastRow()-1,4).getValues() : [];
    const sentIds=new Set(previous.filter(r=>String(r[0])===run.id).map(r=>String(r[1])));
    const blockedIds=new Set(previous.filter(r=>String(r[3])==="blocked").map(r=>String(r[1])));
    const targets=[];
    const seen=new Set();
    function addTarget(id,active) {
      id=String(id).trim();
      if (active && /^[1-9]\d{3,15}$/.test(id) &&
          !seen.has(id) && !sentIds.has(id) && !blockedIds.has(id)) {
        targets.push(id);seen.add(id);
      }
    }
    if(old && old.getLastRow()>1){
      old.getRange(2,1,old.getLastRow()-1,2).getValues()
        .forEach(r=>addTarget(r[0],String(r[1]).toLowerCase()==="true"));
    }
    if(launcherContacts && launcherContacts.getLastRow()>1){
      launcherContacts.getRange(2,1,launcherContacts.getLastRow()-1,5).getValues()
        .forEach(r=>addTarget(r[0],String(r[4]).toLowerCase()==="active"));
    }
    const app=miniPublicLaunchUrl_();
    let success=0, errors=0;
    for(const id of targets.slice(0,20)){
      try {
        miniTelegramRequest_("sendMessage",token,{
          chat_id:id,text:"Вышел новый тест по русскому языку от канала вы́Читать. " +
          "Шесть вопросов, одна попытка. Проверишь себя?",
          reply_markup:{inline_keyboard:[[{text:"Открыть тест",web_app:{url:app}}]]}
        });
        log.appendRow([run.id,id,new Date(),"sent"]);
        success++;
        // Мягкое ограничение скорости Telegram: не более примерно 10/сек.
        Utilities.sleep(100);
      } catch(e) {
        errors++;
        const problem=String(e.message||e);
        console.warn("Mini App invite: " + problem.replace(token,"[TOKEN]"));
        // Пользователь заблокировал бота или удалил аккаунт.
        // Не пытаемся слать ему приглашения каждый следующий час.
        if (/403|bot was blocked|user is deactivated|chat not found/i.test(problem)) {
          log.appendRow([run.id,id,new Date(),"blocked"]);
          continue;
        }
        if (/429|Too Many Requests|retry after/i.test(problem)) break;
      }
    }
    console.log("PASS: приглашений отправлено " + success +
      "; ошибок " + errors + "; осталось к отправке до " +
      (targets.length-success) + ". Повтори отправку при необходимости.");
    return {sent:success,errors,remaining:targets.length-success};
  } finally {lock.releaseLock();}
}


/**
 * Автоматически продолжаем отправку, если в первом запуске больше 200
 * зарегистрированных пользователей. Каждый следующий запуск через час.
 * При выключенных флагах рассылок не будет.
 */
function miniScheduleInviteContinuation_() {
  const exists=ScriptApp.getProjectTriggers().some(t=>
    t.getHandlerFunction()==="miniContinueInvitations_");
  if (exists) return;
  ScriptApp.newTrigger("miniContinueInvitations_").timeBased()
    .after(60*60*1000).create();
  console.log("Очередь приглашений не закончилась. Продолжим через час.");
}

function miniSendPendingInvitations_() {
  let total=0,remaining=0,errors=0;
  for(let batch=0;batch<10;batch++){
    const result=miniSendInvitationsBatch_();
    total+=result.sent;
    remaining=result.remaining;
    errors+=result.errors;
    if(!remaining || !result.sent || result.errors) break;
  }
  if(remaining>0) miniScheduleInviteContinuation_();
  console.log("Приглашения: отправлено "+total+
    ", осталось "+remaining+", ошибок "+errors+".");
}

function miniContinueInvitations_() {
  // Одноразовый триггер завершается, чтобы следующий запуск можно было
  // планировать по фактическому количеству ещё не приглашённых.
  ScriptApp.getProjectTriggers().filter(t=>
    t.getHandlerFunction()==="miniContinueInvitations_")
    .forEach(t=>ScriptApp.deleteTrigger(t));
  const props=miniProps_();
  if(String(props.getProperty("MINI_ACCESS_MODE"))!=="public" ||
     String(props.getProperty("MINI_INVITES_ENABLED"))!=="yes") return;
  const run=miniActiveRun_();
  const row=miniRows_(MINI.runSheet).find(x=>String(x.v[0])===run.id);
  if(!row || Date.now()-new Date(row.v[1]).getTime()>7*86400000){
    console.log("Очередь рассылки устарела, пропускаем.");
    return;
  }
  miniSendPendingInvitations_();
}

/**
 * Подготовка еженедельного запуска. Один раз запусти из редактора GAS
 * installMiniTuesdayTrigger() ПОСЛЕ отключения старого расписания опросов.
 * По вторникам примерно в 10:00 МСК проверяется флаг MINI_WEEKLY_ENABLED=yes.
 * Пока флаг не выставлен, никаких новых выпусков и сообщений не будет.
 */
function installMiniTuesdayTrigger() {
  miniRequireOwnerRun_();
  const exists=ScriptApp.getProjectTriggers().some(t =>
    t.getHandlerFunction()==="miniTuesdayLaunch_");
  if (exists) {
    console.log("PASS: триггер на вторник уже установлен.");
    return;
  }
  ScriptApp.newTrigger("miniTuesdayLaunch_").timeBased()
    .onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(10)
    .everyWeeks(1).inTimezone(MINI.tz).create();
  console.log("PASS: подготовлен недельный триггер около 10:00 МСК во вторник. " +
    "Срабатывание возможно только при MINI_WEEKLY_ENABLED=yes.");
}

/** Служебная (не вызывается из публичного Mini App) функция для time trigger. */
function miniTuesdayLaunch_() {
  const props=miniProps_();
  if (String(props.getProperty("MINI_WEEKLY_ENABLED"))!=="yes" ||
      String(props.getProperty("MINI_ACCESS_MODE"))!=="public") {
    console.log("Автозапуск выключен, ничего не отправлено.");
    return;
  }
  const now=new Date();
  const day=Utilities.formatDate(now,MINI.tz,"yyyy-MM-dd");
  // Полдень по Москве, чтобы определять день недели без зависимости от UTC.
  if (new Date(day+"T12:00:00+03:00").getUTCDay()!==2) return;
  const active=miniRows_(MINI.runSheet).filter(row=>String(row.v[3])==="ACTIVE");
  const already=active.some(row=>
    Utilities.formatDate(new Date(row.v[1]),MINI.tz,"yyyy-MM-dd")===day);
  if (!already) {
    // Новый выпуск возникает только при изменении шести вопросов.
    // Не рассылаем старый тест повторно каждую неделю.
    const draft=miniReadQuestions_();
    const previous=active.length?active[active.length-1]:null;
    if (previous) {
      // Сравниваем содержимое, а не порядок ключей JSON.
      const normalize=items=>items.map(q=>[
        Number(q.id),String(q.description||""),String(q.text||""),
        q.options, q.correct,String(q.explanation||""),Number(q.timeSeconds||60)
      ]);
      if (JSON.stringify(normalize(draft))===
          JSON.stringify(normalize(JSON.parse(String(previous.v[4]))))) {
        console.log("Новых вопросов нет: выпуск и рассылка пропущены.");
        return;
      }
    }
    miniCreateNewEdition_();
  }
  // Доставка — только если явно включены адресные приглашения.
  if (String(props.getProperty("MINI_INVITES_ENABLED"))==="yes") {
    // До 200 сообщений за запуск; остаток автоматически отправим позже.
    miniSendPendingInvitations_();
  }
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



// ============================================================
// Telegram launcher-only bot: /start → button; weekly invitations.
// SINGLE-FILE deployment: do not install MiniLauncherWebhook.gs separately.
// ============================================================

/**
 * вы́Читать Mini App — будущий launcher-webhook бота.
 *
 * Пока НЕ установлен в GAS и НЕ активирован в Telegram.
 * Подключать ТОЛЬКО при окончательной замене старого webhook-бота.
 * Требует функций miniProps_, miniSheetFile_, miniTelegramRequest_,
 * miniPublicLaunchUrl_, miniRequireOwnerRun_ из Stage6-TimedPilot.gs.
 *
 * MINI_LAUNCHER_WEBHOOK_KEY генерируется при подготовке.
 * Telegram webhook указывается с query ?mini_key=... . В GAS нет доступа
 * к секретному HTTP-заголовку X-Telegram-Bot-Api-Secret-Token.
 */
const MINI_BOT_CONTACTS="Мини_БотКонтакты";

function miniLauncherText_() {
  return "Привет! Это тест по русскому языку от канала "+
    "<a href=\"https://t.me/posttsop\">вы́Читать</a>.\n\n"+
    "Шесть вопросов, свой таймер на каждый и одна попытка.\n\n"+
    "Нажми кнопку, чтобы открыть приложение.";
}

function miniSaveBotContact_(id, name) {
  const lock=LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const book=miniSheetFile_();
    let sh=book.getSheetByName(MINI_BOT_CONTACTS);
    if(!sh){
      sh=book.insertSheet(MINI_BOT_CONTACTS);
      sh.getRange(1,1,1,5).setValues([[
        "telegram_id","first_name","first_started_at","last_started_at","status"
      ]]);
      sh.setFrozenRows(1);
      sh.getRange("A:A").setNumberFormat("@");
    }
    const last=sh.getLastRow(),value=String(id);
    const data=last>1?sh.getRange(2,1,last-1,5).getValues():[];
    const index=data.findIndex(r=>String(r[0])===value);
    if(index>=0){
      sh.getRange(index+2,2).setValue(name);
      sh.getRange(index+2,4,1,2).setValues([[new Date(),"active"]]);
    }else{
      sh.appendRow([value,name,new Date(),new Date(),"active"]);
    }
  } finally {lock.releaseLock();}
}

/**
 * При первом /start и любом повторном /start отдаёт только одну кнопку.
 * Для других сообщений и групп ничего не делаем.
 */
function doPost(e) {
  // HTML-ответ вместо ContentService: исключаем лишний 302-редирект
  // при доставке Telegram webhook на Google Apps Script.
  const response=()=>HtmlService.createHtmlOutput("ok");
  try{
    const secret=String(miniProps_().getProperty("MINI_LAUNCHER_WEBHOOK_KEY")||"");
    if(secret.length<32 || !e || !e.parameter ||
        String(e.parameter.mini_key||"")!==secret){
      console.warn("Mini launcher: rejected unverified update");
      return response();
    }
    const update=JSON.parse(String(e.postData?.contents||""));
    const message=update?.message;
    if(!message || message.chat?.type!=="private" ||
      !/^\/start(?:\s+[A-Za-z0-9_-]{1,64})?\s*$/.test(String(message.text||"")))
      return response();
    const user=message.from,chat=message.chat;
    if(!user || !Number.isSafeInteger(user.id) || !chat || chat.id!==user.id)
      return response();
    // Telegram повторяет доставку обновлений при временной ошибке webhook.
    const updateId=Number(update.update_id);
    const props=miniProps_();
    const last=Number(props.getProperty("MINI_LAST_START_UPDATE_ID")||"-1");
    if(Number.isSafeInteger(updateId) && updateId<=last) return response();
    miniSaveBotContact_(String(user.id),String(user.first_name||"").slice(0,80));
    miniTelegramRequest_("sendMessage",miniProps_().getProperty("BOT_TOKEN"),{
      chat_id:user.id,
      text:miniLauncherText_(),
      parse_mode:"HTML",
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[
        {text:"Открыть тест",web_app:{url:miniPublicLaunchUrl_()}}
      ]]}
    });
    if(Number.isSafeInteger(updateId))
      props.setProperty("MINI_LAST_START_UPDATE_ID",String(updateId));
  }catch(error){
    console.warn("Mini launcher: "+String(error.message||error)
      .replace(String(miniProps_().getProperty("BOT_TOKEN")||""),"[TOKEN]"));
  }
  return response();
}

/**
 * Только владельцу в редакторе GAS. Подготовка НЕ меняет webhook.
 * Код хранится отдельно от секрета: сам ключ не печатаем в лог.
 */
function prepareMiniLauncherWebhook() {
  miniRequireOwnerRun_();
  const props=miniProps_();
  if(!props.getProperty("MINI_LAUNCHER_WEBHOOK_KEY")){
    props.setProperty("MINI_LAUNCHER_WEBHOOK_KEY",
      Utilities.getUuid().replace(/-/g,"")+
      Utilities.getUuid().replace(/-/g,""));
  }
  console.log("PASS: секрет webhook подготовлен. Текущий webhook не менялся.");
}

/**
 * ВАЖНО: именно здесь Telegram начнёт присылать /start в новый GAS.
 * Запускать ТОЛЬКО после подтверждённого отказа от старых функций бота,
 * когда MINI_ACCESS_MODE=public и готов новый выпуск.
 */
function activateMiniLauncherWebhook() {
  miniRequireOwnerRun_();
  const props=miniProps_();
  if(String(props.getProperty("MINI_ACCESS_MODE"))!=="public")
    throw new Error("Сначала включи MINI_ACCESS_MODE=public.");
  const key=String(props.getProperty("MINI_LAUNCHER_WEBHOOK_KEY")||"");
  if(!/^[a-f0-9]{64}$/.test(key))
    throw new Error("Сначала запусти prepareMiniLauncherWebhook.");
  const endpoint=String(props.getProperty("MINI_WEBAPP_URL")||"");
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint))
    throw new Error("Некорректный MINI_WEBAPP_URL");
  const token=props.getProperty("BOT_TOKEN");
  if(!token)throw new Error("Не указан BOT_TOKEN");
  // Смена webhook — явная миграция с предыдущей версии.
  // На случай отката сохраняем прежний публичный адрес webhook.
  const before=miniTelegramRequest_("getWebhookInfo",token,{});
  const oldUrl=String(before.result?.url||"");
  if(oldUrl&&!oldUrl.startsWith(endpoint+"?mini_key="))
    props.setProperty("MINI_PREVIOUS_WEBHOOK_URL",oldUrl);
  miniTelegramRequest_("setWebhook",token,{
    url:endpoint+"?mini_key="+key,
    allowed_updates:["message"],
    max_connections:1,
    drop_pending_updates:false
  });
  console.log("PASS: Telegram /start теперь обслуживает новый launcher; "+
    "старые команды перестали поступать в прежний GAS.");
}

/** Проверяет состояние webhook без раскрытия URL или секретного ключа. */
function checkMiniLauncherWebhook() {
  miniRequireOwnerRun_();
  const props=miniProps_();
  const token=props.getProperty("BOT_TOKEN");
  if(!token)throw new Error("Не указан BOT_TOKEN");
  const info=miniTelegramRequest_("getWebhookInfo",token,{}).result||{};
  const expected=String(props.getProperty("MINI_WEBAPP_URL")||"")+
    "?mini_key="+String(props.getProperty("MINI_LAUNCHER_WEBHOOK_KEY")||"");
  const ours=!!info.url && info.url===expected;
  console.log("Webhook: "+(ours?"НОВЫЙ Mini App":"ещё старый или не настроен")+
    "; очередь: "+(info.pending_update_count||0)+
    "; последняя ошибка: "+String(info.last_error_message||"нет"));
  return {ours:ours,pending:Number(info.pending_update_count||0),
    lastError:String(info.last_error_message||"")};
}
