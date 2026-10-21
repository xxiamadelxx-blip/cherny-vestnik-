import {
  ONE_DAY_MS, MESSAGE_RETENTION_MS, MEMORY_RETENTION_MS, localClock,
  scheduledDue, normalizeMessage, splitTelegramText, packTranscript
} from './core.js';
import {createDigest,analyzeChunk,composeDigest} from './ai.js';
import {send, isAdmin} from './telegram.js';
import {GroqDeferredError,readGroqBudget,quotaWaitUntil} from './quota.js';

const OK = () => new Response('ok', {status:200});
const PUBLIC_VERSION = '0.2.0';

function authorizedWebhook(request, secret) {
  const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secret || !supplied || secret.length !== supplied.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

async function row(db, sql, ...params) {return db.prepare(sql).bind(...params).first();}
async function run(db, sql, ...params) {return db.prepare(sql).bind(...params).run();}
async function all(db, sql, ...params) {return (await db.prepare(sql).bind(...params).all()).results || [];}

function commandFrom(text) {
  const match = String(text || '').match(/^\/(\w+)(?:@\w+)?(?:\s+([^\n]+))?\s*$/i);
  return match ? {name:match[1].toLowerCase(), arg:(match[2] || '').trim()} : null;
}

export async function handleUpdate(update, env, fetcher = fetch, now = Date.now()) {
  const message = update?.message;
  if (!message || message.from?.is_bot || !['group', 'supergroup'].includes(message.chat?.type)) return;
  const chatId = String(message.chat.id);
  const cmd = commandFrom(message.text);
  if (cmd) {
    // Personal deletion is available even if this user is not an admin.
    if (cmd.name === 'forgetme') {
      if (!message.from?.id) return;
      await run(env.DB, 'UPDATE chats SET privacy_epoch=privacy_epoch+1 WHERE chat_id=?', chatId);
      await run(env.DB, 'INSERT OR IGNORE INTO optouts(chat_id,user_id,created_at) VALUES(?,?,?)', chatId,String(message.from.id),now);
      await run(env.DB, 'DELETE FROM messages WHERE chat_id=? AND user_id=?', chatId, String(message.from.id));
      await run(env.DB, 'DELETE FROM memories WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM digest_chunks WHERE chat_id=?', chatId);
      await run(env.DB, "DELETE FROM digests WHERE chat_id=? AND status!='sent'", chatId);
      await run(env.DB, "UPDATE digests SET body=NULL WHERE chat_id=? AND status='sent'", chatId);
      await send(env, chatId, '🧹 Твои сохранённые сообщения удалены, дальнейший сбор твоих сообщений отключён, память шуток очищена. Чтобы разрешить сбор снова, напиши /optin. Уже опубликованные выпуски в Telegram автоматически не удаляются.', fetcher);
      return;
    }
    if (cmd.name === 'optin') {
      if (!message.from?.id) return;
      await run(env.DB,'DELETE FROM optouts WHERE chat_id=? AND user_id=?', chatId,String(message.from.id));
      await send(env,chatId,'✅ Снова разрешён сбор твоих новых сообщений.',fetcher);
      return;
    }
    if (!['enable','resume','disable','pause','status','time','now','wipe','help'].includes(cmd.name)) return;
    if (!message.from?.id || !await isAdmin(env, chatId, message.from.id, fetcher)) {
      await send(env, chatId, '⛔ Эту команду может выполнить только администратор группы.', fetcher);
      return;
    }
    if (cmd.name === 'help') {
      await send(env, chatId, '💀 /enable — включить сбор сообщений\n/disable — пауза\n/time 21:00 — время по Москве\n/now — выпустить сейчас (не чаще одного раза в день)\n/status — состояние\n/forgetme — удалить свои сообщения и отказаться от будущего сбора\n/optin — возобновить сбор своих сообщений\n/wipe — удалить весь архив группы и отключить бота', fetcher);
    } else if (['enable','resume'].includes(cmd.name)) {
      await run(env.DB, `INSERT INTO chats(chat_id,title,enabled,created_at,updated_at)
        VALUES(?,?,1,?,?) ON CONFLICT(chat_id) DO UPDATE SET enabled=1,title=excluded.title,updated_at=excluded.updated_at`,
      chatId, String(message.chat.title || '').slice(0,100), now, now);
      await send(env, chatId, '💀 Чёрный Вестник включён. Следующий выпуск в 21:00 по Москве (или в установленное /time время).\n⚠️ Бот собирает новые сообщения группы для сатирического дайджеста. Предупредите участников. /forgetme удаляет сохранённые сообщения пользователя; /disable ставит сбор на паузу. Проверьте, что Privacy Mode у BotFather отключён.', fetcher);
    } else if (['disable','pause'].includes(cmd.name)) {
      await run(env.DB, 'UPDATE chats SET enabled=0,privacy_epoch=privacy_epoch+1,updated_at=? WHERE chat_id=?', now, chatId);
      await run(env.DB, "DELETE FROM digests WHERE chat_id=? AND status!='sent'", chatId);
      await run(env.DB, 'DELETE FROM digest_chunks WHERE chat_id=?', chatId);
      await send(env, chatId, '⏸ Бот приостановлен, новые сообщения не сохраняются.', fetcher);
    } else if (cmd.name === 'status') {
      const chat = await row(env.DB, 'SELECT enabled,digest_hhmm FROM chats WHERE chat_id=?', chatId);
      const count = await row(env.DB, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id=?', chatId);
      const quota=await readGroqBudget(env);
      const next=quotaWaitUntil(quota,Date.now(),env);
      const until=next?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(next)):null;
      const usage=quota?.day_utc===new Date().toISOString().slice(0,10)?Number(quota.used_tokens||0):0;
      const pending=await row(env.DB,"SELECT local_day,window_start,window_end FROM digests WHERE chat_id=? AND status!='sent' AND window_end IS NOT NULL ORDER BY local_day LIMIT 1",chatId);
      const done=pending?await row(env.DB,'SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks WHERE chat_id=? AND local_day=?',chatId,pending.local_day):null;
      const total=pending?await row(env.DB,'SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND posted_at>=? AND posted_at<?',chatId,pending.window_start,pending.window_end):null;
      const progress=pending?'\nОбработка '+pending.local_day+': '+(done?.n||0)+'/'+(total?.n||0)+' сообщений.':'';
      const quotaLine=next?'⏳ Groq: пауза до '+until+' по Москве.':'✅ Groq: запросы разрешены.';
      await send(env,chatId,`🗞 Вестник: ${chat?.enabled?'включён':'выключен'}\nВремя: ${chat?.digest_hhmm||'21:00'} по Москве\nСообщений в памяти: ${count?.n||0}\nМодель: ${env.GROQ_MODEL||'qwen/qwen3.8-27b'}\n${quotaLine}\nТокены бота сегодня (по данным API): ${usage}.${progress}`,fetcher);;
    } else if (cmd.name === 'time') {
      if (!/^([01]\d|2[0-3]):(00|15|30|45)$/.test(cmd.arg)) {
        await send(env, chatId, 'Время укажи по Москве и кратно 15 минутам: /time 21:00', fetcher);
        return;
      }
      await run(env.DB, 'UPDATE chats SET digest_hhmm=?,updated_at=? WHERE chat_id=?', cmd.arg, now, chatId);
      await send(env, chatId, `⏰ Каждый день в ${cmd.arg} по Москве.`, fetcher);
    } else if (cmd.name === 'now') {
      const chat = await row(env.DB, 'SELECT * FROM chats WHERE chat_id=?', chatId);
      if (!chat?.enabled) {
        await send(env, chatId, 'Сначала /enable.', fetcher);
        return;
      }
      const outcome = await publishDigest(env, chatId, now, fetcher);
      if (outcome === 'already_sent') await send(env, chatId, 'Сегодня выпуск уже опубликован. Следующий завтра.', fetcher);
      if (outcome === 'locked') await send(env, chatId, 'Выпуск уже собирается другим запуском.', fetcher);
      if (outcome === 'processing') await send(env, chatId, '🧠 Полный анализ переписки идёт по частям. Каждое сообщение будет учтено; выпуск появится после завершения анализа, без выборки.', fetcher);
      if (outcome === 'waiting') await send(env,chatId,'⏳ Groq достиг временного лимита. Обработанные сообщения сохранены, Cron продолжит после сброса квоты. Проверяй /status.',fetcher);
    } else if (cmd.name === 'wipe') {
      await run(env.DB, 'DELETE FROM messages WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM digests WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM memories WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM digest_chunks WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM optouts WHERE chat_id=?', chatId);
      await run(env.DB, 'DELETE FROM chats WHERE chat_id=?', chatId);
      await send(env, chatId, '🧹 Архив группы и настройки полностью удалены. Бот выключен. Для повторного включения: /enable.', fetcher);
    }
    return;
  }
  const cleaned = normalizeMessage(message);
  if (!cleaned) return;
  const enabled = await row(env.DB, 'SELECT enabled FROM chats WHERE chat_id=?', chatId);
  if (!enabled?.enabled) return;
  const optedOut = await row(env.DB, 'SELECT 1 AS yes FROM optouts WHERE chat_id=? AND user_id=?', chatId, cleaned.user_id);
  if (optedOut) return;
  await run(env.DB, `INSERT OR IGNORE INTO messages
    (chat_id,message_id,user_id,display_name,body,posted_at) VALUES(?,?,?,?,?,?)`,
    cleaned.chat_id,cleaned.message_id,cleaned.user_id,cleaned.display_name,cleaned.body,cleaned.posted_at);
}

export async function publishDigest(env, chatId, now = Date.now(), fetcher = fetch, dayOverride = null) {
  const db = env.DB;
  const day = dayOverride || localClock(now, env.BOT_TIME_ZONE || 'Europe/Moscow').day;
  await run(db, `INSERT OR IGNORE INTO digests(chat_id,local_day,status,lease_until,next_part,updated_at)
    VALUES(?,?,'pending',0,0,?)`, chatId, day, now);
  const lease = now + 120_000;
  const claim = await run(db, `UPDATE digests SET lease_until=?, status='working', updated_at=?
    WHERE chat_id=? AND local_day=? AND status!='sent' AND lease_until<?`,
  lease, now, chatId, day, now);
  if (!claim.meta?.changes) {
    const old = await row(db, 'SELECT status FROM digests WHERE chat_id=? AND local_day=?', chatId, day);
    return old?.status === 'sent' ? 'already_sent' : 'locked';
  }
  try {
    const snapshot = await row(db,'SELECT enabled,privacy_epoch FROM chats WHERE chat_id=?',chatId);
    if (!snapshot?.enabled) throw new Error('Chat disabled or erased during publish');
    const checkConsent = async () => {
      const current = await row(db,'SELECT enabled,privacy_epoch FROM chats WHERE chat_id=?',chatId);
      if (!current?.enabled || current.privacy_epoch !== snapshot.privacy_epoch) {
        throw new Error('Chat permission changed during publish');
      }
    };
    let job = await row(db, 'SELECT * FROM digests WHERE chat_id=? AND local_day=?', chatId, day);
    if (!job.body) {
      const prev = await row(db, `SELECT MAX(window_end) AS last_end FROM digests
        WHERE chat_id=? AND status='sent' AND local_day!=?`, chatId, day);
      const start = job.window_start ?? prev?.last_end ?? now - ONE_DAY_MS;
      const end = job.window_end ?? now;
      if (job.window_end == null) {
        await run(db, 'UPDATE digests SET window_start=?,window_end=? WHERE chat_id=? AND local_day=?', start,end,chatId,day);
      }
      const n = await row(db, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND posted_at>=? AND posted_at<?', chatId,start,end);
      const total = Number(n?.n || 0);
      const smallRows = total>0 && total<=40 ? await all(db,`SELECT message_id,user_id,display_name,body,posted_at FROM messages
        WHERE chat_id=? AND posted_at>=? AND posted_at<? ORDER BY posted_at,message_id`,chatId,start,end) : [];
      let body;
      if (total === 0) {
        body = `💀 ЧЁРНЫЙ ВЕСТНИК | ${day}\n\nСегодня в чате тишина. Кажется, здравый смысл наконец-то победил. Или все просто спят, блядь.`;
      } else if (total <= 40 && packTranscript(smallRows).count === total) {
        const messages=smallRows;
        // No sampling or partial report even for small chats.
        body=(await createDigest({env,day,total,rows:messages,previous:await all(db,
          'SELECT excerpt FROM memories WHERE chat_id=? ORDER BY local_day DESC LIMIT 2',chatId),fetcher})).body;
      } else {
        // Once or twice per minute: exhaustively process consecutive batches,
        // store AI evidence, and resume safely on the next Cron invocation.
        let chunks=await all(db, `SELECT chunk_no,processed,ids_json,note FROM digest_chunks
          WHERE chat_id=? AND local_day=? ORDER BY chunk_no`,chatId,day);
        let processed=chunks.reduce((sum,c)=>sum+Number(c.processed),0);
        if(processed>total) throw new Error('Source changed during analysis; refusing inaccurate coverage');
        for(let batchNo=0; batchNo<2 && processed<total; batchNo++) {
          const rows=await all(db,`SELECT message_id,user_id,display_name,body,posted_at FROM messages
            WHERE chat_id=? AND posted_at>=? AND posted_at<? ORDER BY posted_at,message_id LIMIT 40 OFFSET ?`,
            chatId,start,end,processed);
          const packet=packTranscript(rows);
          if(!packet.count) throw new Error('Incomplete transcript; refusing partial newspaper');
          const evidence=await analyzeChunk({env,rows:rows.slice(0,packet.count),fetcher});
          await checkConsent();
          await run(db,`INSERT INTO digest_chunks(chat_id,local_day,chunk_no,processed,ids_json,note,created_at)
            VALUES(?,?,?,?,?,?,?)`,chatId,day,chunks.length,packet.count,JSON.stringify(evidence.ids),evidence.note,now);
          chunks.push({chunk_no:chunks.length,processed:packet.count,ids_json:JSON.stringify(evidence.ids),note:evidence.note});
          processed+=packet.count;
        }
        if(processed<total) {
          await run(db,"UPDATE digests SET lease_until=0,status='pending',updated_at=? WHERE chat_id=? AND local_day=?",now,chatId,day);
          return 'processing';
        }
        if(processed!==total) throw new Error('Incomplete coverage');
        const previous=await all(db,'SELECT excerpt FROM memories WHERE chat_id=? ORDER BY local_day DESC LIMIT 2',chatId);
        body=(await composeDigest({env,day,total,notes:chunks.map(c=>({note:c.note,ids:JSON.parse(c.ids_json)})),previous,fetcher})).body;
        body += `\n\n📊 Прочитано и обработано: ${processed} из ${total} сообщений.`;
      }
      await checkConsent();
      await run(db, `UPDATE digests SET body=?,status='working',updated_at=?
        WHERE chat_id=? AND local_day=?`, body,now,chatId,day);
      job = {...job, body, next_part:0};
    }
    const pieces = splitTelegramText(job.body);
    for (let i = Number(job.next_part); i < pieces.length; i++) {
      await checkConsent();
      await send(env,chatId,pieces[i],fetcher);
      await run(db, 'UPDATE digests SET next_part=?,updated_at=? WHERE chat_id=? AND local_day=?',i+1,now,chatId,day);
    }
    await run(db, `UPDATE digests SET status='sent',lease_until=0,posted_at=?,updated_at=? WHERE chat_id=? AND local_day=?`,now,now,chatId,day);
    await run(db,`INSERT INTO memories(chat_id,local_day,excerpt,created_at) VALUES(?,?,?,?)
      ON CONFLICT(chat_id,local_day) DO UPDATE SET excerpt=excluded.excerpt,created_at=excluded.created_at`,
      chatId,day,job.body.slice(0,520),now);
    return 'sent';
  } catch (err) {
    if (/permission changed|disabled or erased/.test(String(err))) {
      await run(db, "DELETE FROM digests WHERE chat_id=? AND local_day=? AND status!='sent'",chatId,day);
    }
    await run(db, `UPDATE digests SET lease_until=0,status='pending',updated_at=?
      WHERE chat_id=? AND local_day=? AND status!='sent'`, now,chatId,day);
    if (err instanceof GroqDeferredError) return 'waiting';
    throw err;
  }
}

export async function runCron(env, now = Date.now(), fetcher = fetch) {
  // Retain at most four days of raw text and two weeks of previous-joke excerpts.
  await run(env.DB,`DELETE FROM messages WHERE posted_at<? AND NOT EXISTS (
    SELECT 1 FROM digests d WHERE d.chat_id=messages.chat_id
      AND d.status!='sent' AND d.window_start IS NOT NULL
      AND d.window_end IS NOT NULL
      AND messages.posted_at>=d.window_start AND messages.posted_at<d.window_end
  )`,now-MESSAGE_RETENTION_MS);
  await run(env.DB,'DELETE FROM memories WHERE created_at<?',now-MEMORY_RETENTION_MS);
  await run(env.DB,"DELETE FROM digests WHERE updated_at<? AND status='sent'",now-30*ONE_DAY_MS);
  await run(env.DB,`DELETE FROM digest_chunks WHERE created_at<? AND NOT EXISTS (
    SELECT 1 FROM digests d WHERE d.chat_id=digest_chunks.chat_id
      AND d.local_day=digest_chunks.local_day AND d.status!='sent')`,now-4*ONE_DAY_MS);
  const {hhmm} = localClock(now,env.BOT_TIME_ZONE || 'Europe/Moscow');
  const chats = await all(env.DB,`SELECT c.chat_id,c.digest_hhmm,
    (SELECT d.local_day FROM digests d WHERE d.chat_id=c.chat_id AND d.status!='sent' AND d.window_end IS NOT NULL ORDER BY d.local_day LIMIT 1) AS pending_day
    FROM chats c WHERE c.enabled=1`);
  const outcomes = [];
  for (const chat of chats) {
    if (!chat.pending_day && !scheduledDue(chat.digest_hhmm,hhmm)) continue;
    try {outcomes.push({chat_id:chat.chat_id,result:await publishDigest(env,chat.chat_id,now,fetcher,chat.pending_day||null)});}
    catch(err) {console.warn(`Digest failed for chat ${chat.chat_id}: ${String(err).slice(0,120)}`); outcomes.push({chat_id:chat.chat_id,result:'failed'});}
  }
  return outcomes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz')
      return Response.json({ok:true,version:PUBLIC_VERSION});
    if (request.method !== 'POST' || url.pathname !== '/webhook') return new Response('not found',{status:404});
    if (!authorizedWebhook(request,env.TELEGRAM_WEBHOOK_SECRET)) return new Response('forbidden',{status:403});
    try {
      const update = await request.json();
      await handleUpdate(update,env);
      return OK();
    } catch (err) {
      // Telegram retries 5xx. Never log message contents, tokens or request bodies.
      console.error('Webhook error:', String(err).slice(0,160));
      return new Response('temporary error',{status:500});
    }
  },
  async scheduled(_event,env) {await runCron(env);}
};