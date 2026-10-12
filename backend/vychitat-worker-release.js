/**
 * вы́Читать Mini App — Cloudflare Workers + D1, migration candidate, 12.10.2026
 * Compatibility with GAS timed Mini App `pilot-timed.html` (actions state/open/answer/expire/share/checkSubscription).
 * ENV D1: DB; secrets: BOT_TOKEN, ADMIN_KEY (>=32 chars), TEST_CHAT_ID, WEBHOOK_SECRET;
 * ENV optional: ACCESS_MODE=pilot|public (defaults pilot), INVITES_ENABLED=yes|no, WEEKLY_ENABLED=yes|no.
 * Source questions staged via POST /admin {action:'stage',questions:[...]}; activate via action:'activate'.
 * NO setWebhook occurs automatically. Existing GAS installation remains unaffected until deliberate switchover.
 * Cron schedule (optional): 0 7 * * 2  [Tuesday 10:00 Moscow; UTC]
 */
const QCOUNT = 6;
const BASE_PAGE = 'https://franznovii.github.io/russian-language-quiz/quiz.html';
const ORIGINS = new Set(['https://franznovii.github.io', 'https://quiz.libera.me']);
const CHANNEL = '@posttsop';
const BOT_LINK = 'https://t.me/posttsop_test_bot?start=quiz';
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
  return {ok:true,userName:String(user.first_name||'Участник').slice(0,80),runId:run.id,
    questions:run.questions.map((q,index)=>(index>answers.length||(index===answers.length&&!timer))?null:
      {id:q.id,text:q.text,description:q.description,options:q.options,multiple:q.correct.length>1,timeSeconds:q.timeSeconds}),
    answers,activeTimer:timer?{questionId:next.id,deadlineMs:Number(timer.deadline_at),durationSec:next.timeSeconds}:null,
    complete,score:complete?answers.filter(a=>a.correct).length:null,statistics:null,
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
async function applyGate(env,run,user,state) {
  if (!state.complete) return state;
  state.subscriptionStatus=await getMembership(env,user.id);
  if (state.subscriptionStatus==='member'&&state.statsReady) state.statistics=await publicStatistics(env.DB,run);
  return state;
}
async function share(env,run,user) {
  const ans=await answersFor(env.DB,run,user);
  if (ans.length!==6) throw err('Сначала заверши все шесть вопросов');
  const score=ans.filter(x=>x.correct).length;
  const text=`Я набрал <b>${score} из 6</b> в тесте канала <a href="https://t.me/posttsop">вы́Читать</a> по русскому языку.\nА ты справишься лучше?\n\n<a href="${BOT_LINK}">Пройти тест</a>`;
  const record=await telegram(env,'savePreparedInlineMessage',{
    user_id:user.id,result:{type:'article',id:crypto.randomUUID().replaceAll('-',''),title:'Мой результат в тесте вы́Читать',
      input_message_content:{message_text:text,parse_mode:'HTML',link_preview_options:{is_disabled:true}},
      reply_markup:{inline_keyboard:[[{text:'Открыть тест',url:BOT_LINK}]]}},
    allow_user_chats:true,allow_group_chats:true,allow_bot_chats:false,allow_channel_chats:false
  });
  return {ok:true,shareId:record.id};
}
async function callMini(env,body) {
  const user=await telegramUser(body?.initData,env.BOT_TOKEN);
  const mode=String(env.ACCESS_MODE||'pilot').toLowerCase();
  if (!['pilot','public'].includes(mode)) throw err('Неверная настройка ACCESS_MODE',503);
  if (mode==='pilot'&&String(user.id)!==String(env.TEST_CHAT_ID||'')) throw err('Сейчас тест доступен только администратору',403);
  const action=String(body?.action||'');
  const run=await activeEdition(env.DB);
  if (mode==='public'&&!draftIsReady(run.questions)) throw err('Выпуск готовится. Попробуй позже.',503);
  if (action==='share') return share(env,run,user);
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
async function telegramUpdate(env,update) {
  if (!Number.isSafeInteger(update?.update_id)) throw err('Некорректное обновление',400);
  const dup=await env.DB.prepare('SELECT 1 FROM processed_updates WHERE update_id=?').bind(update.update_id).first();
  if (dup) return;
  const message=update.message;
  if (message?.chat?.type==='private'&&message.from?.id===message.chat.id&&
      /^\/start(?:\s+[A-Za-z0-9_-]{1,64})?\s*$/.test(String(message.text||''))) {
    await recordContact(env,message.from.id,message.from.first_name);
    const mode=String(env.ACCESS_MODE||'pilot').toLowerCase();
    let publicReady=false;
    if(mode==='public'){
      try{publicReady=draftIsReady((await activeEdition(env.DB)).questions);}
      catch(_){publicReady=false;}
    }
    const hasAccess=publicReady||String(message.from.id)===String(env.TEST_CHAT_ID||'');
    await telegram(env,'sendMessage',hasAccess?{
      chat_id:message.chat.id,
      text:'Привет! Это тест по русскому языку от канала <a href="https://t.me/posttsop">вы́Читать</a>.\n\nШесть вопросов, свой таймер на каждый и одна попытка.\n\nНажми кнопку, чтобы открыть приложение.',
      parse_mode:'HTML',link_preview_options:{is_disabled:true},
      reply_markup:{inline_keyboard:[[{text:'Открыть тест',web_app:{url:BASE_PAGE}}]]}
    }:{chat_id:message.chat.id,text:'Новый тест по русскому языку от вы́Читать пока готовится. Когда выйдет выпуск, пришлём кнопку «Открыть тест».'});
  }
  await env.DB.prepare('INSERT OR IGNORE INTO processed_updates(update_id) VALUES(?)').bind(update.update_id).run();
}

async function stageQuestions(db,body) {
  const questions=validateQuestions(body.questions);
  await db.prepare(`INSERT INTO mini_drafts(draft_id,questions_json,updated_at) VALUES(1,?,unixepoch())
    ON CONFLICT(draft_id) DO UPDATE SET questions_json=excluded.questions_json,updated_at=unixepoch()`)
    .bind(JSON.stringify(questions)).run();
  return {ok:true,questionCount:6};
}
async function activateDraft(db,force=false) {
  const draft=await db.prepare('SELECT questions_json FROM mini_drafts WHERE draft_id=1').first();
  if (!draft) throw err('Сначала загрузите шесть вопросов (stage)');
  const questions=validateQuestions(JSON.parse(draft.questions_json));
  const current=await db.prepare("SELECT questions_snapshot_json FROM mini_editions WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1").first();
  if (!force&&current&&current.questions_snapshot_json===JSON.stringify(questions)) return {ok:true,created:false,message:'Вопросы не изменились'};
  const runId=`timed_${crypto.randomUUID()}`;
  // A D1 transaction batch is atomic; active edition is swapped only after the insert succeeds.
  await db.batch([
    db.prepare("UPDATE mini_editions SET status='ARCHIVED' WHERE status='ACTIVE'"),
    db.prepare("INSERT INTO mini_editions(run_id,stats_after,status,questions_snapshot_json) VALUES(?,?,'ACTIVE',?)")
      .bind(runId,statsAtForToday(),JSON.stringify(questions))
  ]);
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
  return {ok:true,runId:run.id,started:users.size,completed:finished.length,incomplete:users.size-finished.length,average,
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
    case 'configureMenu': {
      if(!isPilot(env)&&!isPublic(env)) throw err('Неверный режим ACCESS_MODE');
      const active=await activeEdition(env.DB);
      if(isPublic(env)&&!draftIsReady(active.questions))
        throw err('В активном выпуске ещё тестовые вопросы. Публичное меню запрещено.');
      const privateOnly=isPilot(env);
      if(privateOnly&&!/^[1-9]\\d{4,19}$/.test(String(env.TEST_CHAT_ID||'')))
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

export default {
  async fetch(request,env) {
    const url=new URL(request.url),origin=request.headers.get('origin')||'';
    if (request.method==='GET'&&url.pathname==='/') {
      try {const r=await env.DB.prepare('SELECT 1 AS ok').first();return new Response(r?.ok===1?'vychitat Mini App: Worker + D1 OK':'Database error', {status:r?.ok===1?200:503,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});}
      catch { return new Response('Database connection failed',{status:503}); }
    }
    if (request.method==='OPTIONS'&&url.pathname==='/api') {
      return new Response(null,{status:204,headers:{'access-control-allow-origin':ORIGINS.has(origin)?origin:'null',
        'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'3600','vary':'Origin'}});
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
    if(controller.cron==='*/5 * * * *'&&env.ACCESS_MODE==='public'&&env.INVITES_ENABLED==='yes') {
      ctx.waitUntil((async()=>{
        const active=await env.DB.prepare("SELECT created_at FROM mini_editions WHERE status='ACTIVE' ORDER BY created_at DESC LIMIT 1").first();
        if(active&&timestamp()-Number(active.created_at)<7*86400) await sendInvitations(env,20);
      })());
    }
  }
};