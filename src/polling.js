// DNS-independent free Telegram pull transport, driven by minute Cron.
// Never advance update_id until the corresponding update was processed.
const PRIMARY='primary',LEASE_MS=115000;
async function query(db,sql,...params) {
 return db.prepare(sql).bind(...params).first();
}
async function execute(db,sql,...params){
 return db.prepare(sql).bind(...params).run();
}
export function pollBatchSize(env={}){
 const n=Number(env.TELEGRAM_POLL_BATCH||40);
 return Number.isSafeInteger(n)?Math.max(1,Math.min(100,n)):40;
}
export async function pollTelegram(env,{now=Date.now(),fetcher=fetch,handleUpdate}={}) {
 if(!env.DB||typeof handleUpdate!=='function')throw Error('Polling requires database and update handler');
 if(!env.TELEGRAM_BOT_TOKEN)throw Error('Missing Telegram bot token');
 const db=env.DB,lease=now+LEASE_MS;
 const acquired=await execute(db,'UPDATE telegram_poller SET lease_until=?,updated_at=? WHERE name=? AND lease_until<?',
   lease,now,PRIMARY,now);
 if(!acquired.meta?.changes)return {status:'locked',received:0,processed:0};
 let processed=0,received=0;
 try {
   const state=await query(db,'SELECT last_update_id FROM telegram_poller WHERE name=?',PRIMARY);
   const last=Number(state?.last_update_id??-1);
   const response=await fetcher('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getUpdates',{
     method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({offset:Math.max(0,last+1),
       limit:pollBatchSize(env),timeout:0,allowed_updates:['message']}),
     signal:AbortSignal.timeout(16000)
   });
   if(!response.ok)throw Error('Telegram polling HTTP '+response.status);
   const payload=await response.json();
   if(!payload?.ok||!Array.isArray(payload?.result))throw Error('Telegram polling rejected getUpdates');
   const updates=payload.result;
   received=updates.length;
   let cursor=last;
   for(const update of updates){
     const id=Number(update?.update_id);
     if(!Number.isSafeInteger(id)||id<0)throw Error('Telegram polling invalid update_id');
     if(id<=cursor)continue;
     // Persist the message and command effects BEFORE acknowledging that ID.
     // Replays after crashes remain at-least-once; message storage deduplicates.
     await handleUpdate(update,env,fetcher,now);
     // Fencing: an expired invocation must not overwrite a newer poller's
     // cursor. Monotonic updates prevent offset regression on overlapping Cron.
     const checkpoint=await execute(db,`UPDATE telegram_poller
       SET last_update_id=?,updated_at=? WHERE name=? AND lease_until=? AND last_update_id<?`,
       id,now,PRIMARY,lease,id);
     if(!checkpoint.meta?.changes)
       throw Error('Telegram polling lease lost before checkpoint; retry unacknowledged update');
     cursor=id;
     processed++;
   }
   return {status:'ok',received,processed,last_update_id:cursor};
 }finally{
   // Never lose messages due to an expired lease or unhandled exception.
   // Never release another invocation's lease after ours has expired.
   await execute(db,'UPDATE telegram_poller SET lease_until=0,updated_at=? WHERE name=? AND lease_until=?',
     now,PRIMARY,lease);
 }
}
