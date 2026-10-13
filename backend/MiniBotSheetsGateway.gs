/**
 * Административный мост Telegram ↔ Google Sheets.
 * Добавить отдельным файлом MiniBotSheetsGateway.gs в существующий
 * GAS-проект «Вычитать — Mini App» рядом с Код.gs.
 *
 * Требует в Код.gs одну строку в начале doPost(e):
 * if (e && String(e.parameter?.bot_admin || '') === '1') return miniBotGatewayHandle_(e);
 *
 * Script Properties: MINI_BOT_GATEWAY_KEY (случайный секрет 40+ символов).
 * В Cloudflare Worker: GAS_BRIDGE_URL (действующий GAS /exec URL) и
 * GAS_BRIDGE_KEY (то же значение, что MINI_BOT_GATEWAY_KEY).
 *
 * Секрет передаётся только в HTTPS POST body, а не в URL или логах.
 * Не конфликтует с прежним Telegram launcher / Mini App.
 */
function miniBotGatewaySecureEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  var mismatch = a.length ^ b.length;
  for (var i=0; i<Math.max(a.length,b.length); i++)
    mismatch |= (a.charCodeAt(i)||0) ^ (b.charCodeAt(i)||0);
  return mismatch === 0;
}
function miniBotGatewayHandle_(e) {
  function json(x) {
    return ContentService.createTextOutput(JSON.stringify(x))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var expected = String(props.getProperty('MINI_BOT_GATEWAY_KEY') || '');
    var body = JSON.parse(String(e && e.postData && e.postData.contents || ''));
    if (expected.length < 32 || !miniBotGatewaySecureEqual_(body.key, expected))
      return json({ok:false,error:'Forbidden'});
    if (body.action === 'prepare') {
      var questions = miniReadQuestions_();
      if (questions.some(function(q) {
        return [q.description,q.text,q.explanation].concat(q.options).some(function(s) {
          return /бла\s+бла|lorem\s+ipsum/i.test(String(s||''));
        });
      })) throw new Error('В вопросах остались тестовые формулировки.');
      return json({ok:true,questions:questions,comments:miniBotGatewayReadComments_()});
    }
    if (body.action === 'saveStats')
      return json(miniBotGatewaySaveStats_(body.report));
    return json({ok:false,error:'Неизвестная операция'});
  } catch(err) {
    console.error('MiniBotGateway: '+String(err && err.message || err));
    return json({ok:false,error:String(err && err.message || 'Ошибка обработки')});
  }
}
function miniBotGatewayReadComments_() {
  var sheet = miniSheetFile_().getSheetByName('Мини_Комментарии');
  if (!sheet) throw new Error('Нет листа «Мини_Комментарии».');
  var headers = sheet.getRange(1,1,1,4).getDisplayValues()[0];
  if (String(headers[0]).indexOf('Балл') !== 0 ||
      String(headers[2]).indexOf('Комментарий') !== 0)
    throw new Error('Изменились заголовки листа «Мини_Комментарии» A:D.');
  var result = [[],[],[],[],[],[],[]];
  var last = sheet.getLastRow();
  if (last <= 1) throw new Error('Лист комментариев пуст.');
  var rows = sheet.getRange(2,1,last-1,4).getDisplayValues();
  rows.forEach(function(r,i) {
    if (r.every(function(v){return !String(v).trim()})) return;
    var score = Number(String(r[0]).trim());
    var message = String(r[2] || '').trim();
    var enabled = String(r[3] || 'ДА').trim().toUpperCase();
    if (!Number.isInteger(score) || score<0 || score>6)
      throw new Error('Неверный балл в строке '+(i+2));
    if (enabled==='НЕТ') return;
    if (enabled!=='ДА') throw new Error('В D'+(i+2)+' должно быть ДА или НЕТ.');
    if (!message || message.length>700)
      throw new Error('Комментарий в строке '+(i+2)+' должен содержать от 1 до 700 символов.');
    if (!result[score].includes(message)) result[score].push(message);
  });
  result.forEach(function(items,score) {
    if (!items.length) throw new Error('Не найден активный комментарий для '+score+'/6.');
    if (items.length>30) throw new Error('Не больше 30 комментариев на один балл.');
  });
  return result;
}
function miniBotGatewaySaveStats_(r) {
  if (!r || r.ok!==true || !/^timed_[a-zA-Z0-9-]{10,80}$/.test(String(r.runId||'')) ||
      !Number.isInteger(r.started) || !Number.isInteger(r.completed) ||
      !Number.isInteger(r.incomplete) || r.started!==r.completed+r.incomplete ||
      !Array.isArray(r.perQuestion) || r.perQuestion.length!==6 ||
      !Array.isArray(r.distribution) || r.distribution.length!==7 ||
      r.distribution.some(function(x){return !Number.isInteger(x)||x<0}) ||
      r.distribution.reduce(function(a,b){return a+b},0)!==r.completed)
    throw new Error('Сервер передал некорректную статистику.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var book = miniSheetFile_();
    var sheet = book.getSheetByName('Cloudflare_Отчёт');
    if (!sheet) throw new Error('Лист «Cloudflare_Отчёт» не найден.');
    var marker = 'вы́Читать · Отчёт Cloudflare';
    if (String(sheet.getRange(1,1).getDisplayValue())!==marker)
      throw new Error('Лист «Cloudflare_Отчёт» занят другими данными. Не перезаписываю.');
    var updated = Utilities.formatDate(new Date(),'Europe/Moscow','dd.MM.yyyy HH:mm');
    var table = Array.from({length:27},function(){return Array(9).fill('')});
    function set(n,a) {a.forEach(function(v,i){table[n-1][i]=v})}
    set(1,[marker]);
    set(2,['Выпуск',r.runId,'','Обновлено (МСК)',updated]);
    set(3,['Статистика доступна',r.statisticsAt]);
    set(6,['НАЧАЛИ','','ЗАВЕРШИЛИ','','НЕ ЗАВЕРШИЛИ','','СРЕДНИЙ БАЛЛ']);
    set(7,[r.started,'',r.completed,'',r.incomplete,'',r.average===null?'—':r.average]);
    set(9,['ПО ВОПРОСАМ']);
    set(10,['№','Формулировка','Ответили','Время вышло','Оценено',
      'Верно','Неверно','Верно, %','Неверно, %']);
    r.perQuestion.forEach(function(q,i) {
      set(11+i,[q.questionId,q.question,q.answered,q.expired,q.total,
        q.correct,q.incorrect,q.correctPercent,q.incorrectPercent]);
    });
    set(18,['РАСПРЕДЕЛЕНИЕ ИТОГОВЫХ БАЛЛОВ']);
    set(19,['Результат','Участников','Доля завершивших, %']);
    r.distribution.forEach(function(v,i) {
      set(20+i,[i+'/6',v,r.completed?Math.round(100*v/r.completed):0]);
    });
    sheet.getRange(1,1,27,9).setValues(table);
    sheet.getRange(11,8,6,2).setNumberFormat('0"%"');
    sheet.getRange(20,3,7,1).setNumberFormat('0"%"');
    sheet.getRange(7,7).setNumberFormat('0.00');
    SpreadsheetApp.flush();
    // Ответ строится именно из записанных ячеек, а не из входного JSON.
    var header = sheet.getRange(7,1,1,7).getValues()[0];
    return {ok:true,runId:String(sheet.getRange('B2').getDisplayValue()),
      updatedAt:String(sheet.getRange('E2').getDisplayValue()),
      started:Number(header[0]),completed:Number(header[2]),
      incomplete:Number(header[4]),average:header[6],
      distribution:sheet.getRange(20,2,7,1).getValues().map(function(a){return Number(a[0])})};
  } finally {lock.releaseLock()}
}
