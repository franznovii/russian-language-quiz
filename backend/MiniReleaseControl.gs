/**
 * «вы́Читать» — ручной выпуск финальной Mini App.
 * Установить отдельным файлом в GAS-проект «Вычитать — Mini App».
 * НИЧЕГО не запускается при установке.
 * Нужен Worker из backend/vychitat-worker-release.js.
 *
 * Переключение webhook / меню / приглашений требует предварительного
 * Script Property CF_RELEASE_APPROVED=YES и отдельного ручного запуска.
 */
const CF_RELEASE_PAGE_URL = 'https://franznovii.github.io/russian-language-quiz/quiz.html';

function cfReleasePreflight() {
  miniRequireOwnerRun_();
  const check=cfAdminCall_('preflight',{});
  console.log('Выпуск: '+check.runId);
  console.log('Ссылка: '+check.launchUrl);
  console.log('Бот: @'+check.botUsername);
  console.log('Тестовые описания: '+check.placeholderCount);
  console.log('Доступ: '+check.accessMode);
  console.log('Webhook: '+(check.webhookUrl||'не задан'));
  console.log('Приглашения: '+check.invitationsEnabled);
  console.log('Недельный цикл: '+check.weeklyEnabled);
  console.log('Готовность к публикации: '+check.readyForPublic);
  console.log('Общее меню: '+check.globalMenuReady);
  console.log('Личное меню: '+check.privateMenuReady);
  if(check.webhookLastError)console.warn('Telegram сообщает об ошибке доставки webhook: '+check.webhookLastError);
  if(check.placeholderCount>0)console.warn('СТОП для публичного режима: в выпуске тестовые вопросы.');
  return check;
}

/** Отправляет личную кнопку на ФИНАЛЬНУЮ страницу, без переключений. */
function cfReleaseSendSelfButton() {
  miniRequireOwnerRun_();
  const props=PropertiesService.getScriptProperties();
  const token=String(props.getProperty('BOT_TOKEN')||'').trim();
  const id=String(props.getProperty('TEST_CHAT_ID')||'').trim();
  if(!token||!/^[1-9]\d{4,19}$/.test(id))
    throw new Error('Проверь BOT_TOKEN и TEST_CHAT_ID в свойствах проекта.');
  const response=UrlFetchApp.fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
    method:'post',contentType:'application/json',muteHttpExceptions:true,
    payload:JSON.stringify({
      chat_id:id,
      text:'«вы́Читать» · Финальная версия. Личная проверка перед запуском.',
      reply_markup:{inline_keyboard:[[{text:'Открыть финальный тест',
        web_app:{url:CF_RELEASE_PAGE_URL}}]]}
    })
  });
  let data;
  try {data=JSON.parse(response.getContentText())}
  catch(e){throw new Error('Ответ Telegram не JSON; HTTP '+response.getResponseCode())}
  if(!data.ok)throw new Error('Не удалось отправить личную кнопку; HTTP '+response.getResponseCode());
  console.log('Финальная тестовая кнопка отправлена только владельцу.');
}

function cfReleaseRequireApproval_(){
  miniRequireOwnerRun_();
  if(String(PropertiesService.getScriptProperties()
    .getProperty('CF_RELEASE_APPROVED')||'').trim()!=='YES')
    throw new Error('Публикация запрещена. Для осознанного запуска добавь в Script Properties CF_RELEASE_APPROVED=YES');
  const check=cfAdminCall_('preflight',{});
  if(check.questionCount!==6)throw new Error('В текущем выпуске не шесть вопросов.');
  if(check.launchUrl!==CF_RELEASE_PAGE_URL)
    throw new Error('Worker направляет на другую страницу. Сначала обнови Worker.');
  if(check.botUsername!=='posttsop_test_bot')
    throw new Error('В Worker настроен не тот Telegram-бот. Проверь BOT_TOKEN.');
  if(check.accessMode!=='pilot'&&check.accessMode!=='public')
    throw new Error('ACCESS_MODE должен быть pilot или public.');
  if(check.accessMode==='public'&&!check.readyForPublic)
    throw new Error('Выпуск содержит тестовые формулировки. Публичный доступ запрещён.');
  return check;
}

/**
 * ЯВНОЕ ПЕРЕКЛЮЧЕНИЕ: от старого webhook на Cloudflare Worker.
 * Выполнять только после контрольного запуска и проверки шести вопросов.
 */
function cfReleaseSwitchWebhook() {
  cfReleaseRequireApproval_();
  // Save the current endpoint privately for rollback. NEVER log its URL:
  // an old GAS webhook may include a secret in a query parameter.
  const props=PropertiesService.getScriptProperties();
  if(!props.getProperty('CF_PREVIOUS_WEBHOOK_URL')){
    const token=String(props.getProperty('BOT_TOKEN')||'').trim();
    if(!token)throw new Error('Не настроен BOT_TOKEN');
    const response=UrlFetchApp.fetch('https://api.telegram.org/bot'+token+'/getWebhookInfo',{
      muteHttpExceptions:true
    });
    let info;
    try{info=JSON.parse(response.getContentText())}
    catch(e){throw new Error('Не удалось получить предыдущий webhook')}
    if(!info.ok)throw new Error('Не удалось проверить предыдущий webhook Telegram');
    const url=String(info.result?.url||'');
    if(url&&url!=='https://vychitat.fr-novii.workers.dev/telegram')
      props.setProperty('CF_PREVIOUS_WEBHOOK_URL',url);
  }
  const r=cfAdminCall_('configureWebhook',{});
  console.log('Telegram webhook переключён на Cloudflare: '+r.webhook);
  return r;
}

/** Устанавливает кнопку Telegram-меню на финальную страницу. */
function cfReleaseSwitchMenu() {
  const check=cfReleaseRequireApproval_();
  if(check.webhookUrl!=='https://vychitat.fr-novii.workers.dev/telegram')
    throw new Error('Сначала переключи webhook функцией cfReleaseSwitchWebhook.');
  const r=cfAdminCall_('configureMenu',{});
  console.log('Меню Telegram переключено на финальный интерфейс.');
  return r;
}

/**
 * Отправляет максимум 20 приглашений из сохранённых контактов.
 * Не запускать до подтверждения webhook и меню.
 */
function cfReleaseInvite20() {
  const check=cfReleaseRequireApproval_();
  if(check.webhookUrl!=='https://vychitat.fr-novii.workers.dev/telegram')
    throw new Error('Webhook ещё не переключён. Приглашения не отправлены.');
  if(check.accessMode!=='public')
    throw new Error('Приглашения запрещены в пилотном режиме.');
  if(!check.invitationsEnabled)
    throw new Error('В Worker INVITES_ENABLED ещё не yes.');
  const r=cfAdminCall_('sendInvitations',{limit:20});
  console.log('Приглашено: '+r.sent+', заблокировали бота: '+r.blocked+', ошибок: '+r.errors);
  return r;
}


/**
 * Закончить тестирование в закрытом режиме без переключения глобального меню.
 * Запускать только после ручного подтверждения CF_RELEASE_APPROVED=YES.
 * 1. Сохраняет старый webhook в Script Properties.
 * 2. Переключает /start на Worker.
 * 3. Настраивает личное меню ТОЛЬКО владельцу.
 */
function cfReleaseInstallPrivatePilot() {
  const ready=cfReleaseRequireApproval_();
  if(ready.accessMode!=='pilot')throw new Error('Этот запуск только для ACCESS_MODE=pilot.');
  const hook=cfReleaseSwitchWebhook();
  const menu=cfReleaseSwitchMenu();
  console.log('Личный пилот установлен: /start через Cloudflare, меню только для владельца.');
  return {webhook:hook.webhook,menu:menu.mode};
}

/**
 * Финальная проверка публикации. Не изменяет сервер и меню.
 * Работает и в pilot, и в public.
 */
function cfReleaseCheck() {
  return cfReleasePreflight();
}

/**
 * Выпустить новый еженедельный тест.
 * 1. Читает ВСЕ 6 вопросов из листа «Мини_Вопросы».
 * 2. Проверяет тестовые фразы «бла бла» и lorem ipsum.
 * 3. Загружает новый черновик в D1.
 * 4. Активирует выпуск с правилом «один набор — один выпуск».
 * Не сбрасывает архив, не меняет меню или webhook.
 * НЕ рассылает приглашения — это отдельное решение владельца.
 *
 * ВНИМАНИЕ: в публичном режиме создание выпуска мгновенно делает его
 * видимым всем участникам. Запускай ТОЛЬКО когда всё готово!
 */
function cfPublishWeeklyQuiz() {
  miniRequireOwnerRun_();
  const questions=miniReadQuestions_();
  if(questions.length!==6)
    throw new Error('В листе «Мини_Вопросы» должно быть шесть вопросов.');
  if(questions.some(q=>[q.description,q.text,q.explanation,...q.options].some(
      x=>/бла\s+бла|lorem\s+ipsum/i.test(String(x||'')))))
    throw new Error('Найден тестовый текст «бла бла» / lorem ipsum — сначала замени вопросы.');
  const check=cfAdminCall_('preflight',{});
  if(check.launchUrl!==CF_RELEASE_PAGE_URL)
    throw new Error('Загружена старая версия Worker. Сначала обнови сервер.');
  if(check.botUsername!=='posttsop_test_bot')
    throw new Error('Неверный бот. Проверь BOT_TOKEN.');
  if(check.accessMode!=='pilot'&&check.accessMode!=='public')
    throw new Error('Недопустимый режим ACCESS_MODE.');
  const staged=cfAdminCall_('stage',{questions});
  if(staged.questionCount!==6)
    throw new Error('Cloudflare не подтвердил сохранение всех вопросов.');
  const result=cfAdminCall_('activate',{});
  if(!result.created)
    throw new Error('Новый выпуск НЕ создан: вопросы полностью совпадают с активными. Действующий выпуск не затронут.');
  console.log('НОВЫЙ ВЫПУСК: '+result.runId);
  console.log('Участникам видны новые задания (если ACCESS_MODE=public).');
  console.log('Статистика станет доступна сегодня после 19:00 МСК.');
  return result;
}

/**
 * Переключить ГЛОБАЛЬНОЕ меню при запуске настоящего выпуска.
 * Запускать когда ACCESS_MODE=public, текущий выпуск готов,
 * webhook установлен в Cloudflare.
 */
function cfReleasePublishMenu() {
  const check=cfReleaseRequireApproval_();
  if(check.accessMode!=='public'||!check.readyForPublic)
    throw new Error('Публичный режим или настоящие вопросы ещё не готовы.');
  return cfReleaseSwitchMenu();
}
