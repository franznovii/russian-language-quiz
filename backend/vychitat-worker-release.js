/**
 * вы́Читать Mini App — Cloudflare Workers + D1, migration candidate, 12.10.2026
 * Compatibility with GAS timed Mini App `pilot-timed.html` (actions state/open/answer/expire/share/checkSubscription).
 * ENV D1: DB; secrets: BOT_TOKEN, ADMIN_KEY (>=32 chars), TEST_CHAT_ID, WEBHOOK_SECRET;
 * ENV optional: ACCESS_MODE=pilot|public (defaults pilot), INVITES_ENABLED=yes|no, WEEKLY_ENABLED=yes|no.
 * Source questions staged via POST /admin {action:'stage',questions:[...]}; activate via action:'activate'.
 * NO setWebhook occurs automatically. Existing GAS installation remains unaffected until deliberate switchover.
 * Recommended Tuesday stats Cron: every 5 minutes during 16:00–21:59 UTC.
 * Optional auto-edition: 0 7 * * 2 [Tuesday 10:00 Moscow; UTC; only when WEEKLY_ENABLED=yes].
 */
const QCOUNT = 6;
const BASE_PAGE = 'https://quiz.libera.me/quiz.html';
const ORIGINS = new Set(['https://quiz.libera.me']);
const CHANNEL = '@posttsop';
const BOT_LINK = 'https://t.me/posttsop_test_bot?startapp';
const WEBHOOK_ENDPOINT = 'https://vychitat.fr-novii.workers.dev/telegram';
const PLACEHOLDER_PATTERN = /бла\s+бла|lorem\s+ipsum/i;
function draftIsReady(questions) {
  return Array.isArray(questions) && questions.length===QCOUNT &&
    questions.every(q=>[q.description,q.text,...q.options,q.explanation]
      .every(x=>typeof x==='string' && !PLACEHOLDER_PATTERN.test(x)));
}
function isPilot(env){return String(env.ACCESS_MODE||'pilot').toLowerCase()==='pilot';}
function isPublic(env){return String(env.ACCESS_MODE||'pilot').toLowerCase()==='public';}

const encoder = new TextEncoder();

function replyJSON(data, status = 200, origin = '') {
  const headers = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff'};
  if (ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  return new Response(JSON.stringify(data), {status, headers});
}
function authEqual(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let result = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length,b.length); i++) result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return result === 0;
}
function err(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function timestamp() { return Math.floor(Date.now()/1000); }
function moscowDay(ms=Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Moscow', year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function statsAtForToday() { return Math.floor(Date.parse(`${moscowDay()}T19:00:00+03:00`)/1000); }
function statsAtLabel(s) { return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(s*1000).replace(',',''); }

async function telegram(env, method, data) {
  if (!env.BOT_TOKEN) throw err('Не настроен BOT_TOKEN', 503);
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)
  });
  const answer = await response.json().catch(()=>null);
  if (!response.ok || !answer?.ok) throw err(`Telegram ${method}: ${answer?.error_code||response.status}`,502);
  return answer.result;
}
async function telegramUser(raw, token) {
  if (typeof raw !== 'string' || !raw || raw.length > 12000 || !token) throw err('Нет данных авторизации Telegram',401);
  const params = new URLSearchParams(raw); const fields = new Map();
  let count = 0;
  for (const [k,v] of params.entries()) {
    count++;
    if (!/^[a-z][a-z0-9_]*$/.test(k) || fields.has(k) || count > 40) throw err('Некорректные данные авторизации',401);
    fields.set(k,v);
  }
  const hash = fields.get('hash');
  if (!/^[a-f0-9]{64}$/.test(hash||'')) throw err('Отсутствует подпись Telegram',401);
  const authDate = fields.get('auth_date');
  if (!/^\d{10}$/.test(authDate||'') || Number(authDate)>timestamp()+60 || timestamp()-Number(authDate)>21600) throw err('Время авторизации истекло',401);
  const text = [...fields.entries()].filter(([k])=>k!=='hash').sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>`${k}=${v}`).join('\n');
  const seed = await crypto.subtle.importKey('raw',encoder.encode('WebAppData'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const derived = await crypto.subtle.sign('HMAC',seed,encoder.encode(token));
  const secret = await crypto.subtle.importKey('raw',derived,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest = await crypto.subtle.sign('HMAC',secret,encoder.encode(text));
  const actual = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if (!authEqual(hash,actual)) throw err('Подпись Telegram не совпадает',401);
  let user;
  try { user=JSON.parse(fields.get('user')||''); } catch { throw err('Данные пользователя Telegram повреждены',401); }
  if (!Number.isSafeInteger(user?.id) || user.id<=0) throw err('Некорректный идентификатор пользователя',401);
  return user;
}

/**
 * Browser fallback: a signed, anonymous negative participant ID.
 * Positive IDs belong to real Telegram users; negative IDs are browser-only.
 * HMAC is derived from the existing server-side BOT_TOKEN and never exposed.
 * Browser storage is only a convenience: clearing it creates a new identity.
 */
const BROWSER_SESSION_DAYS=365;
async function browserSessionSignature(env,participantId,issuedAt) {
  if(!env.BOT_TOKEN)throw err('Не настроен BOT_TOKEN',503);
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.BOT_TOKEN),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const input=encoder.encode('vychitat-browser-v1|'+participantId+'|'+issuedAt);
  const signature=await crypto.subtle.sign('HMAC',key,input);
  return [...new Uint8Array(signature)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function createBrowserSession(env) {
  if(!isPublic(env))throw err('Браузерный режим доступен только в публичном выпуске',403);
  const run=await activeEdition(env.DB);
  if(!draftIsReady(run.questions))throw err('Выпуск ещё готовится',503);
  // 48-bit signed-safe random identifier, disjoint from positive Telegram IDs.
  const random=crypto.randomUUID().replaceAll('-','').slice(0,12);
  const participantId=-Math.max(1,Number.parseInt(random,16));
  const issuedAt=timestamp();
  const signed=await browserSessionSignature(env,participantId,issuedAt);
  return {ok:true,browserToken:'b1.'+participantId+'.'+issuedAt+'.'+signed,
    expiresAt:issuedAt+BROWSER_SESSION_DAYS*86400};
}
async function browserUser(env,token) {
  if(!isPublic(env))throw err('Браузерный режим недоступен',403);
  if(typeof token!=='string'||token.length>140)
    throw err('Нет браузерной сессии',401);
  const m=/^b1\.(-[1-9]\d{0,14})\.(\d{10})\.([a-f0-9]{64})$/.exec(token);
  if(!m)throw err('Браузерная сессия недействительна',401);
  const id=Number(m[1]),issued=Number(m[2]);
  if(!Number.isSafeInteger(id)||id>=0||issued>timestamp()+60||
     issued<timestamp()-BROWSER_SESSION_DAYS*86400)
    throw err('Срок браузерной сессии истёк',401);
  const expected=await browserSessionSignature(env,id,issued);
  if(!authEqual(m[3],expected))throw err('Неверная подпись браузерной сессии',401);
  return {id,first_name:'Гость',isBrowser:true};
}

function validateQuestions(input) {
  if (!Array.isArray(input)||input.length!==QCOUNT) throw err('Нужно ровно шесть вопросов');
  const seen = new Set();
  const list = input.map(q=>{
    const id=Number(q.id), options=q.options, correct=q.correct;
    const seconds=q.timeSeconds===undefined||q.timeSeconds===null||q.timeSeconds===''?60:Number(q.timeSeconds);
    if (!Number.isInteger(id)||id<1||id>6||seen.has(id)||typeof q.text!=='string'||!q.text.trim()||
      typeof q.description!=='string'||typeof q.explanation!=='string'||
      !Array.isArray(options)||options.length<2||options.length>10||
      options.some(o=>typeof o!=='string'||!o.trim()||o.length>250)||
      !Array.isArray(correct)||!correct.length||
      correct.some(i=>!Number.isInteger(i)||i<0||i>=options.length)||
      new Set(correct).size!==correct.length||!Number.isInteger(seconds)||seconds<15||seconds>300||
      q.text.length>2000||q.description.length>10000||q.explanation.length>2000)
      throw err('Некорректный вопрос №'+id);
    seen.add(id);
    return {id,description:q.description,text:q.text,options,correct:[...correct].sort((a,b)=>a-b),explanation:q.explanation,timeSeconds:seconds};
  });
  return list.sort((a,b)=>a.id-b.id);
}


function validateResultComments(input) {
  if(!Array.isArray(input)||input.length!==7) throw err('Нужно семь групп комментариев для баллов 0–6');
  return input.map((group,score)=>{
    if(!Array.isArray(group)||!group.length||group.length>30||
       group.some(v=>typeof v!=='string'||!v.trim()||v.length>700)||
       new Set(group).size!==group.length) throw err('Проверь комментарии для '+score+'/6');
    return group.map(x=>x.trim());
  });
}
async function commentForResult(db,run,user,score) {
  try {
    const row=await db.prepare('SELECT messages_json FROM mini_result_comments WHERE run_id=? AND score=?')
      .bind(run.id,score).first();
    if(!row)return null;
    const choices=JSON.parse(row.messages_json);
    if(!Array.isArray(choices)||!choices.length)return null;
    const seed=run.id+':'+String(user.id)+':'+score;
    let hash=2166136261;
    for(let i=0;i<seed.length;i++) hash=Math.imul(hash^seed.charCodeAt(i),16777619)>>>0;
    return choices[hash%choices.length];
  }catch(e){
    // Старые выпуски без таблицы комментариев используют штатный текст.
    console.warn('Result comments unavailable:',String(e.message));
    return null;
  }
}
// Один источник текста для экрана результата и сообщения другу.
// Для исторических выпусков без сохранённых в D1 комментариев оставляем
// прежние семь формулировок Mini App.
const DEFAULT_RESULT_JOKES = Object.freeze([
  'Ты последовательно отстаивал альтернативную орфографию.',
  'Один правильный ответ. Остальные пока в авторской редакции.',
  'Между тобой и русским языком есть искра. Пока в основном от трения.',
  'Половина тебя — корректор. Вторая половина мешает ему работать.',
  'Две ошибки оставлены специально, чтобы редактору было чем заняться.',
  'Одна ошибка — это уже не безграмотность, а сюжетный поворот.',
  'Всё правильно. Теперь можешь исправлять админа.'
]);
async function resultTextForScore(db,run,user,score) {
  return await commentForResult(db,run,user,score) || DEFAULT_RESULT_JOKES[score] || 'Выпуск завершён.';
}
function escapeTelegramHTML(value) {
  return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function googleBridge(env,action,extra={}) {
  const target=String(env.GAS_BRIDGE_URL||'').trim(),key=String(env.GAS_BRIDGE_KEY||'');
  if(!target.startsWith('https://script.google.com/macros/s/')||!target.endsWith('/exec')||key.length<32)
    throw err('Не настроен мост к Google Sheets (GAS_BRIDGE_URL / GAS_BRIDGE_KEY)',503);
  const u=new URL(target);
  u.searchParams.set('bot_admin','1');
  // Сохранение отчёта идемпотентно: если GAS выполнил запись, но Google
  // вернул HTML/пустой ответ вместо JSON, можно повторить запрос один раз.
  // Операцию подготовки выпуска не повторяем, чтобы избежать побочных эффектов.
  const attempts=action==='saveStats'?2:1;
  for(let attempt=0;attempt<attempts;attempt++){
    const response=await fetch(u.toString(),{method:'POST',
      headers:{'content-type':'text/plain;charset=utf-8'},
      body:JSON.stringify({action,key,...extra}),redirect:'follow'});
    if(!response.ok)throw err('Google Sheets: HTTP '+response.status,502);
    const bodyText=await response.text();
    let data=null;
    try{data=JSON.parse(bodyText.replace(/^\uFEFF/,''));}catch(_){}
    if(data?.ok===true)return data;
    if(data?.ok===false)throw err('Google Sheets: '+String(data.error||'ошибка выполнения'),502);
    // Никогда не пишем HTML ответа GAS или секреты в логи.
    console.warn('GAS returned non-JSON response for '+action+
      '; content-type='+String(response.headers.get('content-type')||'unknown').slice(0,90)+
      '; attempt='+(attempt+1));
  }
  throw err('Google Sheets: некорректный ответ',502);
}

async function activeEdition(db) {
  const row = await db.prepare("SELECT run_id,stats_after,questions_snapshot_json FROM mini_editions WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1").first();
  if (!row) throw err('Пока нет активного выпуска',409);
  const questions=JSON.parse(row.questions_snapshot_json);
  return {id:row.run_id,statsAt:Number(row.stats_after),questions};
}
async function join(db,run,user) {
  await db.prepare('INSERT OR IGNORE INTO mini_participants(run_id,telegram_id,first_name) VALUES(?,?,?)')
    .bind(run.id,String(user.id),String(user.first_name||'').slice(0,80)).run();
}
async function answersFor(db,run,user) {
  const q=await db.prepare('SELECT question_no,selected_json,correct FROM mini_answers WHERE run_id=? AND telegram_id=? ORDER BY question_no')
    .bind(run.id,String(user.id)).all();
  return q.results||[];
}
async function currentTimer(db,run,user,q) {
  return db.prepare('SELECT deadline_at FROM mini_timers WHERE run_id=? AND telegram_id=? AND question_no=?')
    .bind(run.id,String(user.id),q.id).first();
}
async function expireIfDue(db,run,user) {
  const answers=await answersFor(db,run,user);
  const next=run.questions[answers.length];
  if (!next) return;
  const timer=await currentTimer(db,run,user,next);
  if (timer&&Number(timer.deadline_at)<=Date.now())
    await db.prepare('INSERT OR IGNORE INTO mini_answers(run_id,telegram_id,question_no,selected_json,correct) VALUES(?,?,?,?,0)')
      .bind(run.id,String(user.id),next.id,'[]').run();
}
async function stateFor(db,run,user) {
  const raw=await answersFor(db,run,user);
  const answers=raw.map(r=>{
    const q=run.questions.find(q=>q.id===Number(r.question_no));
    return {questionId:Number(r.question_no),selected:JSON.parse(r.selected_json),correct:Boolean(r.correct),
      timedOut:r.selected_json==='[]',correctOptions:q.correct,explanation:q.explanation};
  });
  const next=run.questions[answers.length];
  const timer=next?await currentTimer(db,run,user,next):null;
  const complete=answers.length===QCOUNT;
  const statsReady=complete && timestamp()>=run.statsAt;
  const resultComment=complete?await resultTextForScore(db,run,user,answers.filter(a=>a.correct).length):null;
  return {ok:true,userName:String(user.first_name||'Участник').slice(0,80),runId:run.id,
    questions:run.questions.map((q,index)=>(index>answers.length||(index===answers.length&&!timer))?null:
      {id:q.id,text:q.text,description:q.description,options:q.options,multiple:q.correct.length>1,timeSeconds:q.timeSeconds}),
    answers,activeTimer:timer?{questionId:next.id,deadlineMs:Number(timer.deadline_at),durationSec:next.timeSeconds}:null,
    complete,score:complete?answers.filter(a=>a.correct).length:null,resultComment,statistics:null,
    isBrowser:user.isBrowser===true,
    subscriptionStatus:complete?'checking':'not_finished',statsReady,statisticsAt:statsAtLabel(run.statsAt)};
}
async function openFor(db,run,user) {
  await join(db,run,user);
  await expireIfDue(db,run,user);
  const answers=await answersFor(db,run,user);
  const next=run.questions[answers.length];
  if (next) {
    const now=Date.now();
    await db.prepare('INSERT OR IGNORE INTO mini_timers(run_id,telegram_id,question_no,started_at,deadline_at) VALUES(?,?,?,?,?)')
      .bind(run.id,String(user.id),next.id,now,now+next.timeSeconds*1000).run();
  }
  return stateFor(db,run,user);
}
async function answerFor(db,run,user,payload) {
  if (!payload||!Number.isInteger(payload.questionId)||!Array.isArray(payload.selected)) throw err('Не выбран ответ');
  const selected=payload.selected;
  if (!selected.length||selected.length>10||selected.some(x=>!Number.isInteger(x)||x<0||x>9)||new Set(selected).size!==selected.length) throw err('Некорректные варианты ответа');
  await join(db,run,user);
  await expireIfDue(db,run,user);
  const answers=await answersFor(db,run,user);
  const saved=answers.find(a=>Number(a.question_no)===payload.questionId);
  if (saved) return stateFor(db,run,user);
  const next=run.questions[answers.length];
  if (!next||next.id!==payload.questionId||selected.some(x=>x>=next.options.length)) throw err('Пожалуйста, отвечай по порядку');
  const timer=await currentTimer(db,run,user,next);
  if (!timer) throw err('Вопрос ещё не открыт');
  if (Number(timer.deadline_at)<=Date.now()) {
    await expireIfDue(db,run,user);
    return stateFor(db,run,user);
  }
  const sorted=[...selected].sort((a,b)=>a-b);
  const good=JSON.stringify(sorted)===JSON.stringify(next.correct)?1:0;
  await db.prepare('INSERT OR IGNORE INTO mini_answers(run_id,telegram_id,question_no,selected_json,correct) VALUES(?,?,?,?,?)')
    .bind(run.id,String(user.id),next.id,JSON.stringify(sorted),good).run();
  return stateFor(db,run,user);
}
async function getMembership(env,userId) {
  try {
    const record=await telegram(env,'getChatMember',{chat_id:CHANNEL,user_id:Number(userId)});
    if (['creator','administrator','member'].includes(record.status)||(record.status==='restricted'&&record.is_member===true)) return 'member';
    if (['left','kicked'].includes(record.status)||(record.status==='restricted'&&record.is_member===false)) return 'required';
    return 'unavailable';
  } catch(e) { console.warn('Channel subscription check unavailable:',String(e.message));return 'unavailable'; }
}
async function publicStatistics(db,run) {
  const out=await db.prepare('SELECT question_no,COUNT(*) AS total,COALESCE(SUM(correct),0) AS good FROM mini_answers WHERE run_id=? GROUP BY question_no')
    .bind(run.id).all();
  const by=new Map((out.results||[]).map(r=>[Number(r.question_no),r]));
  return run.questions.map(q=>{
    const r=by.get(q.id),total=Number(r?.total||0),good=Number(r?.good||0);
    return {questionId:q.id,correctPercent:total?Math.round(good*100/total):0,
      incorrectPercent:total?Math.round((total-good)*100/total):0};
  });
}

/**
 * Snapshot of the first statistics cut taken at 19:00 Moscow.
 * All recipients receive exactly the same percentages, even when answers
 * continue arriving after 19:00.
 */
async function statisticsSnapshot(db,run) {
  let row=await db.prepare('SELECT snapshot_json,created_at FROM mini_stats_snapshots WHERE run_id=?')
    .bind(run.id).first();
  if(!row){
    const snapshot=await publicStatistics(db,run);
    await db.prepare('INSERT OR IGNORE INTO mini_stats_snapshots(run_id,snapshot_json) VALUES(?,?)')
      .bind(run.id,JSON.stringify(snapshot)).run();
    row=await db.prepare('SELECT snapshot_json,created_at FROM mini_stats_snapshots WHERE run_id=?')
      .bind(run.id).first();
  }
  if(!row)throw err('Не удалось сохранить вечерний срез статистики',503);
  return {data:JSON.parse(row.snapshot_json),createdAt:Number(row.created_at)};
}

/**
 * Up to 20 personal Telegram messages per batch. Only users who finished
 * before the frozen snapshot and were subscribed at delivery time.
 * Never exposes absolute participant counts.
 */
async function dispatchEveningStats(env,limit=20) {
  if(env.STATS_PUSH_ENABLED!=='yes') throw err('Вечерняя рассылка статистики выключена');
  const run=await activeEdition(env.DB);
  if(timestamp()<run.statsAt) throw err('Ещё нет 19:00 МСК');
  const frozen=await statisticsSnapshot(env.DB,run);
  const count=Math.max(1,Math.min(20,Number(limit)||20));
  const {results=[]}=await env.DB.prepare(`
    SELECT p.telegram_id FROM mini_participants p
    JOIN mini_contacts c ON c.telegram_id=p.telegram_id AND c.active=1
    WHERE p.run_id=?
      AND (SELECT COUNT(*) FROM mini_answers a
           WHERE a.run_id=p.run_id AND a.telegram_id=p.telegram_id)=6
      AND (SELECT MAX(answered_at) FROM mini_answers a
           WHERE a.run_id=p.run_id AND a.telegram_id=p.telegram_id)<=?
      AND NOT EXISTS(SELECT 1 FROM mini_stats_deliveries d
                     WHERE d.run_id=p.run_id AND d.telegram_id=p.telegram_id)
    ORDER BY p.started_at,p.telegram_id LIMIT ?`)
    .bind(run.id,frozen.createdAt,count).all();
  const lines=frozen.data.map(q=>'Вопрос '+q.questionId+': '+q.correctPercent+
    '% верно · '+q.incorrectPercent+'% неверно');
  const message='«вы́Читать» — результаты теста на 19:00 МСК.\n\n'+
    lines.join('\n')+'\n\nЭто проценты правильных и неправильных ответов по каждому вопросу на 19:00.\n'+
    'Открыть тест: '+BOT_LINK;
  let sent=0,notMember=0,blocked=0,errors=0;
  for(const item of results){
    const member=await getMembership(env,item.telegram_id);
    if(member==='unavailable'){errors++;continue;}
    let outcome='not_member';
    if(member==='member'){
      try{
        await telegram(env,'sendMessage',{chat_id:item.telegram_id,
          text:message,disable_web_page_preview:true});
        sent++;outcome='sent';
      }catch(e){
        if(/403/.test(String(e.message))){blocked++;outcome='blocked';
          await env.DB.prepare('UPDATE mini_contacts SET active=0 WHERE telegram_id=?')
            .bind(item.telegram_id).run();
        }else {errors++;break;}
      }
    }else notMember++;
    await env.DB.prepare('INSERT OR IGNORE INTO mini_stats_deliveries(run_id,telegram_id,status) VALUES(?,?,?)')
      .bind(run.id,item.telegram_id,outcome).run();
  }
  return {ok:true,runId:run.id,sent,notMember,blocked,errors};
}

async function applyGate(env,run,user,state) {
  if (!state.complete) return state;
  if(user.isBrowser===true) {
    // Telegram-only membership cannot be verified for an anonymous web visitor.
    // Release the same percentages at the SAME 19:00 gate, never before.
    state.subscriptionStatus='browser';
    if(state.statsReady)state.statistics=await publicStatistics(env.DB,run);
    return state;
  }
  state.subscriptionStatus=await getMembership(env,user.id);
  if (state.subscriptionStatus==='member'&&state.statsReady) state.statistics=await publicStatistics(env.DB,run);
  return state;
}
async function share(env,run,user) {
  const ans=await answersFor(env.DB,run,user);
  if (ans.length!==6) throw err('Сначала заверши все шесть вопросов');
  const score=ans.filter(x=>x.correct).length;
  // Выбираем ту же формулировку, что stateFor выводит на экране результата.
  const resultComment=await resultTextForScore(env.DB,run,user,score);
  const text=`<i>${escapeTelegramHTML(resultComment)}</i>\n\nЭто мой результат в тесте канала <a href="https://t.me/posttsop">вы́Читать</a> по русскому языку. У меня <b>${score} из 6</b>.\nА ты справишься лучше?`;
  const record=await telegram(env,'savePreparedInlineMessage',{
    user_id:user.id,result:{type:'article',id:crypto.randomUUID().replaceAll('-',''),title:'Мой результат в тесте вы́Читать',
      input_message_content:{message_text:text,parse_mode:'HTML',link_preview_options:{is_disabled:true}},
      reply_markup:{inline_keyboard:[[{text:'Проверь себя',url:BOT_LINK}]]}},
    allow_user_chats:true,allow_group_chats:true,allow_bot_chats:false,allow_channel_chats:false
  });
  return {ok:true,shareId:record.id};
}
async function callMini(env,body) {
  const action=String(body?.action||'');
  if(action==='browserSession')return createBrowserSession(env);
  // Never treat an invalid Telegram initData as a browser user.
  const user=typeof body?.initData==='string'&&body.initData.length
    ? await telegramUser(body.initData,env.BOT_TOKEN)
    : await browserUser(env,body?.browserToken);
  const mode=String(env.ACCESS_MODE||'pilot').toLowerCase();
  if (!['pilot','public'].includes(mode)) throw err('Неверная настройка ACCESS_MODE',503);
  if (mode==='pilot'&&String(user.id)!==String(env.TEST_CHAT_ID||'')) throw err('Сейчас тест доступен только администратору',403);
  const run=await activeEdition(env.DB);
  if (mode==='public'&&!draftIsReady(run.questions)) throw err('Выпуск готовится. Попробуй позже.',503);
  if (action==='share') {
    if(user.isBrowser)throw err('Из браузера поделись результатом через ссылку Telegram',403);
    return share(env,run,user);
  }
  let state;
  if (action==='state'||action==='checkSubscription'||action==='expire') {
    await join(env.DB,run,user);
    await expireIfDue(env.DB,run,user);
    state=await stateFor(env.DB,run,user);
  } else if(action==='open') state=await openFor(env.DB,run,user);
  else if(action==='answer') state=await answerFor(env.DB,run,user,body.payload);
  else throw err('Неизвестная операция');
  return applyGate(env,run,user,state);
}

async function recordContact(env,id,firstName) {
  await env.DB.prepare(`INSERT INTO mini_contacts(telegram_id,first_name,active) VALUES(?,?,1)
    ON CONFLICT(telegram_id) DO UPDATE SET first_name=excluded.first_name,last_started_at=unixepoch(),active=1`)
    .bind(String(id),String(firstName||'').slice(0,80)).run();
}

async function sendAdminMenu(env,chatId,text) {
  const keyboard={keyboard:[
    [{text:'Подготовить выпуск'},{text:'Опубликовать выпуск'}],
    [{text:'Статистика'},{text:'Статус'}],
    [{text:'Сбросить моё прохождение'}],
    [{text:'Скрыть меню'}]
  ],resize_keyboard:true,is_persistent:true};
  await telegram(env,'sendMessage',{chat_id:chatId,text,reply_markup:keyboard});
}

/**
 * Only the owner can call this through the authenticated private Telegram webhook.
 * The short edition suffix in the confirmation prevents old confirmation buttons
 * from accidentally clearing the results of a newly published edition.
 * D1 batch applies all three deletes as a single transaction.
 */
async function resetOwnerAttempt(env,chatId,confirmedSuffix) {
  const ownerId=String(env.TEST_CHAT_ID||'');
  if(!/^[1-9]\d{4,19}$/.test(ownerId)||String(chatId)!==ownerId)
    throw err('Сброс доступен только владельцу',403);
  const run=await activeEdition(env.DB);
  if(run.id.slice(-12)!==confirmedSuffix)
    throw err('Выпуск изменился. Открой сброс заново, чтобы проверить активный выпуск.');
  const tables=['mini_answers','mini_timers','mini_participants'];
  const args=[run.id,ownerId,run.id];
  const sql=tables.map(t=>
    'DELETE FROM '+t+' WHERE run_id=? AND telegram_id=?'+
    " AND EXISTS (SELECT 1 FROM mini_editions WHERE run_id=? AND status='ACTIVE')");
  const results=await env.DB.batch(sql.map(q=>env.DB.prepare(q).bind(...args)));
  const deleted=results.map(x=>Number(x?.meta?.changes||0));
  return sendAdminMenu(env,chatId,
    deleted.every(n=>n===0)
      ?'Для текущего выпуска не найдено твоего прохождения. Можешь открыть тест.'
      :'Твоё прохождение текущего выпуска сброшено: удалены ответы, таймеры и запись об участии.\n\n'+
        'Закрой Mini App полностью и заново открой тест из бота. Ты снова увидишь первый вопрос.\n\n'+
        'Ответы других участников и архив не затронуты. Если статистика на 19:00 уже разослана, её зафиксированный срез не изменится.');
}

async function handleAdminCommand(env,chatId,raw) {
  const command=raw.trim();
  if(command==='/admin'||command==='/menu'||command==='Управление тестом')
    return sendAdminMenu(env,chatId,'Управление тестами «вы́Читать». Сначала подготовь выпуск из таблицы. После проверки нажми «Опубликовать выпуск».');
  if(command==='Скрыть меню')
    return telegram(env,'sendMessage',{chat_id:chatId,
      text:'Меню скрыто. Чтобы вернуть его, отправь /admin.',reply_markup:{remove_keyboard:true}});

  if(command==='Сбросить моё прохождение'||command==='/resetme') {
    const run=await activeEdition(env.DB);
    // Echo the active edition in the confirmation button: previous confirmation
    // messages become invalid after a new edition has been activated.
    return telegram(env,'sendMessage',{chat_id:chatId,
      text:'Сбросить ТОЛЬКО твоё прохождение текущего выпуска?\n\n'+
        'Удалятся твои ответы, таймеры и запись об участии, после чего ты сможешь пройти этот же тест заново. Другие участники не пострадают.\n\n'+
        'Никаких изменений в вопросах и самом выпуске не произойдёт.',
      reply_markup:{keyboard:[
        [{text:'Да, сбросить #'+run.id.slice(-12)}],
        [{text:'Отмена'}]
      ],resize_keyboard:true,one_time_keyboard:true}});
  }
  if(/^Да, сбросить #[A-Za-z0-9-]{12}$/.test(command)) {
    return resetOwnerAttempt(env,chatId,command.slice(-12));
  }
  if(command==='Подготовить выпуск'||command==='/prepare') {
    const data=await googleBridge(env,'prepare');
    const staged=await stageQuestions(env.DB,{questions:data.questions,comments:data.comments});
    const preview=data.questions.map(q=>q.id+'. '+q.text.slice(0,125)).join('\n');
    const variants=data.comments.map((v,i)=>i+'/6 — '+v.length).join(' · ');
    return sendAdminMenu(env,chatId,'Готово: из Google Sheets загружены '+staged.questionCount+
      ' вопросов и '+staged.commentCount+' комментариев.\n\nВОПРОСЫ:\n'+preview+
      '\n\nКОММЕНТАРИИ:\n'+variants+
      '\n\nЭто ЧЕРНОВИК: текущий выпуск не изменён. Для публикации нажми «Опубликовать выпуск».');
  }
  if(command==='Опубликовать выпуск'||command==='/publish')
    return telegram(env,'sendMessage',{chat_id:chatId,
      text:'В новом выпуске все участники начнут с первого вопроса. Прежние ответы сохранятся в архиве. В публичном режиме новый тест откроется сразу. Подтверждаешь?',
      reply_markup:{keyboard:[[{text:'Да, опубликовать'}],[{text:'Отмена'}]],resize_keyboard:true,one_time_keyboard:true}});
  if(command==='Отмена')
    return sendAdminMenu(env,chatId,'Действие отменено. Ничего не изменено.');
  if(command==='Да, опубликовать') {
    const draft=await env.DB.prepare('SELECT updated_at,questions_json FROM mini_drafts WHERE draft_id=1').first();
    if(!draft||timestamp()-Number(draft.updated_at)>1800||timestamp()<Number(draft.updated_at))
      throw err('Черновик старше 30 минут или отсутствует. Сначала подготовь выпуск.');
    const n=await env.DB.prepare("SELECT COUNT(*) AS n FROM mini_result_comments WHERE run_id='__draft__'").first();
    if(Number(n?.n)!==7)throw err('Не хватает комментариев. Нажми «Подготовить выпуск».');
    const q=validateQuestions(JSON.parse(draft.questions_json));
    if(!draftIsReady(q))throw err('В черновике остались тестовые вопросы.');
    const res=await activateDraft(env.DB,false);
    return sendAdminMenu(env,chatId,res.created
      ?'Новый выпуск опубликован! ID: '+res.runId+'\nПрежний выпуск и ответы сохранены в архиве.'
      :'Новый выпуск не создан: вопросы совпадают с действующими. Ничего не сброшено.');
  }
  if(command==='Статистика'||command==='/stats') {
    // Живые ответы берём из D1. Сбой ответа Google не должен скрывать
    // актуальную статистику от владельца, даже если запись уже выполнилась.
    const report=await adminReport(env.DB);
    let sheet=null, sheetsError=null;
    try{sheet=await googleBridge(env,'saveStats',{report});}
    catch(e){
      sheetsError=e;
      console.warn('Google Sheets report acknowledgement failed: '+String(e.message||e));
    }
    const byQuestion=report.perQuestion.map(q=>'Вопрос '+q.questionId+': '+q.correct+
      ' верно / '+q.incorrect+' неверно ('+q.correctPercent+'% / '+q.incorrectPercent+'%)').join('\n');
    const dist=(sheet?.distribution||report.distribution).map((v,i)=>i+'/6: '+v).join(' · ');
    const updatedAt=sheet?.updatedAt||statsAtLabel(timestamp());
    const note=sheet
      ?'Данные сохранены в Google Sheets → «Cloudflare_Отчёт».'
      :'Данные рассчитаны по Cloudflare D1. Не удалось подтвердить обновление Google Sheets ('+
        String(sheetsError?.message||'ошибка соединения')+
        '). Проверь время обновления листа «Cloudflare_Отчёт».';
    return telegram(env,'sendMessage',{chat_id:chatId,
      text:'Статистика выпуска\n'+report.runId+
        '\n'+(sheet?'Обновлено в таблице: ':'Рассчитано: ')+updatedAt+' (МСК)'+
        '\n\nНачали: '+report.started+
        '\nЗавершили: '+report.completed+'\nНе завершили: '+report.incomplete+
        '\nЧерез Telegram: '+report.telegramStarted+' (завершили '+report.telegramCompleted+')'+
        '\nЧерез браузер: '+report.browserStarted+' (завершили '+report.browserCompleted+')'+
        '\nСредний балл: '+(report.average===null?'—':report.average)+
        '\n\nПо вопросам:\n'+byQuestion+
        '\n\nРаспределение баллов:\n'+dist+
        '\n\n'+note,
      link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:'Открыть Google-отчёт',url:'https://docs.google.com/spreadsheets/d/1A4D4fh9Bn8QO7jZGGvQsIWrTP-P36tqCKPi-IqjUWLM/edit#gid=1914646520'}]]}});
  }
  if(command==='Статус'||command==='/status') {
    const run=await activeEdition(env.DB);
    const draft=await env.DB.prepare('SELECT updated_at FROM mini_drafts WHERE draft_id=1').first();
    return telegram(env,'sendMessage',{chat_id:chatId,
      text:'Активный выпуск: '+run.id+'\nДоступ: '+String(env.ACCESS_MODE||'pilot')+
        '\nСтатистика после: '+statsAtLabel(run.statsAt)+' (МСК)'+
        '\nЧерновик: '+(draft?'подготовлен '+statsAtLabel(Number(draft.updated_at)):'нет')});
  }
  return false;
}

async function telegramUpdate(env,update) {
  if (!Number.isSafeInteger(update?.update_id)) throw err('Некорректное обновление',400);
  const dup=await env.DB.prepare('SELECT 1 FROM processed_updates WHERE update_id=?').bind(update.update_id).first();
  if (dup) return;
  const message=update.message;
  const privateMessage=message?.chat?.type==='private'&&message.from?.id===message.chat.id;
  const raw=String(message?.text||'').trim();
  const owner=privateMessage&&String(message.from.id)===String(env.TEST_CHAT_ID||'');
  if(owner && (['/admin','/menu','/prepare','/publish','/stats','/status','/resetme',
      'Управление тестом','Подготовить выпуск','Опубликовать выпуск',
      'Да, опубликовать','Отмена','Статистика','Статус','Скрыть меню',
      'Сбросить моё прохождение'].includes(raw)||
      /^Да, сбросить #[A-Za-z0-9-]{12}$/.test(raw))) {
    try {await handleAdminCommand(env,message.chat.id,raw);}
    catch(e){await sendAdminMenu(env,message.chat.id,'Ошибка: '+String(e.message||e).slice(0,750));}
  } else if(privateMessage&&/^\/start(?:\s+[A-Za-z0-9_-]{1,64})?\s*$/.test(raw)) {
    await recordContact(env,message.from.id,message.from.first_name);
    const mode=String(env.ACCESS_MODE||'pilot').toLowerCase();
    let publicReady=false;
    if(mode==='public'){
      try{publicReady=draftIsReady((await activeEdition(env.DB)).questions);}
      catch(_){publicReady=false;}
    }
    const hasAccess=publicReady||String(message.from.id)===String(env.TEST_CHAT_ID||'');
    // Repair old per-chat menu URLs on /start. Inline buttons in older
    // messages cannot be rewritten here; the new message below uses HTTPS.
    if(hasAccess){
      try{
        await telegram(env,'setChatMenuButton',{chat_id:message.chat.id,
          menu_button:{type:'web_app',text:'Открыть тест',web_app:{url:BASE_PAGE}}});
      }catch(e){
        // A menu update failure must not prevent the fresh launch button.
        console.warn('Could not refresh quiz menu:',String(e.message||e).slice(0,160));
      }
    }
    await telegram(env,'sendMessage',hasAccess?{
      chat_id:message.chat.id,
      text:'Привет! Это тест по русскому языку от канала <a href="https://t.me/posttsop">вы́Читать</a>.\n\nШесть вопросов, свой таймер на каждый и одна попытка.\n\nНажми кнопку, чтобы открыть приложение.',
      parse_mode:'HTML',link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:'Открыть тест',web_app:{url:BASE_PAGE}}]]}
    }:{chat_id:message.chat.id,text:'Новый тест по русскому языку от вы́Читать пока готовится. Когда выйдет выпуск, пришлём кнопку «Открыть тест».'});
    if(owner) await sendAdminMenu(env,message.chat.id,'Административное меню теста.');
  }
  await env.DB.prepare('INSERT OR IGNORE INTO processed_updates(update_id) VALUES(?)').bind(update.update_id).run();
}

async function stageQuestions(db,body) {
  const questions=validateQuestions(body.questions);
  const stmt=db.prepare("INSERT INTO mini_drafts(draft_id,questions_json,updated_at) VALUES(1,?,unixepoch()) ON CONFLICT(draft_id) DO UPDATE SET questions_json=excluded.questions_json,updated_at=unixepoch()")
    .bind(JSON.stringify(questions));
  if(body.comments!==undefined){
    const comments=validateResultComments(body.comments);
    const tasks=[stmt,db.prepare("DELETE FROM mini_result_comments WHERE run_id='__draft__'")];
    for(let score=0;score<7;score++)
      tasks.push(db.prepare('INSERT INTO mini_result_comments(run_id,score,messages_json) VALUES(?,?,?)')
        .bind('__draft__',score,JSON.stringify(comments[score])));
    await db.batch(tasks);
    return {ok:true,questionCount:6,commentCount:comments.reduce((n,g)=>n+g.length,0)};
  }
  // Совместимость со старым ручным запуском из GAS.
  await stmt.run();
  try {await db.prepare("DELETE FROM mini_result_comments WHERE run_id='__draft__'").run();}
  catch(_) {/* Миграция для старого ручного запуска необязательна. */}
  return {ok:true,questionCount:6};
}
async function activateDraft(db,force=false) {
  const draft=await db.prepare('SELECT questions_json FROM mini_drafts WHERE draft_id=1').first();
  if (!draft) throw err('Сначала загрузите шесть вопросов (stage)');
  const questions=validateQuestions(JSON.parse(draft.questions_json));
  const current=await db.prepare("SELECT questions_snapshot_json FROM mini_editions WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1").first();
  if (!force&&current&&current.questions_snapshot_json===JSON.stringify(questions)) return {ok:true,created:false,message:'Вопросы не изменились'};
  const runId=`timed_${crypto.randomUUID()}`;
  // История ответов не затрагивается; варианты комментариев фиксируются на выпуск.
  const statements=[
    db.prepare("UPDATE mini_editions SET status='ARCHIVED' WHERE status='ACTIVE'"),
    db.prepare("INSERT INTO mini_editions(run_id,stats_after,status,questions_snapshot_json) VALUES(?,?,'ACTIVE',?)")
      .bind(runId,statsAtForToday(),JSON.stringify(questions))
  ];
  try {
    const count=await db.prepare("SELECT COUNT(*) AS n FROM mini_result_comments WHERE run_id='__draft__'").first();
    if(Number(count?.n)===7)
      statements.push(db.prepare("INSERT INTO mini_result_comments(run_id,score,messages_json) SELECT ?,score,messages_json FROM mini_result_comments WHERE run_id='__draft__'").bind(runId));
  }catch(_) {/* Старый ручной запуск без миграции работает, как прежде. */}
  // С каждым действительно новым выпуском стираем только временные
  // изображения сториз. Участники, ответы, архив и статистика не затрагиваются.
  // CREATE TABLE IF NOT EXISTS безопасен, даже если никто ещё не делился сториз.
  await db.exec(STORY_TABLE_SQL);
  // Удаление включено в ту же D1-транзакцию, что и активация выпуска:
  // если публикация не состоится, прежние изображения не исчезнут.
  statements.push(db.prepare("DELETE FROM mini_story_cards"));
  await db.batch(statements);
  return {ok:true,created:true,runId};
}
async function adminReport(db,runId=null) {
  let run;
  if (runId) {
    if (typeof runId!=='string'||runId.length>90) throw err('Некорректный ID выпуска');
    const row=await db.prepare('SELECT run_id,stats_after,questions_snapshot_json FROM mini_editions WHERE run_id=?')
      .bind(runId).first();
    if (!row) throw err('Выпуск не найден',404);
    run={id:row.run_id,statsAt:Number(row.stats_after),questions:JSON.parse(row.questions_snapshot_json)};
  } else run=await activeEdition(db);
  const people=await db.prepare('SELECT telegram_id FROM mini_participants WHERE run_id=?').bind(run.id).all();
  const answerRows=await db.prepare('SELECT telegram_id,question_no,selected_json,correct FROM mini_answers WHERE run_id=?').bind(run.id).all();
  const users=new Map((people.results||[]).map(p=>[String(p.telegram_id),new Map()]));
  for(const r of answerRows.results||[]) {
    const key=String(r.telegram_id); if(!users.has(key))users.set(key,new Map());
    users.get(key).set(Number(r.question_no),r);
  }
  const finished=[...users.values()].filter(m=>m.size===QCOUNT);
  const perQuestion=run.questions.map(q=>{
    const values=[...users.values()].map(u=>u.get(q.id)).filter(Boolean);
    const right=values.filter(v=>v.correct).length;
    const expired=values.filter(v=>v.selected_json==='[]').length;
    const total=values.length;
    return {questionId:q.id,question:q.text,answered:total-expired,expired,total,correct:right,incorrect:total-right,
      correctPercent:total?Math.round(right*100/total):0,incorrectPercent:total?Math.round((total-right)*100/total):0};
  });
  const dist=Array(7).fill(0);
  for (const m of finished) dist[[...m.values()].filter(r=>r.correct).length]++;
  const average=finished.length?Number((finished.reduce((sum,m)=>sum+[...m.values()].filter(r=>r.correct).length,0)/finished.length).toFixed(2)):null;
  const browserStarted=[...users.keys()].filter(id=>id.startsWith('-')).length;
  const browserCompleted=[...users].filter(([id,answers])=>id.startsWith('-')&&answers.size===QCOUNT).length;
  return {ok:true,runId:run.id,started:users.size,completed:finished.length,incomplete:users.size-finished.length,average,
    browserStarted,browserCompleted,telegramStarted:users.size-browserStarted,
    telegramCompleted:finished.length-browserCompleted,
    statisticsAt:statsAtLabel(run.statsAt),perQuestion,distribution:dist};
}
async function sendInvitations(env,limit=20) {
  if (!isPublic(env)||env.INVITES_ENABLED!=='yes') throw err('Рассылки выключены');
  const run=await activeEdition(env.DB);
  if(!draftIsReady(run.questions)) throw err('Пока используются тестовые вопросы. Рассылка запрещена.');
  const {results=[]}=await env.DB.prepare(`SELECT c.telegram_id FROM mini_contacts c
    WHERE c.active=1 AND NOT EXISTS(SELECT 1 FROM mini_invitations i WHERE i.run_id=? AND i.telegram_id=c.telegram_id)
    ORDER BY c.first_started_at LIMIT ?`).bind(run.id,Math.min(20,Math.max(1,Number(limit)||20))).all();
  let sent=0,blocked=0,errors=0;
  for (const user of results) {
    try {
      await telegram(env,'sendMessage',{chat_id:user.telegram_id,
        text:'Вышел новый тест по русскому языку от канала вы́Читать. Шесть вопросов, одна попытка. Проверишь себя?',
        reply_markup:{inline_keyboard:[[{text:'Открыть тест',web_app:{url:BASE_PAGE}}]]}});
      await env.DB.prepare("INSERT OR IGNORE INTO mini_invitations(run_id,telegram_id,status) VALUES(?,?,'sent')")
        .bind(run.id,user.telegram_id).run(); sent++;
    } catch(e) {
      errors++;
      if (/403/.test(String(e.message))) {blocked++;await env.DB.prepare('UPDATE mini_contacts SET active=0 WHERE telegram_id=?').bind(user.telegram_id).run();}
      // Unknown Telegram outcome: do not auto-repeat immediately; avoid duplicates.
      else break;
    }
  }
  return {ok:true,sent,blocked,errors};
}
async function adminAction(env,body) {
  switch(body?.action) {
    case 'stage': return stageQuestions(env.DB,body);
    case 'activate': return activateDraft(env.DB,body.force===true);
    case 'report': return adminReport(env.DB,body.runId||null);
    case 'preflight': {
      const run = await activeEdition(env.DB);
      const bot = await telegram(env,'getMe',{});
      const hook = await telegram(env,'getWebhookInfo',{});
      const placeholders = run.questions.filter(q=>[q.description,q.text,...q.options,q.explanation]
        .some(x=>PLACEHOLDER_PATTERN.test(String(x||''))));
      const names=await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('mini_stats_snapshots','mini_stats_deliveries')").all();
      const statsTablesReady=new Set((names.results||[]).map(x=>x.name)).size===2;
      const globalMenu = await telegram(env,'getChatMenuButton',{});
      const privateMenu = env.TEST_CHAT_ID
        ? await telegram(env,'getChatMenuButton',{chat_id:Number(env.TEST_CHAT_ID)})
        : null;
      return {ok:true,runId:run.id,statisticsAt:statsAtLabel(run.statsAt),
        launchUrl:BASE_PAGE,botUsername:bot.username,
        webhookUrl:hook.url===WEBHOOK_ENDPOINT?hook.url:(hook.url?'OTHER':''),webhookLastError:hook.last_error_message||null,
        accessMode:String(env.ACCESS_MODE||'pilot').toLowerCase(),
        invitationsEnabled:env.INVITES_ENABLED==='yes',weeklyEnabled:env.WEEKLY_ENABLED==='yes',
        questionCount:run.questions.length,placeholderCount:placeholders.length,
        statsPushEnabled:env.STATS_PUSH_ENABLED==='yes',statsTablesReady,
        readyForPublic:draftIsReady(run.questions),
        globalMenuReady:globalMenu?.type==='web_app'&&globalMenu?.web_app?.url===BASE_PAGE,
        privateMenuReady:privateMenu?.type==='web_app'&&privateMenu?.web_app?.url===BASE_PAGE};
    }
    case 'configureWebhook': {
      if(!isPublic(env)&&!isPilot(env)) throw err('ACCESS_MODE должен быть pilot или public');
      const run=await activeEdition(env.DB);
      if(isPublic(env)&&!draftIsReady(run.questions))
        throw err('Пока активны тестовые вопросы. Сначала опубликуй настоящий выпуск.');
      const secret=String(env.WEBHOOK_SECRET||'');
      if(!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw err('WEBHOOK_SECRET должен содержать 32–256 букв/цифр/знаков -_');
      await telegram(env,'setWebhook',{
        url:WEBHOOK_ENDPOINT,
        secret_token:secret,
        allowed_updates:['message'],
        drop_pending_updates:false
      });
      return {ok:true,webhook:WEBHOOK_ENDPOINT};
    }

    case 'sendPilotButton': {
      if (!/^\d{4,16}$/.test(String(env.TEST_CHAT_ID||''))) throw err('Укажи TEST_CHAT_ID');
      await telegram(env,'sendMessage',{chat_id:env.TEST_CHAT_ID,
        text:'«вы́Читать»: шесть вопросов по русскому языку. На каждый вопрос — свой таймер.',
        reply_markup:{inline_keyboard:[[{text:'Пройти 6 вопросов',web_app:{url:BASE_PAGE}}]]}});
      return {ok:true,sentTo:'TEST_CHAT_ID'};
    }
    case 'syncContacts': {
      if (!Array.isArray(body.contacts)||body.contacts.length>2000) throw err('Список контактов некорректен');
      let added=0;
      for(const c of body.contacts) {
        if (!/^\d{4,16}$/.test(String(c.telegram_id))) continue;
        await env.DB.prepare('INSERT OR IGNORE INTO mini_contacts(telegram_id,first_name,active) VALUES(?,?,?)')
          .bind(String(c.telegram_id),String(c.first_name||'').slice(0,80),c.active===false?0:1).run();added++;
      }
      return {ok:true,processed:added};
    }
    case 'sendInvitations': return sendInvitations(env,body.limit);
    case 'sendEveningStats': return dispatchEveningStats(env,body.limit);
    case 'configureMenu': {
      if(!isPilot(env)&&!isPublic(env)) throw err('Неверный режим ACCESS_MODE');
      const active=await activeEdition(env.DB);
      if(isPublic(env)&&!draftIsReady(active.questions))
        throw err('В активном выпуске ещё тестовые вопросы. Публичное меню запрещено.');
      const privateOnly=isPilot(env);
      if(privateOnly&&!/^[1-9]\d{4,19}$/.test(String(env.TEST_CHAT_ID||'')))
        throw err('Для личного меню настрой TEST_CHAT_ID');
      const request={menu_button:{type:'web_app',text:'Открыть тест',web_app:{url:BASE_PAGE}}};
      if(privateOnly)request.chat_id=Number(env.TEST_CHAT_ID);
      await telegram(env,'setChatMenuButton',request);
      if(!privateOnly)
        await telegram(env,'setMyCommands',{commands:[{command:'start',description:'Открыть тест'}]});
      return {ok:true,mode:privateOnly?'private_pilot':'public_global'};
    }
    default: throw err('Неизвестная административная операция');
  }
}


/* Telegram story media: temporary JPG in the ALREADY-CONNECTED Cloudflare D1.
 * This avoids activating paid/billing-enabled R2. Short-lived story snapshots
 * use unguessable URLs and are removed during new uploads after 72 hours.
 * This uses a NEW table and does not touch any quiz answers or score tables.
 */
const STORY_MAX_BYTES=700000; // JPEG <= 700 KB, base64 < 1 MB, below D1 2 MB row limit
const STORY_MAX_ROWS=500;     // protect the quiz database's 500 MB free tier
const STORY_RETENTION_SECONDS=3*86400;
const STORY_TABLE_SQL="CREATE TABLE IF NOT EXISTS mini_story_cards ("+
  "key TEXT PRIMARY KEY, telegram_id INTEGER NOT NULL, edition_id TEXT NOT NULL,"+
  "score INTEGER NOT NULL, content_b64 TEXT NOT NULL, created_at INTEGER NOT NULL)";
function storyErrorResponse(e,origin) {
  const status=Number.isInteger(e?.status)?e.status:500;
  return replyJSON({ok:false,error:status>=500?'Не удалось подготовить сториз. Попробуй позже.':String(e.message||'Ошибка')},status,origin);
}
function storyToBase64(buffer) {
  const bytes=new Uint8Array(buffer);
  const parts=[];
  for(let i=0;i<bytes.length;i+=16384){
    parts.push(String.fromCharCode(...bytes.subarray(i,Math.min(bytes.length,i+16384))));
  }
  return btoa(parts.join(''));
}
function storyFromBase64(base64) {
  const str=atob(base64);
  const out=new Uint8Array(str.length);
  for(let i=0;i<str.length;i++)out[i]=str.charCodeAt(i);
  return out;
}
async function uploadStoryPoster(request,env,origin) {
  if(!ORIGINS.has(origin))throw err('Недоверенное приложение',403);
  if(!String(request.headers.get('content-type')||'').toLowerCase().startsWith('multipart/form-data'))
    throw err('Неверный формат изображения',415);
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>STORY_MAX_BYTES+50000)throw err('Слишком большая картинка',413);
  const form=await request.formData();
  const user=await telegramUser(form.get('initData'),env.BOT_TOKEN);
  const run=await activeEdition(env.DB);
  if(isPilot(env)&&String(user.id)!==String(env.TEST_CHAT_ID||''))throw err('Выпуск доступен только администратору',403);
  if(isPublic(env)&&!draftIsReady(run.questions))throw err('Выпуск готовится',503);
  const answers=await answersFor(env.DB,run,user);
  if(answers.length!==QCOUNT)throw err('Сначала закончи тест, чтобы поделиться результатом',403);
  const score=answers.filter(a=>a.correct).length;
  const file=form.get('image');
  if(!file||typeof file.arrayBuffer!=='function'||typeof file.size!=='number'||
     file.size<500||file.size>STORY_MAX_BYTES||file.type!=='image/jpeg')
    throw err('Нужна JPG-картинка размером до 700 КБ',413);
  const buffer=await file.arrayBuffer();
  const bytes=new Uint8Array(buffer);
  if(bytes[0]!==0xff||bytes[1]!==0xd8||bytes[2]!==0xff||
     bytes[bytes.length-2]!==0xff||bytes[bytes.length-1]!==0xd9)
    throw err('Неверный формат JPEG',422);
  // Lazily install a separate auxiliary table; no manual D1 migrations needed.
  await env.DB.exec(STORY_TABLE_SQL);
  await env.DB.prepare("DELETE FROM mini_story_cards WHERE created_at < ?")
    .bind(timestamp()-STORY_RETENTION_SECONDS).run();
  // Each click captures the current poster instead of returning an older JPEG.
  // Delete only this user's cached Story image(s) for the active edition;
  // other participants and quiz answers are not affected.
  await env.DB.prepare(
    "DELETE FROM mini_story_cards WHERE telegram_id=? AND edition_id=?"
  ).bind(user.id,run.id).run();
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM mini_story_cards").first();
  if(Number(count?.n)>=STORY_MAX_ROWS)
    throw err('Хранилище временно заполнено. Попробуй поделиться позже.',503);
  const key=crypto.randomUUID().replaceAll('-','');
  const base64=storyToBase64(buffer);
  await env.DB.prepare(
    "INSERT INTO mini_story_cards(key,telegram_id,edition_id,score,content_b64,created_at) VALUES(?,?,?,?,?,?)")
    .bind(key,user.id,run.id,score,base64,timestamp()).run();
  return {ok:true,url:new URL('/story-media/'+key+'.jpg',request.url).toString()};
}
async function serveStoryPoster(request,env,name) {
  if(!/^[a-f0-9]{32}\.jpg$/.test(name))return new Response('Not found',{status:404});
  const key=name.slice(0,-4);
  // Only public images with random IDs; no Telegram ID or score leaks in URL.
  let row;
  try{row=await env.DB.prepare("SELECT content_b64,created_at FROM mini_story_cards WHERE key=?").bind(key).first();}
  catch(e){
    // Before first upload the optional media table does not exist yet.
    if(/no such table/i.test(String(e.message||e)))return new Response('Not found',{status:404});
    throw e;
  }
  if(!row||Number(row.created_at)<timestamp()-STORY_RETENTION_SECONDS)
    return new Response('Not found',{status:404,headers:{'cache-control':'no-store'}});
  const headers={
    'content-type':'image/jpeg','cache-control':'public, max-age=3600',
    'content-disposition':'inline; filename="vychitat-result.jpg"',
    'x-content-type-options':'nosniff'
  };
  return new Response(request.method==='HEAD'?null:storyFromBase64(row.content_b64),{status:200,headers});
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get('origin')||'';
    if (request.method==='GET'&&url.pathname==='/') {
      try {const r=await env.DB.prepare('SELECT 1 AS ok').first();return new Response(r?.ok===1?'vychitat Mini App: Worker + D1 OK':'Database error', {status:r?.ok===1?200:503,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
      catch { return new Response('Database connection failed',{status:503}); }
    }
    if ((request.method==='GET'||request.method==='HEAD')&&url.pathname.startsWith('/story-media/')) {
      try{return await serveStoryPoster(request,env,url.pathname.slice('/story-media/'.length));}
      catch(e){console.error('Story media:',String(e.message));return new Response('Media unavailable',{status:503});}
    }
    if(request.method==='OPTIONS'&&['/api','/story-upload'].includes(url.pathname)) {
      return new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGINS.has(origin)?origin:'null',
        'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type',
        'access-control-max-age':'3600','vary':'Origin'}});
    }
    if(request.method==='POST'&&url.pathname==='/story-upload') {
      try{return replyJSON(await uploadStoryPoster(request,env,origin),200,origin);}
      catch(e){console.error('Story upload:',String(e.message));return storyErrorResponse(e,origin);}
    }
    if (request.method!=='POST'||!['/api','/admin','/telegram'].includes(url.pathname)) return new Response('Not found',{status:404});
    if (url.pathname==='/api'&&!ORIGINS.has(origin)) return replyJSON({ok:false,error:'Запрос из недоверенного приложения'},403);
    if (url.pathname==='/admin') {
      const secret=String(env.ADMIN_KEY||'');
      if (secret.length<32||!authEqual(request.headers.get('authorization')||'',`Bearer ${secret}`)) return replyJSON({ok:false,error:'Forbidden'},403);
    }
    if (url.pathname==='/telegram') {
      const secret=String(env.WEBHOOK_SECRET||'');
      if (secret.length<32||!authEqual(request.headers.get('x-telegram-bot-api-secret-token')||'',secret)) return new Response('Forbidden',{status:403});
    }
    try {
      const contentLength=Number(request.headers.get('content-length')||0);
      if (contentLength>150000) throw err('Слишком большой запрос',413);
      const body=await request.json();
      if(url.pathname==='/telegram') {await telegramUpdate(env,body);return new Response('OK');}
      if(url.pathname==='/admin') return replyJSON(await adminAction(env,body));
      return replyJSON(await callMini(env,body),200,origin);
    } catch(e) {
      if (url.pathname==='/telegram') {console.error('Webhook:',String(e.message));return new Response('Retry later',{status:500});}
      if(url.pathname==='/admin') console.error('Admin operation:',String(e.message));
      const code=e.status||500;
      return replyJSON({ok:false,error:code===500?'Внутренняя ошибка. Попробуй позже.':String(e.message)},code,origin);
    }
  },
  async scheduled(controller,env,ctx) {
    // Both triggers use UTC: Tuesday 07:00 UTC = 10:00 Moscow, and a
    // controlled continuation of invitations every 5 minutes.
    if (controller.cron==='0 7 * * 2') {
      if(!isPublic(env)||env.WEEKLY_ENABLED!=='yes') return;
      ctx.waitUntil((async()=>{
        const action=await activateDraft(env.DB,false);
        if (action.created&&env.INVITES_ENABLED==='yes') await sendInvitations(env,20);
      })());
      return;
    }
    if((controller.cron==='*/5 16-21 * * 2'||controller.cron==='*/5 * * * *')&&isPublic(env)) {
      ctx.waitUntil((async()=>{
        const active=await activeEdition(env.DB);
        if(env.INVITES_ENABLED==='yes'){
          const row=await env.DB.prepare('SELECT created_at FROM mini_editions WHERE run_id=?')
            .bind(active.id).first();
          if(row&&timestamp()-Number(row.created_at)<7*86400) await sendInvitations(env,20);
        }
        if(env.STATS_PUSH_ENABLED==='yes'&&timestamp()>=active.statsAt&&
           timestamp()-active.statsAt<6*3600){
          await dispatchEveningStats(env,20);
        }
      })());
    }
  }
};