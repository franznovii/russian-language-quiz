/**
 * вы́Читать — этап 3А: ПРОВЕРКА ПРИВАТНОГО КАНАЛА СВЯЗИ.
 *
 * ИЗОЛИРОВАННЫЙ ТЕСТ, НЕ КОД РАБОЧЕГО БОТА.
 * ВАЖНО: этот код заменяет Stage2-ReadOnly.gs в отдельном GAS-проекте
 * при испытании механизма; после теста включим фактическую логику квиза.
 *
 * GAS HtmlService внутри скрытого iframe использует google.script.run.
 * Это позволяет получить ответ от GAS без JSONP и CORS.
 * В тесте НЕТ токенов, Telegram ID, данных Google Sheets.
 *
 * Сайт может связываться с мостом только с разрешённых origin.
 */
const BRIDGE_ALLOWED_ORIGINS = [
  'https://franznovii.github.io',
  'https://quiz.libera.me'
];

function doGet(e) {
  return HtmlService.createHtmlOutput(buildBridgeHtml_())
    .setTitle('Проверка защищённого канала Mini App')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function bridgeEcho(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 200) {
    throw new Error('Bad request');
  }
  // Реальный backend будет проверять подпись Telegram
  // и возвращать данные только идентифицированному пользователю.
  return {ok: true, echo: value, processedBy: 'GAS HtmlService', timestamp: new Date().toISOString()};
}

function buildBridgeHtml_() {
  const allowed = JSON.stringify(BRIDGE_ALLOWED_ORIGINS).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' +
    '<script>' +
    'const allowedOrigins=' + allowed + ';' +
    'const requestOrigin=(new URL(document.referrer || "https://invalid.example/")).origin;' +
    'function accepted(origin){return allowedOrigins.indexOf(origin)!==-1;}' +
    'window.addEventListener("message", function(event){' +
      'if(!accepted(event.origin))return;' +
      'const msg=event.data||{};' +
      'if(msg.type!=="quizBridgeEcho" || typeof msg.requestId!=="string" || !/^[a-zA-Z0-9_-]{16,64}$/.test(msg.requestId))return;' +
      'google.script.run.withSuccessHandler(function(value){' +
        'window.top.postMessage({type:"quizBridgeResult",requestId:msg.requestId,data:value},event.origin);' +
      '}).withFailureHandler(function(err){' +
        'window.top.postMessage({type:"quizBridgeResult",requestId:msg.requestId,error:String(err.message||err)},event.origin);' +
      '}).bridgeEcho(msg.text);' +
    '});' +
    // Send to allowed origins. No data in ready event.
    'allowedOrigins.forEach(function(origin){window.top.postMessage({type:"quizBridgeReady"},origin);});' +
    '</script></body></html>';
}
