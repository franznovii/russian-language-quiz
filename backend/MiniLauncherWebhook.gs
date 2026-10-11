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
  try{
    const secret=String(miniProps_().getProperty("MINI_LAUNCHER_WEBHOOK_KEY")||"");
    if(secret.length<32 || !e || !e.parameter ||
        String(e.parameter.mini_key||"")!==secret){
      console.warn("Mini launcher: rejected unverified update");
      return ContentService.createTextOutput("ok");
    }
    const update=JSON.parse(String(e.postData?.contents||""));
    const message=update?.message;
    if(!message || message.chat?.type!=="private" ||
      !/^\/start(?:\s+[A-Za-z0-9_-]{1,64})?\s*$/.test(String(message.text||"")))
      return ContentService.createTextOutput("ok");
    const user=message.from,chat=message.chat;
    if(!user || !Number.isSafeInteger(user.id) || !chat || chat.id!==user.id)
      return ContentService.createTextOutput("ok");
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
  }catch(error){
    console.warn("Mini launcher: "+String(error.message||error)
      .replace(String(miniProps_().getProperty("BOT_TOKEN")||""),"[TOKEN]"));
  }
  return ContentService.createTextOutput("ok");
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
    drop_pending_updates:false
  });
  console.log("PASS: Telegram /start теперь обслуживает новый launcher; "+
    "старые команды перестали поступать в прежний GAS.");
}
