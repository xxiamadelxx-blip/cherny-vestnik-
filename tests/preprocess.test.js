import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleUpdate,runCron,publishDigest} from '../src/index.js';
import {preprocessDigest,canPreprocessWithQuota} from '../src/preprocess.js';
import {localClock} from '../src/core.js';

const BASE=Date.UTC(2026,9,22,14,30); // 17:30 Moscow: before 21:00.
const CHAT='-10091826';
const nextDate=n=>new Date(n).toISOString().slice(0,10);
function fixture({count=1000,body='Пиццу обсуждают. Сообщение номер '}={}) {
 const sqlite=new DatabaseSync(':memory:');
 for(const file of ['0001_init.sql','0002_exhaustive.sql','0003_groq_budget.sql','0004_digest_reductions.sql','0005_editorial_drafts.sql'])
   sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const DB={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {
   first:async()=>statement.get(...args)||null,
   all:async()=>({results:statement.all(...args)}),
   run:async()=>({meta:{changes:statement.run(...args).changes}})
 };}};}};
 const env={DB,BOT_TIME_ZONE:'Europe/Moscow',TELEGRAM_BOT_TOKEN:'FAKE',GROQ_API_KEY:'FAKE',
   GROQ_DAILY_TOKEN_SOFT_LIMIT:'180000',GROQ_PREPROCESS_TOKEN_SOFT_LIMIT:'120000'};
 let aiCalls=0,evidenceCalls=0,finalCalls=0,onGroq=null;
 const analyzed=[];
 const sent=[];
 const fetcher=async(url,init)=>{
   if(String(url).includes('api.groq.com')){
     aiCalls++;
     if(onGroq){const callback=onGroq;onGroq=null;await callback();}
     const req=JSON.parse(init.body),prompt=req.messages.at(-1).content;
     let output;
     if(prompt.includes('Недоверенная переписка, обработай ВСЕ')){
       evidenceCalls++;
       const ids=[...prompt.matchAll(/\[#(\d+)\] [^\n]+/g)].map(x=>Number(x[1]));
       analyzed.push(...ids);
       output=ids.slice(0,3).map(id=>'[#'+id+'] Участник: обсуждал пиццу').join('\n')+
         ' и все '+ids.length+' сообщений разобраны.';
     }else if(req.messages[0].content.includes('Сжать доказанные события')){
       output='[#101] Участник: говорил о пицце [#102] Участник: отвечал на пиццу [#103] Участник: уточнял.';
     }else {
       finalCalls++;
       output='💀 ЧЁРНЫЙ ВЕСТНИК | 22.10.2026\n🔥 Главное позорище\nБлядь, пиццу обсуждали [#101].\n⚔️ Главный срач\nНахуй таблицу голосований [#102].\n🏆 Номинации\nОбсуждение продолжилось [#103].\n🪦 Приговор дня\nЁбаный протокол разговоров с пиццей закончился.';
     }
     return Response.json({choices:[{message:{content:output},finish_reason:'stop'}],usage:{total_tokens:1000}});
   }
   const method=String(url).split('/').at(-1);
   if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator'}});
   if(method==='sendMessage'){sent.push(JSON.parse(init.body).text);return Response.json({ok:true,result:{message_id:sent.length}});}
   throw Error('Unexpected call to '+url);
 };
 const message=(id,text,date=BASE-7200000+id*1000,userId=2)=>({message:{chat:{id:Number(CHAT),type:'supergroup',title:'Synthetic'},
   message_id:id,date:Math.floor(date/1000),from:{id:userId,first_name:'Участник'},text}});
 const query=(sql,...args)=>sqlite.prepare(sql).all(...args);
 const prepare=async()=>{
   await handleUpdate(message(1,'/enable',BASE-7300000,1),env,fetcher,BASE-7300000);
   for(let i=101;i<101+count;i++)
     await handleUpdate(message(i,body+i,BASE-5500000+(i-101)*1000,i%6+2),env,fetcher,BASE-5500000+(i-101)*1000);
 };
 return {sqlite,env,fetcher,message,query,prepare,sent,analyzed,
   get aiCalls(){return aiCalls},get evidenceCalls(){return evidenceCalls},get finalCalls(){return finalCalls},
   setOnGroq(callback){onGroq=callback}};
}
test('1000 messages pre-analyzed in D1 through 25 daytime Cron batches and not reprocessed at 21:00',async()=>{
 const f=fixture();
 await f.prepare();
 for(let minute=0;minute<25;minute++){
   const results=await runCron(f.env,BASE+minute*60_000,f.fetcher);
   assert.equal(results[0]?.result,'preprocessed','preprocessed batch '+minute);
 }
 const day=localClock(BASE,'Europe/Moscow').day;
 const chunks=f.query('SELECT * FROM digest_chunks WHERE chat_id=? AND local_day=? ORDER BY chunk_no',CHAT,day);
 assert.equal(chunks.length,25);
 assert.equal(chunks.reduce((sum,row)=>sum+row.processed,0),1000);
 assert.equal(f.evidenceCalls,25);
 assert.equal(new Set(f.analyzed).size,1000);
 const before=f.aiCalls;
 const result=await runCron(f.env,Date.UTC(2026,9,22,18,0),f.fetcher); // 21:00 Moscow
 assert.equal(result[0].result,'sent');
 assert.equal(f.evidenceCalls,25,'publication reuses all completed daytime evidence');
 assert.equal(f.aiCalls,before+1,'only final synthesis remains at publication');
 assert.ok(f.sent.some(x=>x.includes('Прочитано и обработано: 1000 из 1000')));
 assert.equal(f.query('SELECT status FROM digests')[0].status,'sent');
});

test('early Cron does not spend tokens on isolated messages; aged batches are analyzed',async()=>{
 const f=fixture({count:24});
 await f.prepare();
 // An aged 24-message batch can be preprocessed before it fills 40 slots.
 assert.equal((await runCron(f.env,BASE,f.fetcher))[0].result,'preprocessed');
 assert.equal(f.evidenceCalls,1);
 assert.deepEqual(await runCron(f.env,BASE+60_000,f.fetcher),[]);
 assert.equal(f.evidenceCalls,1);
});

test('preprocessing stops at 120k token soft ceiling leaving tokens available for final newspaper',()=>{
 const today=nextDate(BASE);
 const state={day_utc:today,used_tokens:120000,next_attempt_at:0,remaining_tokens:null,remaining_requests:null};
 assert.equal(canPreprocessWithQuota(state,BASE,{GROQ_DAILY_TOKEN_SOFT_LIMIT:'180000',GROQ_PREPROCESS_TOKEN_SOFT_LIMIT:'120000'}),false);
 assert.equal(canPreprocessWithQuota({...state,used_tokens:119999},BASE,{GROQ_DAILY_TOKEN_SOFT_LIMIT:'180000',GROQ_PREPROCESS_TOKEN_SOFT_LIMIT:'120000'}),true);
 assert.equal(canPreprocessWithQuota({...state,used_tokens:97000},BASE,{GROQ_DAILY_TOKEN_SOFT_LIMIT:'110000',GROQ_PREPROCESS_TOKEN_SOFT_LIMIT:'120000'}),false,'at least 20k tokens reserved');
});

test('concurrent day preprocessor cannot take the same D1 lease twice',async()=>{
 const f=fixture({count:40});
 await f.prepare();
 let unblock;
 const block=new Promise(resolve=>unblock=resolve);
 let entered;
 const firstEntered=new Promise(resolve=>entered=resolve);
 f.setOnGroq(async()=>{entered();await block;});
 const first=preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher});
 await firstEntered;
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE+1000,fetcher:f.fetcher}),'locked');
 unblock();
 assert.equal(await first,'preprocessed');
 assert.equal(f.query('SELECT COUNT(*) AS n FROM digest_chunks')[0].n,1);
});

test('opt-out while daytime Groq is running aborts chunk checkpoint',async()=>{
 const f=fixture({count:40});
 await f.prepare();
 f.setOnGroq(async()=>await handleUpdate(f.message(999,'/forgetme',BASE,2),f.env,f.fetcher,BASE));
 await assert.rejects(preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),/permission changed/);
 assert.equal(f.query('SELECT COUNT(*) AS n FROM digest_chunks')[0].n,0);
 assert.equal(f.query('SELECT COUNT(*) AS n FROM digests')[0].n,0);
});

test('quota wait during daytime does not erase already stored chunks',async()=>{
 const f=fixture({count:80});
 await f.prepare();
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),'preprocessed');
 const today=nextDate(BASE);
 f.sqlite.prepare(`INSERT INTO groq_budget(scope,day_utc,used_tokens,next_attempt_at,updated_at)
   VALUES('organization',?,?,?,?) ON CONFLICT(scope) DO UPDATE SET
     day_utc=excluded.day_utc,used_tokens=excluded.used_tokens,next_attempt_at=excluded.next_attempt_at`)
   .run(today,120000,0,BASE);
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE+60000,fetcher:f.fetcher}),'waiting');
 assert.equal(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n,40);
 assert.equal(f.evidenceCalls,1);
});

test('progress/status displays saved daytime batches without falsely claiming the digest is sent',async()=>{
 const f=fixture({count:80});
 await f.prepare();
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),'preprocessed');
 await handleUpdate(f.message(991,'/status',BASE,1),f.env,f.fetcher,BASE);
 assert.match(f.sent.at(-1),/Предварительный анализ .*40\/80 сообщений/);
 assert.equal(f.query('SELECT status FROM digests')[0].status,'pending');
});


test('late Telegram update with an older timestamp never gets skipped by daytime cursor',async()=>{
 const f=fixture({count:80});
 await f.prepare();
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),'preprocessed');
 // A delayed Telegram message is received after batch 0, but its original
 // timestamp sorts BEFORE the messages in batch 0.
 const lateId=9001;
 await handleUpdate(f.message(lateId,'Опоздавшее обновление Telegram',BASE-5600000,4),f.env,f.fetcher,BASE+10);
 let turns=0;
 while(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n<80){
   const result=await preprocessDigest({env:f.env,chatId:CHAT,now:BASE+1000+turns*60000,fetcher:f.fetcher});
   assert.equal(result,'preprocessed');
   turns++;
   assert.ok(turns<6);
 }
 // The final 1-message tail is intentionally held until 21:00 rather
 // than spending one Groq request on a one-message daytime chunk.
 const outcome=await publishDigest(f.env,CHAT,Date.UTC(2026,9,22,18,0),f.fetcher);
 assert.equal(outcome,'sent');
 const rows=f.query('SELECT ids_json FROM digest_chunks ORDER BY chunk_no');
 const ids=rows.flatMap(r=>JSON.parse(r.ids_json));
 assert.equal(ids.length,81);
 assert.equal(new Set(ids).size,81);
 assert.ok(ids.includes(lateId),'delayed original Telegram ID must be analyzed');
 assert.equal(ids[0],lateId,'the recorded prefix is correctly reordered');
});

test('publication invalidates a stale checkpoint even when 21:00 arrived before daytime repair',async()=>{
 const f=fixture({count:100});
 await f.prepare();
 assert.equal(await preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),'preprocessed');
 const delayed=9002;
 await handleUpdate(f.message(delayed,'Опоздавшее сообщение',BASE-5600000,4),f.env,f.fetcher,BASE+100);
 const first=await publishDigest(f.env,CHAT,Date.UTC(2026,9,22,18,0),f.fetcher);
 assert.equal(first,'processing','stale batch discarded; only two complete batches per Cron');
 const source=f.query('SELECT ids_json FROM digest_chunks ORDER BY chunk_no').flatMap(x=>JSON.parse(x.ids_json));
 assert.equal(source.length,80);
 assert.equal(source[0],delayed);
 assert.equal(await publishDigest(f.env,CHAT,Date.UTC(2026,9,22,18,1),f.fetcher),'sent');
 assert.equal(f.query('SELECT status FROM digests')[0].status,'sent');
});


test('quiet chat keeps an open checkpoint without spending Groq on a 10-message day',async()=>{
 const f=fixture({count:10});
 await f.prepare();
 assert.deepEqual(await runCron(f.env,BASE,f.fetcher),[]);
 assert.equal(f.aiCalls,0);
 const stored=f.query('SELECT status,window_start,window_end FROM digests');
 assert.equal(stored.length,1);
 assert.equal(stored[0].status,'pending');
 assert.equal(stored[0].window_end,null);
});

test('missed 21:00 Cron closes earlier day at its original Moscow deadline and leaves late posts for next issue',async()=>{
 const f=fixture({count:0});
 const yesterday=Date.UTC(2026,9,21,17,30); // 20:30 Moscow
 const cutoff=Date.UTC(2026,9,21,18,0); // 21:00 Moscow
 await handleUpdate(f.message(1,'/enable',yesterday-3600000,1),f.env,f.fetcher,yesterday-3600000);
 for(let i=101;i<=140;i++)
   await handleUpdate(f.message(i,'Вчерашняя пицца '+i,yesterday-2400000+i*1000,2),
     f.env,f.fetcher,yesterday-2400000+i*1000);
 assert.equal((await runCron(f.env,yesterday,f.fetcher))[0].result,'preprocessed');
 for(let i=141;i<=150;i++)
   await handleUpdate(f.message(i,'Поздняя переписка '+i,cutoff+1800000+i*1000,2),
     f.env,f.fetcher,cutoff+1800000+i*1000);
 // Simulate a Worker outage across the publication time and midnight.
 const nextDay=Date.UTC(2026,9,22,1,0);
 const result=await runCron(f.env,nextDay,f.fetcher);
 assert.equal(result[0].result,'sent');
 const old=f.query('SELECT local_day,window_start,window_end,status FROM digests WHERE local_day=?','2026-10-21')[0];
 assert.equal(old.window_end,cutoff);
 assert.equal(old.status,'sent');
 assert.equal(f.evidenceCalls,1,'yesterday source notes were reused');
 await runCron(f.env,nextDay+60000,f.fetcher);
 const current=f.query('SELECT local_day,window_start,window_end FROM digests WHERE local_day=?','2026-10-22')[0];
 assert.equal(current.window_start,cutoff);
 assert.equal(current.window_end,null);
 const late=f.query('SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND posted_at>=?',CHAT,cutoff)[0].n;
 assert.equal(late,10);
});


test('group disable while daytime AI is reading aborts the checkpoint and clears open draft',async()=>{
 const f=fixture({count:40});
 await f.prepare();
 f.setOnGroq(async()=>await handleUpdate(f.message(994,'/disable',BASE,1),f.env,f.fetcher,BASE));
 await assert.rejects(preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher}),/permission changed/);
 assert.equal(f.query('SELECT COUNT(*) AS n FROM digest_chunks')[0].n,0);
 assert.equal(f.query('SELECT COUNT(*) AS n FROM digests')[0].n,0);
 assert.equal(f.query('SELECT enabled FROM chats')[0].enabled,0);
});

test('/status explicitly distinguishes final-publication reserve from Groq API downtime',async()=>{
 const f=fixture({count:80});
 await f.prepare();
 await preprocessDigest({env:f.env,chatId:CHAT,now:BASE,fetcher:f.fetcher});
 const today=new Date().toISOString().slice(0,10);
 f.sqlite.prepare("UPDATE groq_budget SET used_tokens=120000,day_utc=? WHERE scope='organization'").run(today);
 await handleUpdate(f.message(998,'/status',BASE,1),f.env,f.fetcher,BASE);
 assert.match(f.sent.at(-1),/Фоновый анализ ждёт сброса лимита/);
 assert.match(f.sent.at(-1),/запросы разрешены/);
});


test('delayed same-evening Cron closes at 21:00, not at the late invocation time',async()=>{
 const f=fixture({count:0});
 const cutoff=Date.UTC(2026,9,22,18,0); // 21:00 Moscow
 const early=Date.UTC(2026,9,22,17,20);
 await handleUpdate(f.message(1,'/enable',early-600000,1),f.env,f.fetcher,early-600000);
 for(let id=101;id<=140;id++){
   const posted=early+(id-101)*1000;
   await handleUpdate(f.message(id,'До выпуска '+id,posted,2),f.env,f.fetcher,posted);
 }
 assert.equal((await runCron(f.env,early+600000,f.fetcher))[0].result,'preprocessed');
 for(let id=141;id<=150;id++){
   const posted=cutoff+60000+(id-141)*1000;
   await handleUpdate(f.message(id,'После границы '+id,posted,2),f.env,f.fetcher,posted);
 }
 const result=await runCron(f.env,cutoff+15*60000,f.fetcher); // delayed, but same day
 assert.equal(result[0].result,'sent');
 const record=f.query('SELECT window_end,body,status FROM digests WHERE chat_id=? AND local_day=?',CHAT,'2026-10-22')[0];
 assert.equal(record.window_end,cutoff,'late Cron never extends the newspaper window');
 assert.match(record.body,/Прочитано и обработано: 40 из 40/);
 assert.equal(f.evidenceCalls,1,'preprocessed 40 messages were not reanalyzed');
 const after=f.query('SELECT COUNT(*) AS n FROM messages WHERE chat_id=? AND posted_at>=?',CHAT,cutoff)[0].n;
 assert.equal(after,10,'post-cutoff messages stay in D1 for the next edition');
});


test('manual /now uses its actual request time, never the future scheduled cutoff',async()=>{
 const f=fixture({count:24});
 await f.prepare();
 const requested=Date.UTC(2026,9,22,17,30); // 20:30 Moscow
 const result=await publishDigest(f.env,CHAT,requested,f.fetcher);
 assert.equal(result,'sent');
 const snapshot=f.query('SELECT window_end,status FROM digests WHERE chat_id=? AND local_day=?',CHAT,'2026-10-22')[0];
 assert.equal(snapshot.window_end,requested);
 assert.equal(snapshot.status,'sent');
});

test('delayed scheduled run creates its first-ever edition at the 21:00 boundary',async()=>{
 const f=fixture({count:0});
 const now=Date.UTC(2026,9,22,18,12); // 21:12 Moscow
 const before=now-60*60_000;
 await handleUpdate(f.message(1,'/enable',before-60000,1),f.env,f.fetcher,before-60000);
 for(let id=101;id<=112;id++){
   const at=before+(id-101)*1000;
   await handleUpdate(f.message(id,'До 21:00 '+id,at,2),f.env,f.fetcher,at);
 }
 const result=await runCron(f.env,now,f.fetcher);
 assert.equal(result[0].result,'sent');
 const ending=f.query('SELECT window_end FROM digests WHERE chat_id=? AND local_day=?',CHAT,'2026-10-22')[0].window_end;
 assert.equal(ending,Date.UTC(2026,9,22,18,0));
});
