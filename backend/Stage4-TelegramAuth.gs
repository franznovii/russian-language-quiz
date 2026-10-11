/**
 * вы́Читать / Mini App — этап 4, проверка Telegram initData.
 * ИЗОЛИРОВАННЫЙ ТЕСТ. НЕ заменять им скрипт действующего бота.
 *
 * Установить только в отдельном проекте GAS «Вычитать — Mini App».
 * Свойства скрипта:
 *   BOT_TOKEN  = токен ТОГО ЖЕ бота, из которого запускается Mini App.
 *
 * НЕ помещать токен в GitHub, таблицу, параметры URL, HTML или переписку.
 *
 * doGet -> GAS HtmlService iframe; вызов bridgeWhoAmI(initData) проверяет
 * HMAC-SHA-256 сервером; имя подтверждается и возвращается родительскому окну.
 *
 * Не читает и не изменяет Google Sheets, не вызывает Telegram Bot API,
 * не сохраняет данные пользователей.
 */

const MINIAPP_ALLOWED_ORIGINS = Object.freeze([
  "https://franznovii.github.io",
  "https://quiz.libera.me"
]);
const MAX_INITDATA_LENGTH = 12000;
const INITDATA_MAX_AGE_SECONDS = 6 * 60 * 60;

function doGet(e) {
  return HtmlService.createHtmlOutput(telegramAuthBridgeHtml_())
    .setTitle("Telegram Mini App — проверка пользователя")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function telegramAuthBridgeHtml_() {
  const domains = JSON.stringify(MINIAPP_ALLOWED_ORIGINS).replace(/</g, "\\u003c");
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body>' +
    '<script>' +
    'const allowedOrigins=' + domains + ';' +
    'window.addEventListener("message",function(event){' +
      'if(allowedOrigins.indexOf(event.origin)===-1)return;' +
      'const message=event.data||{};' +
      'if(message.type!=="quizAuthRequest"||' +
      'typeof message.requestId!=="string"||' +
      '!/^[a-zA-Z0-9_-]{16,64}$/.test(message.requestId))return;' +
      'google.script.run.withSuccessHandler(function(result){' +
        'window.parent.postMessage({type:"quizAuthResult",' +
          'requestId:message.requestId,result:result},event.origin);' +
      '}).withFailureHandler(function(){' +
        'window.parent.postMessage({type:"quizAuthResult",' +
          'requestId:message.requestId,result:{ok:false,error:"Сбой GAS"}},event.origin);' +
      '}).bridgeWhoAmI(message.initData);' +
    '});' +
    'allowedOrigins.forEach(function(origin){' +
      'window.parent.postMessage({type:"quizAuthReady"},origin);' +
    '});' +
    '</script></body></html>';
}

/**
 * Единственный серверный метод, вызываемый фронтендом.
 * Никогда не доверяет Telegram.WebApp.initDataUnsafe или ID из браузера.
 */
function bridgeWhoAmI(initData) {
  try {
    const token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
    if (!token) {
      return {ok: false, error: "Сначала установи BOT_TOKEN в свойствах нового GAS."};
    }
    const identity = verifyTelegramInitData_(initData, token, Math.floor(Date.now() / 1000));
    return {ok: true, name: String(identity.first_name || "Участник").slice(0, 80)};
  } catch (e) {
    // Подробности можно смотреть в GAS Executions. Токен и initData не логируем.
    console.warn("Telegram initData не прошла серверную проверку: " + String(e.message));
    return {ok: false, error: "Не удалось подтвердить данные Telegram. Открой приложение из бота."};
  }
}

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

/**
 * Локальный тест в редакторе GAS. Подписывает искусственную initData
 * установленным в свойствах BOT_TOKEN и проверяет:
 * 1) подлинный запрос принят;
 * 2) изменение user отклонено.
 *
 * Важно: этот тест проверяет алгоритм; реальный Telegram проверим позже.
 * После завершения показывает только PASS/FAIL, без токена/ID/подписи.
 */
function runAuthSelfTest() {
  const token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN");
  if (!token) throw new Error("Установи BOT_TOKEN в свойствах скрипта");
  const now = Math.floor(Date.now() / 1000);
  const original = 'auth_date=' + now +
    '&user=' + encodeURIComponent(JSON.stringify({id: 123456789, first_name: "Проверка"}));
  const checkString = 'auth_date=' + now + '\nuser={"id":123456789,"first_name":"Проверка"}';
  const secret = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(token).getBytes(), Utilities.newBlob("WebAppData").getBytes()
  );
  const hash = Utilities.computeHmacSha256Signature(
    Utilities.newBlob(checkString).getBytes(), secret
  ).map(b => ("0" + ((b + 256) % 256).toString(16)).slice(-2)).join("");
  const signed = original + '&hash=' + hash;
  const good = verifyTelegramInitData_(signed, token, now);
  if (good.id !== 123456789) throw new Error("FAIL: проверка своей подписи");
  let tamperRejected = false;
  try {
    verifyTelegramInitData_(signed.replace("123456789", "123456788"), token, now);
  } catch (_) {
    tamperRejected = true;
  }
  if (!tamperRejected) throw new Error("FAIL: подменённые данные были приняты");
  console.log("PASS: подпись проверена, изменённые данные отклонены.");
}
