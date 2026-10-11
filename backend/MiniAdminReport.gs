/**
 * Отчёт для владельца «вы́Читать». Отдельный файл в GAS-проекте Mini App.
 * Запуск вручную: buildMiniAdminReport(). Участникам отчёт не отправляется.
 * Необязательное MINI_REPORT_RUN_ID в Script Properties — архивный выпуск.
 */
const MINI_REPORT_TAB = "Мини_Отчёт";
const MINI_REPORT_MARKER = "вы́Читать · Отчёт Mini App";

function miniAdminStats_(run, peopleRows, answerRows) {
  const id = String(run[0]), questions = JSON.parse(String(run[4] || ""));
  if (!Array.isArray(questions) || questions.length !== 6 ||
      new Set(questions.map(q => Number(q.id))).size !== 6) {
    throw new Error("В выпуске нет шести уникальных вопросов.");
  }
  const known = new Set(questions.map(q => Number(q.id)));
  const users = new Set(), answers = new Map();
  peopleRows.forEach(x => {
    if (String(x.v[0]) === id && String(x.v[1]).trim()) users.add(String(x.v[1]));
  });
  answerRows.forEach(x => {
    const r = x.v, uid = String(r[1]).trim(), qid = Number(r[2]);
    if (String(r[0]) !== id || !uid || !known.has(qid)) return;
    users.add(uid);
    if (!answers.has(uid)) answers.set(uid, new Map());
    const a = answers.get(uid);
    if (a.has(qid)) return; // оригинальный ответ нельзя перезаписать
    a.set(qid, {
      good: r[4] === true || String(r[4]).toUpperCase() === "TRUE",
      expired: String(r[3]).trim() === "[]"
    });
  });
  const perQuestion = questions.slice().sort((a,b) => a.id - b.id).map(q => {
    let replied = 0, expired = 0, good = 0, bad = 0;
    answers.forEach(a => {
      const v = a.get(Number(q.id));
      if (!v) return;
      if (v.expired) expired++; else replied++;
      if (v.good) good++; else bad++;
    });
    const total = replied + expired;
    return [Number(q.id), String(q.text || ""), replied, expired, total,
      good, bad, total ? Math.round(good * 100 / total) : 0,
      total ? Math.round(bad * 100 / total) : 0];
  });
  const distribution = Array(7).fill(0);
  let complete = 0, sum = 0;
  answers.forEach(a => {
    if (a.size !== known.size) return;
    complete++;
    const score = Array.from(a.values()).filter(v => v.good).length;
    distribution[score]++;
    sum += score;
  });
  return {
    id, created: new Date(run[1]), statsAt: new Date(run[2]), status: String(run[3]),
    started: users.size, complete, incomplete: users.size - complete,
    average: complete ? Math.round(100 * sum / complete) / 100 : 0,
    perQuestion, distribution
  };
}

function buildMiniAdminReport() {
  miniRequireOwnerRun_(); // В публичном Web App такой вызов запрещён
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const props = miniProps_();
    const id = String(props.getProperty("MINI_REPORT_RUN_ID") ||
      props.getProperty("MINI_ACTIVE_RUN") || "").trim();
    const run = miniRows_(MINI.runSheet).find(x => String(x.v[0]) === id);
    if (!run) throw new Error("Не найден выпуск. Проверь MINI_ACTIVE_RUN.");
    const r = miniAdminStats_(run.v,
      miniRows_(MINI.peopleSheet), miniRows_(MINI.answersSheet));
    const book = miniSheetFile_();
    let sheet = book.getSheetByName(MINI_REPORT_TAB);
    if (sheet && String(sheet.getRange(1,1).getValue()) !== MINI_REPORT_MARKER)
      throw new Error("Лист «Мини_Отчёт» занят другими данными. Не перезаписываю.");
    if (!sheet) sheet = book.insertSheet(MINI_REPORT_TAB);
    sheet.clearContents();
    const format = x => Utilities.formatDate(x, MINI.tz, "dd.MM.yyyy HH:mm");
    const data = Array.from({length:30}, () => Array(9).fill(""));
    function put(n, vals) { vals.forEach((v,i) => { data[n-1][i] = v; }); }
    put(1, [MINI_REPORT_MARKER]);
    put(2, ["Выпуск", r.id, "", "Обновлено (МСК)", format(new Date())]);
    put(3, ["Начало выпуска", format(r.created), "", "Общая статистика с", format(r.statsAt)]);
    put(4, ["Статус", r.status === "ACTIVE" ? "Активный" : "Архивный"]);
    put(6, ["НАЧАЛИ", "", "ЗАВЕРШИЛИ", "", "НЕ ЗАВЕРШИЛИ", "", "СРЕДНИЙ БАЛЛ"]);
    put(7, [r.started, "", r.complete, "", r.incomplete, "", r.average]);
    put(9, ["ПО ВОПРОСАМ"]);
    put(10, ["№","Формулировка","Ответили","Время вышло","Оценено",
      "Верно","Неверно","Верно, %","Неверно, %"]);
    r.perQuestion.forEach((v,i) => put(11+i,v));
    put(18, ["РАСПРЕДЕЛЕНИЕ ИТОГОВЫХ БАЛЛОВ"]);
    put(19, ["Результат","Участников","Доля завершивших, %"]);
    r.distribution.forEach((v,i) => put(20+i,
      [i+"/6",v,r.complete ? Math.round(v*100/r.complete) : 0]));
    put(28, ["Проценты","Включают все оценённые попытки; истёкшее время — неверно."]);
    put(29, ["Баллы","В распределении только завершившие все шесть вопросов."]);
    put(30, ["Обновление","Повторный ручной запуск пересчитает отчёт. Рассылки нет."]);
    sheet.getRange(1,1,30,9).setValues(data);
    sheet.getRange(1,1,1,9).setBackground("#382d2a")
      .setFontColor("#ffffff").setFontWeight("bold");
    [9,18].forEach(n => sheet.getRange(n,1,1,9)
      .setBackground("#f0e1d5").setFontWeight("bold"));
    sheet.getRange(10,1,1,9).setBackground("#eadbd0").setFontWeight("bold");
    sheet.getRange(19,1,1,3).setBackground("#eadbd0").setFontWeight("bold");
    sheet.getRange(11,8,6,2).setNumberFormat('0"%"');
    sheet.getRange(20,3,7,1).setNumberFormat('0"%"');
    sheet.getRange(7,7).setNumberFormat("0.00");
    sheet.getRange(11,2,6,1).setWrap(true);
    sheet.setColumnWidth(2,340);
    sheet.setFrozenRows(10);
    SpreadsheetApp.flush();
    console.log("PASS: отчёт «Мини_Отчёт» готов; начали: "+r.started+
      "; завершили: "+r.complete+".");
  } finally { lock.releaseLock(); }
}
