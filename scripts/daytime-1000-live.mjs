// Real Groq daytime E2E: synthetic group and in-memory D1, no Telegram delivery.
// Any quota exhaustion is recorded as DEFERRED, never re-labelled as PASS.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {handleUpdate,runCron,publishDigest} from '../src/index.js';
import {preprocessDigest} from '../src/preprocess.js';
import {localClock,scheduledEpochForDay} from '../src/core.js';
import {readGroqBudget,quotaWaitUntil} from '../src/quota.js';
import {generate300} from './simulate-300.mjs';

const CHAT='-1009300300';
const model='qwen/qwen3.8-27b';
const limitMs=24*60_000;
const started=Date.now();
const source=generate300();
const day=localClock(started,'Europe/Moscow').day;
const cutoff=scheduledEpochForDay(day,'21:00','Europe/Moscow');
const data=Array.from({length:1000},(_,i)=>({
  ...source[i%source.length],
  id:1001+i,
  timestamp:cutoff-14*3_600_000+i*25_000,
  body:source[i%source.length].body+(i>=300?' Новый круг разговора.':'')
}));
const sqlite=new DatabaseSync(':memory:');
for(const name of ['0001_init.sql','0002_exhaustive.sql','0003_groq_budget.sql','0004_digest_reductions.sql','0005_editorial_drafts.sql'])
  sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
const DB={prepare(sql){const q=sqlite.prepare(sql);return {bind(...a){return {
  first:async()=>q.get(...a)||null,
  all:async()=>({results:q.all(...a)}),
  run:async()=>({meta:{changes:q.run(...a).changes}})
};}};}};
const env={DB,GROQ_API_KEY:process.env.GROQ_API_KEY,GROQ_MODEL:model,
  BOT_TIME_ZONE:'Europe/Moscow',TELEGRAM_BOT_TOKEN:'FAKE_NO_DELIVERY',
  GROQ_DAILY_TOKEN_SOFT_LIMIT:'180000',GROQ_PREPROCESS_TOKEN_SOFT_LIMIT:'120000'};
const sent=[];
let groqCalls=0,completedCalls=0,errors=0;
const fetcher=async(url,options)=>{
  const address=String(url);
  if(address.startsWith('https://api.groq.com/')){
    groqCalls++;
    const response=await fetch(url,options);
    if(response.ok)completedCalls++;
    console.log('Groq HTTP '+response.status+' (request '+groqCalls+')');
    return response;
  }
  if(address.endsWith('/getChatMember'))
    return Response.json({ok:true,result:{status:'administrator'}});
  if(address.endsWith('/sendMessage')){
    const req=JSON.parse(options.body);
    assert.equal(String(req.chat_id),CHAT,'never send to a real Telegram group');
    sent.push(req.text);
    return Response.json({ok:true,result:{message_id:sent.length}});
  }
  throw Error('External destination not permitted in isolated trial');
};
const update=m=>({message:{chat:{id:Number(CHAT),type:'supergroup',title:'Isolated 1000'},
  message_id:m.id,date:Math.floor(m.timestamp/1000),
  from:{id:m.user_id,first_name:m.display_name},text:m.body}});
const query=(sql,...a)=>sqlite.prepare(sql).all(...a);
const progress=()=>Number(query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0]?.n||0);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function quotaPause(label){
  const state=await readGroqBudget(env);
  const until=quotaWaitUntil(state,Date.now(),env);
  const delay=Math.max(30000,(until||Date.now()+60000)-Date.now()+2000);
  console.log(label+'; quota next window '+(until?new Date(until).toISOString():'unknown')+
    '; waiting '+Math.ceil(delay/1000)+'s');
  if(Date.now()+delay>started+limitMs)throw Error('QUOTA_DEFERRED: reset lies beyond the bounded real-Groq trial');
  await pause(delay);
}
async function main(){
  if(!env.GROQ_API_KEY)throw Error('BLOCKED: missing GROQ_API_KEY secret');
  const enabledAt=cutoff-15*3_600_000;
  await handleUpdate(update({id:1,user_id:11,display_name:'Саня',body:'/enable',
    timestamp:enabledAt}),env,fetcher,enabledAt);
  for(const m of data)await handleUpdate(update(m),env,fetcher,m.timestamp);
  assert.equal(query('SELECT COUNT(*) AS n FROM messages')[0].n,1000);
  console.log('SOURCE: 1000/1000 messages in isolated SQLite');
  let tick=0;
  while(progress()<1000){
    if(Date.now()>started+limitMs)throw Error('QUOTA_DEFERRED: daytime real-Groq trial exceeded bounded runtime');
    if(tick>110)throw Error('FAIL: more than 110 daytime processing ticks');
    const virtualNow=cutoff-6*3_600_000+tick*60_000;
    let outcome;
    try {outcome=await preprocessDigest({env,chatId:CHAT,now:virtualNow,fetcher});}
    catch(error){
      if(/Groq response empty or truncated/i.test(String(error))&&++errors<=2){
        tick++;
        continue; // Existing D1 checkpoints are retained.
      }
      throw error;
    }
    console.log('DAYTIME tick '+tick+': '+outcome+
      ', checkpoint '+progress()+'/1000, Groq calls '+groqCalls);
    if(outcome==='waiting'){await quotaPause('daytime model quota');continue;}
    if(outcome==='preprocessed'){tick++;continue;}
    if(outcome==='locked'){await pause(1000);continue;}
    throw Error('FAIL: daytime stopped with '+outcome+' after '+progress()+'/1000');
  }
  const rows=query('SELECT ids_json,processed FROM digest_chunks ORDER BY chunk_no');
  const ids=rows.flatMap(r=>JSON.parse(r.ids_json));
  assert.equal(new Set(ids).size,1000,'all 1000 unique source IDs independently accounted for');
  assert.equal(ids.length,1000);
  const daytimeCalls=groqCalls;
  console.log('DAYTIME complete: '+rows.length+' persisted chunks, '+daytimeCalls+' actual Groq calls');
  let outcome='processing',tries=0;
  while(!['sent','already_sent','needs_review'].includes(outcome)){
    if(Date.now()>started+limitMs)throw Error('QUOTA_DEFERRED: final synthesis exceeded bounded runtime');
    if(++tries>12)throw Error('FAIL: final newspaper failed to converge');
    const results=await runCron(env,cutoff+60_000,fetcher);
    outcome=results.find(x=>x.chat_id===CHAT)?.result||'none';
    console.log('EDITION attempt '+tries+': '+outcome+' Groq calls '+groqCalls);
    if(outcome==='waiting'){await quotaPause('final edition quota');continue;}
    if(outcome==='failed'){
      const dbState=query('SELECT status,editorial_attempts FROM digests')[0];
      if(dbState?.status==='needs_review')throw Error('FAIL: rejected by factual/editorial gate');
      if(dbState?.status==='pending')throw Error('FAIL: unaccepted editorial draft');
      throw Error('FAIL: scheduled publisher errored');
    }
    if(outcome==='processing'||outcome==='locked'){await pause(1000);continue;}
    if(outcome==='none')throw Error('FAIL: Cron returned no publication result');
  }
  assert.equal(outcome,'sent','must send exactly one complete newspaper');
  const digest=query('SELECT status,body,window_end FROM digests')[0];
  assert.equal(digest.status,'sent');
  assert.equal(digest.window_end,cutoff);
  assert.match(digest.body,/Прочитано и обработано: 1000 из 1000/);
  assert.equal(await publishDigest(env,CHAT,cutoff+90_000,fetcher),'already_sent');
  const published=sent.filter(x=>x.includes('ЧЁРНЫЙ ВЕСТНИК'));
  assert.equal(published.length,1,'no duplicate Telegram publications');
  const references=[...digest.body.matchAll(/\[#(\d+)\]/g)].map(x=>Number(x[1]));
  assert.ok(references.length>=3&&references.every(id=>ids.includes(id)));
  assert.ok(groqCalls>daytimeCalls,'final synthesis used real Groq');
  mkdirSync('reports',{recursive:true});
  writeFileSync('reports/daytime-1000-live.md',[
    '# Real Groq daytime 1000-message E2E: TECHNICAL PASS',
    '',
    '- Model: '+model,
    '- Synthetic Telegram group: yes; real group delivery: NO',
    '- Messages ingested and processed: 1000/1000',
    '- Unique source IDs in chunk ledger: '+new Set(ids).size,
    '- Daytime chunks: '+rows.length,
    '- Daytime Groq calls: '+daytimeCalls,
    '- Total Groq calls: '+groqCalls,
    '- Actual Groq completions: '+completedCalls,
    '- Final citations: '+references.length,
    '- Saved publication status: '+digest.status,
    '- Repeat publication: rejected as already_sent',
    '- Human humor acceptance: NOT TESTED',
    '',
    '## Newspaper',
    '~~~text',digest.body,'~~~'
  ].join('\n'));
  console.log('GAUNTLET PASS: 1000/1000 real Groq daytime E2E, '+groqCalls+' calls');
}
main().catch(error=>{
  mkdirSync('reports',{recursive:true});
  const reason=String(error.message||error);
  const status=/QUOTA_DEFERRED|Groq deferred|HTTP 429/.test(reason)?'QUOTA_DEFERRED':'FAIL';
  const state=query('SELECT used_tokens,next_attempt_at,last_status FROM groq_budget');
  writeFileSync('reports/daytime-1000-live.md',[
    '# Real Groq daytime 1000-message E2E: '+status,
    '',
    '- Original messages: '+query('SELECT COUNT(*) AS n FROM messages')[0].n,
    '- Messages in verified D1 chunk ledger: '+progress()+'/1000',
    '- Real Groq calls: '+groqCalls,
    '- Real Groq successful responses: '+completedCalls,
    '- Quota state: '+JSON.stringify(state[0]||{}),
    '- Reason: '+reason.slice(0,500),
    '- Real Telegram group delivery: NOT RUN',
    '- This is NOT an acceptance PASS; no truncated paper is claimed.'
  ].join('\n'));
  console.error('GAUNTLET '+status+': '+reason);
  process.exitCode=1;
});
