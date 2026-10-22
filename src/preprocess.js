// Opportunistic pre-digest analysis. Telegram is polled and safely persisted
// before this runs. Save consecutive evidence batches during the day, while
// reserving the daily Groq budget for the final newspaper and fact-check.
import {localClock,packTranscript,ONE_DAY_MS} from './core.js';
import {analyzeChunk} from './ai.js';
import {reconcileAnalyzedPrefix} from './prefix.js';
import {readGroqBudget,quotaWaitUntil,GroqDeferredError} from './quota.js';

const LEASE_MS=115_000, MIN_AGE_MS=60*60_000, MIN_AGED_MESSAGES=24;
const DEFAULT_PREPROCESS_BUDGET=120_000, FINAL_TOKEN_RESERVE=20_000;
async function row(db,sql,...args){return db.prepare(sql).bind(...args).first();}
async function all(db,sql,...args){return (await db.prepare(sql).bind(...args).all()).results||[];}
async function run(db,sql,...args){return db.prepare(sql).bind(...args).run();}
function positive(value,fallback) {
  const n=Number(value);
  return Number.isFinite(n)&&n>0?Math.floor(n):fallback;
}
// Zero new Groq requests once the pre-analysis slice of the budget is spent.
// The regular publication path can still use the reserved tokens.
export function canPreprocessWithQuota(state,now=Date.now(),env={}) {
  if(quotaWaitUntil(state,now,env))return false;
  const daily=positive(env.GROQ_DAILY_TOKEN_SOFT_LIMIT,180_000);
  const desired=positive(env.GROQ_PREPROCESS_TOKEN_SOFT_LIMIT,DEFAULT_PREPROCESS_BUDGET);
  const limit=Math.max(0,Math.min(desired,daily-FINAL_TOKEN_RESERVE));
  const today=new Date(now).toISOString().slice(0,10);
  const used=state?.day_utc===today?Number(state.used_tokens||0):0;
  return limit>0&&used<limit;
}
// Returns preprocessed, idle, locked, closed, waiting, or disabled.
// No synthetic paper is ever published from this function.
export async function preprocessDigest({env,chatId,now=Date.now(),fetcher=fetch}) {
  const db=env.DB,day=localClock(now,env.BOT_TIME_ZONE||'Europe/Moscow').day;
  const chat=await row(db,'SELECT enabled,privacy_epoch FROM chats WHERE chat_id=?',String(chatId));
  if(!chat?.enabled)return 'disabled';
  const existing=await row(db,'SELECT status,window_start,window_end,lease_until FROM digests WHERE chat_id=? AND local_day=?',String(chatId),day);
  if(existing && (existing.window_end!==null || !['pending','working'].includes(existing.status)))return 'closed';
  // Freeze the first open window's lower boundary. It starts at the last
  // completed window, or at the earliest captured message for a new group.
  const prev=await row(db,'SELECT MAX(window_end) AS last_end FROM digests WHERE chat_id=? AND local_day!=? AND window_end IS NOT NULL',String(chatId),day);
  const earliest=await row(db,'SELECT MIN(posted_at) AS first_at FROM messages WHERE chat_id=?',String(chatId));
  const start=existing?.window_start??prev?.last_end??(earliest?.first_at==null?null:Math.min(Number(earliest.first_at),now-ONE_DAY_MS));
  if(start===null||start===undefined||Number(start)>=now)return 'idle';

  // Even a quiet day needs a durable open window. If the scheduled Cron is
  // unavailable at 21:00, the next day can still close the right day.
  await run(db,`INSERT OR IGNORE INTO digests
    (chat_id,local_day,status,lease_until,next_part,updated_at,window_start)
    VALUES(?,?,'pending',0,0,?,?)`,String(chatId),day,now,start);
  const count=Number((await row(db,'SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND posted_at>=? AND posted_at<?',String(chatId),start,now))?.n||0);
  const processed=Number((await row(db,'SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks WHERE chat_id=? AND local_day=?',String(chatId),day))?.n||0);
  // Deletions normally invalidate chunks via privacy_epoch; if anything else
  // moved the source cursor, let the publication path verify completeness.
  if(count<=processed)return 'idle';
  const available=await all(db,`SELECT message_id,display_name,body,posted_at,user_id
    FROM messages WHERE chat_id=? AND posted_at>=? AND posted_at<?
    ORDER BY posted_at,message_id LIMIT 41 OFFSET ?`,String(chatId),start,now,processed);
  const batch=packTranscript(available.slice(0,40));
  if(!batch.count)return 'idle';
  const full=batch.count===40 || available.length>batch.count;
  const aged=available.length>=MIN_AGED_MESSAGES && now-Number(available[0].posted_at)>=MIN_AGE_MS;
  // Avoid charging Groq for every single incoming message.
  if(!full&&!aged)return 'idle';
  if(!canPreprocessWithQuota(await readGroqBudget(env),now,env))return 'waiting';

  const lease=now+LEASE_MS;
  const claim=await run(db,`UPDATE digests SET lease_until=?,status='working',updated_at=?
    WHERE chat_id=? AND local_day=? AND window_end IS NULL
      AND status IN ('pending','working') AND lease_until<?`,
    lease,now,String(chatId),day,now);
  if(!claim.meta?.changes)return 'locked';
  try{
    const stillAllowed=async()=>{
      const current=await row(db,'SELECT enabled,privacy_epoch FROM chats WHERE chat_id=?',String(chatId));
      if(!current?.enabled||current.privacy_epoch!==chat.privacy_epoch)
        throw Error('Chat permission changed during preprocessing');
    };
    await stillAllowed();
    const prefix=await reconcileAnalyzedPrefix(db,chatId,day,start,now);
    const current=await all(db,`SELECT message_id,display_name,body,posted_at,user_id
      FROM messages WHERE chat_id=? AND posted_at>=? AND posted_at<?
      ORDER BY posted_at,message_id LIMIT 40 OFFSET ?`,String(chatId),start,now,prefix.processed);
    const actualBatch=packTranscript(current);
    if(!actualBatch.count)return 'idle';
    const next=await row(db,'SELECT COALESCE(MAX(chunk_no),-1)+1 AS n FROM digest_chunks WHERE chat_id=? AND local_day=?',String(chatId),day);
    const output=await analyzeChunk({env,rows:current.slice(0,actualBatch.count),fetcher});
    await stillAllowed();
    // Fencing and consent checks are part of the atomic chunk insert. A
    // stale cron after a lease takeover must not record its old evidence.
    const saved=await run(db,`INSERT INTO digest_chunks
      (chat_id,local_day,chunk_no,processed,ids_json,note,created_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS (
        SELECT 1 FROM digests d JOIN chats c ON c.chat_id=d.chat_id
        WHERE d.chat_id=? AND d.local_day=? AND d.window_end IS NULL
          AND d.lease_until=? AND d.status='working'
          AND c.enabled=1 AND c.privacy_epoch=?
      )`,String(chatId),day,Number(next?.n||0),output.count,JSON.stringify(output.ids),output.note,now,
      String(chatId),day,lease,chat.privacy_epoch);
    if(saved.meta?.changes!==1)throw Error('Preprocessing lease or consent lost before checkpoint');
    return 'preprocessed';
  }catch(error){
    if(error instanceof GroqDeferredError)return 'waiting';
    throw error;
  }finally{
    await run(db,`UPDATE digests SET lease_until=0,status='pending',updated_at=?
      WHERE chat_id=? AND local_day=? AND lease_until=?
        AND status='working' AND window_end IS NULL`,now,String(chatId),day,lease);
  }
}
