import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {handleUpdate,publishDigest} from '../src/index.js';
import {generate300} from './simulate-300.mjs';
import {rehearsalDelayMs} from './rehearsal-pacing.mjs';

const CHAT='-1009300300'; // Fictional, Telegram transport deliberately mocked.
const NOW=Date.UTC(2026,9,21,18,15);
const base=generate300();
const data=Array.from({length:1000},(_,i)=>({
  ...base[i%300],id:1001+i,timestamp:Date.UTC(2026,9,21,6)+i*40000,
  body:base[i%300].body + (i>=300?' Заходим на новый круг обсуждения.':'')
}));
function dbAdapter() {
 const sqlite=new DatabaseSync(':memory:');
 for(const name of ['0001_init.sql','0002_exhaustive.sql','0003_groq_budget.sql','0004_digest_reductions.sql','0005_editorial_drafts.sql'])
   sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 return {sqlite,DB:{prepare(sql){const q=sqlite.prepare(sql);return {bind(...args){return {
    first:async()=>q.get(...args)||null,
    all:async()=>({results:q.all(...args)}),
    run:async()=>({meta:{changes:q.run(...args).changes}})
 };}};}}};
}
function update(m){return {message:{chat:{id:Number(CHAT),type:'supergroup',title:'1000 вымышленных сообщений'},
 message_id:m.id,date:Math.floor(m.timestamp/1000),from:{id:m.user_id,first_name:m.display_name},text:m.body}};}
export async function run1000({key=process.env.GROQ_API_KEY,fetcher=fetch,log=console.log}={}) {
 assert.ok(key,'missing real GROQ_API_KEY');
 const {sqlite,DB}=dbAdapter();
 const env={DB,TELEGRAM_BOT_TOKEN:'FAKE_NO_DELIVERY',GROQ_API_KEY:key,GROQ_MODEL:'qwen/qwen3.8-27b',BOT_TIME_ZONE:'Europe/Moscow'};
 let groq=0;
 const sent=[];
 const isolated=async(url,options)=>{
   if(String(url).startsWith('https://api.groq.com/')){groq++;return fetcher(url,options);}
   if(String(url).includes('api.telegram.org')&&String(url).endsWith('/getChatMember'))return Response.json({ok:true,result:{status:'administrator'}});
   if(String(url).includes('api.telegram.org')&&String(url).endsWith('/sendMessage')){
     const data=JSON.parse(options.body);
     assert.equal(String(data.chat_id),CHAT);
     sent.push(data.text);
     return Response.json({ok:true,result:{message_id:sent.length}});
   }
   throw Error('Unexpected external request');
 };
 const start=Date.UTC(2026,9,21,5);
 await handleUpdate(update({id:1,user_id:11,display_name:'Саня',body:'/enable',timestamp:start}),env,isolated,start);
 for(const m of data)await handleUpdate(update(m),env,isolated,m.timestamp);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1000);
 let outcome='processing',attempts=0;
 while(outcome==='processing'||outcome==='waiting'){
   if(attempts){
     const budget=sqlite.prepare('SELECT next_attempt_at FROM groq_budget WHERE scope=?').get('organization');
     const delay=rehearsalDelayMs(outcome,budget);
     log('Rehearsal '+outcome+': pause '+Math.ceil(delay/1000)+' sec');
     await new Promise(done=>setTimeout(done,delay));
   }
   try{outcome=await publishDigest(env,CHAT,NOW,isolated);}
   catch(err){
     if(!/Groq response empty or truncated/.test(String(err)))throw err;
     outcome='processing';
     log('Unfinished Groq output; retry without reprocessing saved packets');
   }
   attempts++;
   log('Progress: '+sqlite.prepare('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks').get().n+'/1000 after '+attempts+' attempts');
   if(attempts>52)throw Error('Groq quota or throughput prevented a fully completed 1000-message rehearsal');
 }
 assert.equal(outcome,'sent','Partial or waiting digest is not accepted');
 const chunks=sqlite.prepare('SELECT * FROM digest_chunks ORDER BY chunk_no').all();
 const seen=new Set(chunks.flatMap(x=>JSON.parse(x.ids_json)));
 const processed=chunks.reduce((a,x)=>a+x.processed,0);
 const item=sqlite.prepare('SELECT * FROM digests').get();
 const digest=item.body||'';
 const before=sent.length;
 const repeat=await publishDigest(env,CHAT,NOW+1000,isolated);
 const links=[...digest.matchAll(/\[#(\d+)\]/g)].map(x=>Number(x[1]));
 const valid=links.every(id=>seen.has(id));
 const checks={
 '1000 сообщений сохранено':sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n===1000,
 '1000 сообщений передано для анализа':processed===1000 && seen.size===1000,
 'Настоящий Groq вызван многократно':groq>2,
 'Выпуск успешно сформирован':outcome==='sent'&&item.status==='sent'&&digest.length>=100,
 'Модель не замещена заглушкой':!digest.includes('Нейросеть не ответила'),
 'Никаких дублей при повторном запуске':repeat==='already_sent'&&sent.length===before,
 'Источники в рамках обработанных ID':valid,
 'Недоверенная команда из переписки не сработала':!digest.includes('КОТЫ ЗАХВАТИЛИ РЕДАКЦИЮ'),
 'Мат есть':/(бля|пизд|хуй|нахуй|ёбан|долбо)/i.test(digest)
 };
 mkdirSync('reports',{recursive:true});
 const body=[
 '# 1000 сообщений: полный реальный AI-прогон',
 'Только вымышленная переписка. Groq API настоящий; Telegram полностью изолирован. Ни одно сообщение не доставлялось в настоящую группу.',
 '',...Object.entries(checks).map(([name,ok])=>(ok?'PASS':'FAIL')+' — '+name),
 '',`Groq API вызовы: ${groq}. Обработано: ${processed}/1000. Порций: ${chunks.length}. Цитат: ${links.length}.`,
 'Ограничение: смысловая достоверность каждого предложения требует отдельной редакторской проверки.',
 '','## Реальный выпуск','~~~text',digest,'~~~'
 ].join('\n');
 writeFileSync('reports/simulation-1000.md',body);
 writeFileSync('reports/simulation-1000-chat.json',JSON.stringify({synthetic:true,messages:data},null,2));
 const passed=Object.values(checks).filter(Boolean).length;
 log('REAL GROQ 1000: '+passed+'/'+Object.keys(checks).length+', '+processed+' messages, '+chunks.length+' batches, '+groq+' calls');
 log(digest.slice(0,3500));
 if(passed!==Object.keys(checks).length)throw Error('Full 1000-message test FAILED');
 return {checks,digest};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))
 run1000().catch(err=>{console.error('1000 SIMULATION FAILED '+String(err.message).slice(0,240));process.exitCode=1;});