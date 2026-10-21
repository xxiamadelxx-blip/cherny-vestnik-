import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{handleUpdate,runCron,publishDigest} from '../src/index.js';
import {noteGroqLimit} from '../src/quota.js';

const NOW=Date.UTC(2026,9,21,18,0); // 21:00 Moscow
const SCHEMA=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  sqlite.exec(readFileSync(new URL('../migrations/0002_exhaustive.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_groq_budget.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0004_digest_reductions.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0005_editorial_drafts.sql',import.meta.url),'utf8'));
  const db={prepare(query){
    const stmt=sqlite.prepare(query);
    return {bind(...params){return {
      first:async()=>stmt.get(...params)||null,
      all:async()=>({results:stmt.all(...params)}),
      run:async()=>({meta:{changes:stmt.run(...params).changes}})
    };}};
  }};
  const sent=[];
  let groqCalls=0;
  let failSend=false;
  let failAI=false;
  let onGroq=null;
  let responseText='💀 ЧЁРНЫЙ ВЕСТНИК\n\nГлавная новость: Вася [#101] возмущался происходящим. Какой ёбаный цирк.';
  let sendsAttempted=0;
  let failAtSend=null;
  const fetcher=async(url,opts)=>{
    if(String(url).includes('api.groq.com')) {
      groqCalls++;
      if(onGroq) { const fn=onGroq;onGroq=null; await fn(); }
      if(failAI) return new Response(JSON.stringify({error:{message:'test'}}),{status:429});
      const request=JSON.parse(opts.body);
      assert.equal(request.model,'qwen/qwen3.8-27b');
      assert.ok(!request.messages[0].content.includes('конец замены'));
      return Response.json({choices:[{message:{content:responseText}}]});
    }
    const method=String(url).split('/').at(-1);
    const payload=JSON.parse(opts.body);
    if(method==='getChatMember') return Response.json({ok:true,result:{status:payload.user_id===1?'administrator':'member'}});
    if(method==='sendMessage') {
      sendsAttempted++;
      if(failAtSend===sendsAttempted) return Response.json({ok:false,description:'simulated failure'},{status:503});
      if(failSend){failSend=false;return Response.json({ok:false,description:'try later'},{status:503});}
      sent.push(payload);
      return Response.json({ok:true,result:{message_id:sent.length}});
    }
    throw Error('unexpected API: '+url);
  };
  const env={DB:db,TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_WEBHOOK_SECRET:'a_very_long_secret',
    GROQ_API_KEY:'fake',GROQ_MODEL:'qwen/qwen3.8-27b',BOT_TIME_ZONE:'Europe/Moscow'};
  function makeMsg({id=1,from=1,text='Что за день, блядь?',when=NOW-600000}={}) {
    return {message:{chat:{id:-1001111,type:'supergroup',title:'Наш чат'},message_id:id,
      date:Math.floor(when/1000),from:{id:from,first_name:from===1?'Вася':'Петя'},text}};
  }
  function query(sql,...params) {return sqlite.prepare(sql).all(...params);}
  return {sqlite,env,sent,fetcher,makeMsg,query,
    get groqCalls(){return groqCalls},
    setFailSend:()=>{failSend=true},setFailAI:(v=true)=>{failAI=v},setOnGroq:(cb)=>{onGroq=cb},
    setAIResponse:(s)=>{responseText=s},setFailAtSend:(n)=>{failAtSend=n},
    get attemptedSends(){return sendsAttempted}};
}

test('webhook refuses anonymous posting; no settings or secrets exposed in healthz',async()=>{
  const f=fixture();
  const request=new Request('https://worker.test/webhook',{method:'POST',body:JSON.stringify(f.makeMsg()),headers:{'Content-Type':'application/json'}});
  const res=await worker.fetch(request,f.env);
  assert.equal(res.status,403);
  assert.equal((await worker.fetch(new Request('https://worker.test/healthz'),f.env)).status,200);
  assert.equal((await worker.fetch(new Request('https://worker.test/'),f.env)).status,404);
  assert.equal(f.query('SELECT * FROM messages').length,0);
});

test('consent gate, admin permission, deduplication, published-once cron, memory',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:101}),f.env,f.fetcher,NOW-400000);
  assert.equal(f.query('SELECT * FROM messages').length,0);
  await handleUpdate(f.makeMsg({id:50,from:2,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  assert.equal(f.query('SELECT * FROM chats').length,0);
  await handleUpdate(f.makeMsg({id:51,from:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101,text:'Заебал этот дождь'}),f.env,f.fetcher,NOW-300000);
  await handleUpdate(f.makeMsg({id:101,text:'Заебал этот дождь'}),f.env,f.fetcher,NOW-300000);
  await handleUpdate(f.makeMsg({id:102,from:2,text:'Согласен'}),f.env,f.fetcher,NOW-300000);
  assert.equal(f.query('SELECT * FROM messages').length,2);
  const results=await runCron(f.env,NOW,f.fetcher);
  assert.equal(results[0].result,'sent');
  assert.equal(f.groqCalls,1);
  const published=f.sent.filter(s=>s.text.includes('ЧЁРНЫЙ ВЕСТНИК'));
  assert.equal(published.length,1);
  const again=await runCron(f.env,NOW+15*60*1000,f.fetcher);
  assert.equal(again[0].result,'already_sent');
  assert.equal(f.groqCalls,1);
  assert.equal(f.query('SELECT * FROM memories').length,1);
  assert.equal(f.query('SELECT status FROM digests')[0].status,'sent');
});

test('AI outage keeps digest pending and does not publish partial fiction',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101}),f.env,f.fetcher,NOW-300000);
  f.setFailAI();
  assert.equal(await publishDigest(f.env,'-1001111',NOW,f.fetcher),'waiting');
  assert.equal(f.query('SELECT status FROM digests')[0].status,'pending');
  assert.equal(f.sent.some(x=>x.text.includes('ЧЁРНЫЙ ВЕСТНИК')),false);
  const budget=f.query('SELECT * FROM groq_budget')[0];
  assert.equal(budget.last_status,429);
  assert.ok(budget.next_attempt_at>Date.now());
  // A second Cron run must not hit Groq while the persisted cooldown applies.
  assert.equal(await publishDigest(f.env,'-1001111',NOW+1000,f.fetcher),'waiting');
  assert.equal(f.groqCalls,1);
  f.setFailAI(false);
  // Simulate the provider's reset time passing without sleeping during unit tests.
  f.sqlite.prepare('UPDATE groq_budget SET next_attempt_at=0, remaining_requests=NULL, remaining_tokens=NULL').run();
  assert.equal(await publishDigest(f.env,'-1001111',NOW+1000,f.fetcher),'sent');
});

test('failed Telegram post resumes prepared digest without a second AI call',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101}),f.env,f.fetcher,NOW-300000);
  f.setFailSend();
  await assert.rejects(publishDigest(f.env,'-1001111',NOW,f.fetcher));
  assert.equal(f.query('SELECT next_part FROM digests')[0].next_part,0);
  assert.equal(f.groqCalls,1);
  assert.equal(await publishDigest(f.env,'-1001111',NOW+10000,f.fetcher),'sent');
  assert.equal(f.groqCalls,1);
  assert.equal(f.sent.filter(s=>s.text.includes('ЧЁРНЫЙ ВЕСТНИК')).length,1);
});

test('non-admin /wipe denied; /forgetme clears content and future memory; /wipe removes all',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101,from:1}),f.env,f.fetcher,NOW-300000);
  await handleUpdate(f.makeMsg({id:102,from:2}),f.env,f.fetcher,NOW-300000);
  await handleUpdate(f.makeMsg({id:7,from:2,text:'/wipe'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT * FROM messages').length,2);
  await handleUpdate(f.makeMsg({id:8,from:2,text:'/forgetme'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT * FROM messages').length,1);
  await handleUpdate(f.makeMsg({id:103,from:2,text:'I revoked permission'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT * FROM messages').length,1);
  await handleUpdate(f.makeMsg({id:104,from:2,text:'/optin'}),f.env,f.fetcher,NOW);
  await handleUpdate(f.makeMsg({id:105,from:2,text:'allowed again'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT * FROM messages').length,2);
  await handleUpdate(f.makeMsg({id:9,text:'/wipe'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT * FROM messages').length,0);
  assert.equal(f.query('SELECT * FROM chats').length,0);
});

test('daily schedule does not publish before configured time',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:2,text:'/time 22:15'}),f.env,f.fetcher,NOW-300000);
  assert.deepEqual(await runCron(f.env,NOW,f.fetcher),[]);
  assert.equal(f.groqCalls,0);
  assert.equal((await runCron(f.env,NOW+75*60000,f.fetcher))[0].result,'sent');
});


test('deletion during AI generation aborts report and never publishes erased content',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101,from:2,text:'secret roast this must not be sent'}),f.env,f.fetcher,NOW-300000);
  f.setOnGroq(async()=>{
    await handleUpdate(f.makeMsg({id:200,from:2,text:'/forgetme'}),f.env,f.fetcher,NOW);
  });
  await assert.rejects(publishDigest(f.env,'-1001111',NOW,f.fetcher),/permission changed/);
  assert.equal(f.query('SELECT * FROM messages').length,0);
  assert.equal(f.query('SELECT * FROM digests').length,0);
  assert.equal(f.sent.some(p=>p.text.includes('ЧЁРНЫЙ ВЕСТНИК')),false);
});

test('disable while generating aborts outgoing digest',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101,from:2}),f.env,f.fetcher,NOW-300000);
  f.setOnGroq(async()=>{
    await handleUpdate(f.makeMsg({id:200,text:'/disable'}),f.env,f.fetcher,NOW);
  });
  await assert.rejects(publishDigest(f.env,'-1001111',NOW,f.fetcher),/permission changed/);
  assert.equal(f.sent.some(p=>p.text.includes('ЧЁРНЫЙ ВЕСТНИК')),false);
  assert.equal(f.query('SELECT * FROM chats')[0].enabled,0);
});


test('multipart digest retries from next part, not from beginning',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  await handleUpdate(f.makeMsg({id:101}),f.env,f.fetcher,NOW-300000);
  f.setAIResponse('💀 ЧЁРНЫЙ ВЕСТНИК\n' + ('Очень смешная фраза, полный пиздец.\n').repeat(250));
  f.setFailAtSend(f.attemptedSends+2); // 1st report part succeeds; second fails.
  await assert.rejects(publishDigest(f.env,'-1001111',NOW,f.fetcher));
  assert.equal(f.query('SELECT next_part FROM digests')[0].next_part,1);
  const firstPart=f.sent.at(-1).text;
  assert.ok(firstPart.startsWith('💀 ЧЁРНЫЙ ВЕСТНИК'));
  assert.equal(await publishDigest(f.env,'-1001111',NOW+1000,f.fetcher),'sent');
  assert.equal(f.groqCalls,1);
  assert.equal(f.sent.filter(x=>x.text===firstPart).length,1);
  assert.ok(f.sent.every(x=>x.text.length<=3800));
});

test('status exposes Groq cooldown and incomplete processing count',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  for(let id=101;id<=200;id++){
    await handleUpdate(f.makeMsg({id,text:'Чат спорит о доставке и расписании '+id}),f.env,f.fetcher,NOW-300000);
  }
  assert.equal(await publishDigest(f.env,'-1001111',NOW,f.fetcher),'processing');
  await noteGroqLimit(f.env,new Response('',{status:429,headers:{'retry-after':'130'}}),Date.now());
  await handleUpdate(f.makeMsg({id:2,text:'/status'}),f.env,f.fetcher,NOW+1000);
  const status=f.sent.at(-1).text;
  assert.match(status,/Groq: пауза/);
  assert.match(status,/Обработка 2026-10-21: 80\/100 сообщений/);
  assert.match(status,/Токены бота сегодня/);
});

test('privacy wipe clears cached Groq reduction notes',async()=>{
  const f=fixture();
  await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
  f.sqlite.prepare('INSERT INTO digest_reductions(chat_id,local_day,level,group_no,input_hash,note,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('-1001111','2026-10-21',0,0,'hash','saved note',NOW);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM digest_reductions')[0].n,1);
  await handleUpdate(f.makeMsg({id:5,text:'/wipe'}),f.env,f.fetcher,NOW);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM digest_reductions')[0].n,0);
});


test('fabricated verbatim quote is blocked before Telegram delivery, with editorial backoff',async()=>{
 const f=fixture();
 await handleUpdate(f.makeMsg({id:1,text:'/enable'}),f.env,f.fetcher,NOW-400000);
 await handleUpdate(f.makeMsg({id:101,text:'Я купил картошку на ужин'}),f.env,f.fetcher,NOW-300000);
 f.setAIResponse('💀 ЧЁРНЫЙ ВЕСТНИК. Вася заявил: «Я ограбил банк» [#101]. Это вообще ёбаный цирк.');
 const previousSends=f.sent.length;
 await assert.rejects(publishDigest(f.env,'-1001111',NOW,f.fetcher),/Editorial verification rejected/);
 assert.equal(f.sent.length,previousSends,'must never send libelous mock quote');
 assert.equal(f.query('SELECT status FROM digests')[0].status,'pending');
 assert.equal(f.query('SELECT body FROM digests')[0].body,null);
 assert.equal(f.query('SELECT lease_until FROM digests')[0].lease_until,NOW+15*60_000);
 assert.equal(await publishDigest(f.env,'-1001111',NOW+60_000,f.fetcher),'locked');
 assert.equal(f.groqCalls,2,'one initial draft plus one automatic repair, no calls during cooldown');
 assert.equal(f.query('SELECT editorial_attempts FROM digests')[0].editorial_attempts,1);
 assert.ok(f.query('SELECT editorial_draft FROM digests')[0].editorial_draft);
});
