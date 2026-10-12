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
  if(check.placeholderCount>0)console.warn('СТОП! В текущем выпуске тестовые вопросы.');
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
  if(check.placeholderCount||check.questionCount!==6)
    throw new Error('В активном выпуске тестовые или неполные вопросы. Публикация запрещена.');
  if(check.launchUrl!==CF_RELEASE_PAGE_URL)
    throw new Error('Worker направляет на другую страницу. Сначала обнови Worker.');
  if(check.accessMode!=='public')
    throw new Error('Сначала в Cloudflare установи ACCESS_MODE=public.');
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
  if(!check.invitationsEnabled)
    throw new Error('В Worker INVITES_ENABLED ещё не yes.');
  const r=cfAdminCall_('sendInvitations',{limit:20});
  console.log('Приглашено: '+r.sent+', заблокировали бота: '+r.blocked+', ошибок: '+r.errors);
  return r;
}
