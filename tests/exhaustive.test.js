import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleUpdate,publishDigest,runCron} from '../src/index.js';
import {packTranscript,normalizeMessage} from '../src/core.js';
import {analyzeChunk} from '../src/ai.js';

const NOW=Date.UTC(2026,9,21,18,0);
function fixture(total=1000) {
  const sqlite=new DatabaseSync(':memory:');
  for(const path of ['0001_init.sql','0002_exhaustive.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+path,import.meta.url),'utf8'));
  const DB={prepare(sql){const q=sqlite.prepare(sql);return {bind(...a){return {
    first:async()=>q.get(...a)||null,all:async()=>({results:q.all(...a)}),
    run:async()=>({meta:{changes:q.run(...a).changes}})};}};}};
  let calls=0; const seenIds=new Set(), sent=[];
  const fetcher=async(url,opts)=>{
    if(String(url).includes('groq.com')) {
      calls++;
      const msgs=JSON.parse(opts.body).messages;
      const content=msgs.at(-1).content;
      if(content.includes('Недоверенная переписка')){
        for(const match of content.matchAll(/\[#(\d+)\] [^\n]+/g))seenIds.add(Number(match[1]));
        return Response.json({choices:[{message:{content:'[#1001] Саня: пообещал оплатить пиццу, но снова устроил ёбаный цирк. [#1002] Марта: заметила противоречие.'},finish_reason:'stop'}]});
      }
      return Response.json({choices:[{message:{content:'💀 ЧЁРНЫЙ ВЕСТНИК\n\n🔥 Чат снова устроил ёбаный цирк с пиццей. Саня весь день строил планы, а Марта считала его оправдания. Блядь, фан-клуб противоречий официально открыт.\n\n🪦 Завтра попробуйте сначала поесть, а потом спорить.'},finish_reason:'stop'}]});
    }
    const method=String(url).split('/').at(-1);
    if(method==='getChatMember')return Response.json({ok:true,result:{status:'administrator'}});
    if(method==='sendMessage'){sent.push(JSON.parse(opts.body).text);return Response.json({ok:true,result:{message_id:sent.length}});}
    throw Error('Unexpected external call');
  };
  const env={DB,TELEGRAM_BOT_TOKEN:'fake',GROQ_API_KEY:'fake',BOT_TIME_ZONE:'Europe/Moscow'};
  const message=(i,body)=>({message:{chat:{id:-100123,type:'supergroup',title:'Synthetic'},message_id:i,
    date:Math.floor((NOW-3600000+i*1000)/1000),from:{id:i%6+1,first_name:['Саня','Марта','Дима','Лиза','Паша','Игорь'][i%6]},text:body}});
  const query=(sql,...params)=>sqlite.prepare(sql).all(...params);
  return {sqlite,env,fetcher,message,query,sent,seenIds,get calls(){return calls}};
}

test('1000 messages each appear in exactly one analyzed AI batch; no sampling',async()=>{
  const f=fixture();
  await handleUpdate(f.message(1,'/enable'),f.env,f.fetcher,NOW-4000000);
  for(let i=1001;i<=2000;i++)await handleUpdate(f.message(i,'Выпуск про пиццу: спорим о цене, кто платит и почему всё пошло нахуй. Сообщение '+i),f.env,f.fetcher,NOW-4000000+i*1000);
  assert.equal(f.query('SELECT COUNT(*) AS n FROM messages')[0].n,1000);
  let outcome,attempts=0;
  do{
    outcome=await publishDigest(f.env,'-100123',NOW+attempts*60_000,f.fetcher);
    attempts++;
    assert.ok(attempts<100,'must converge');
  }while(outcome==='processing');
  assert.equal(outcome,'sent');
  assert.equal(f.seenIds.size,1000);
  const notes=f.query('SELECT * FROM digest_chunks ORDER BY chunk_no');
  assert.equal(notes.reduce((s,n)=>s+n.processed,0),1000);
  assert.ok(notes.length>20);
  assert.equal(f.query('SELECT status FROM digests')[0].status,'sent');
  assert.equal(await publishDigest(f.env,'-100123',NOW+attempts*60_000,f.fetcher),'already_sent');
  assert.ok(f.sent.filter(x=>x.includes('ЧЁРНЫЙ ВЕСТНИК')).length===1);
});

test('chunker never silently truncates or samples any included message',()=>{
  const msgs=Array.from({length:1000},(_,i)=>({message_id:i+1,display_name:'Тестер',body:'А'.repeat(700)}));
  let offset=0,count=0;
  while(offset<msgs.length){const pack=packTranscript(msgs.slice(offset,offset+40));assert.ok(pack.count>0);assert.equal(pack.ids[0],offset+1);assert.ok(pack.transcript.includes('А'.repeat(700)));offset+=pack.count;count++;}
  assert.equal(offset,1000);assert.ok(count>25);
});

test('few very long messages also take complete batch pipeline rather than abort',async()=>{
  const f=fixture();
  await handleUpdate(f.message(1,'/enable'),f.env,f.fetcher,NOW-4000000);
  for(let i=1001;i<=1020;i++)await handleUpdate(f.message(i,('Очень длинное обсуждение блядь. ').repeat(46)+' Конец сообщения '+i),f.env,f.fetcher,NOW-4000000+i*1000);
  let status='processing',cycles=0;
  do{status=await publishDigest(f.env,'-100123',NOW+cycles*60000,f.fetcher);cycles++;assert.ok(cycles<40);}while(status==='processing');
  assert.equal(status,'sent');
  assert.equal(f.seenIds.size,20);
  assert.equal(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n,20);
});

test('all 4096 characters of a Telegram message survive ingestion and chunk packing',()=>{
  const src='Г'.repeat(4095)+'!';
  const msg=normalizeMessage({chat:{id:-1001111,type:'supergroup'},message_id:99,date:1000,from:{id:1,first_name:'Саня'},text:src});
  assert.equal(msg.body.length,4096);
  assert.ok(packTranscript([msg]).transcript.endsWith('!'));
});


test('cron resumes a crashed working digest after lease expires', async()=>{
  const f=fixture();
  await handleUpdate(f.message(1,'/enable'),f.env,f.fetcher,NOW-4_000_000);
  for(let i=1001;i<=1100;i++)await handleUpdate(f.message(i,'Спор за пиццу, проверка #'+i),f.env,f.fetcher,NOW);
  assert.equal(await publishDigest(f.env,'-100123',NOW,f.fetcher),'processing');
  assert.equal(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n,80);
  f.sqlite.prepare("UPDATE digests SET status='working',lease_until=?").run(NOW+60_000);
  const result=await runCron(f.env,NOW+120_000,f.fetcher);
  assert.equal(result[0].result,'sent');
  assert.equal(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n,100);
  assert.equal(f.query('SELECT status FROM digests')[0].status,'sent');
});

test('cron preserves source messages older than four days while their digest is unfinished',async()=>{
  const f=fixture();
  await handleUpdate(f.message(1,'/enable'),f.env,f.fetcher,NOW-4_000_000);
  for(let i=1001;i<=1100;i++)await handleUpdate(f.message(i,'Сохранить до полного анализа '+i),f.env,f.fetcher,NOW);
  assert.equal(await publishDigest(f.env,'-100123',NOW,f.fetcher),'processing');
  const result=await runCron(f.env,NOW+5*86_400_000,f.fetcher);
  assert.equal(result[0].result,'sent');
  assert.equal(f.query('SELECT COUNT(*) AS n FROM messages')[0].n,100);
  assert.equal(f.query('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks')[0].n,100);
});

test('long model evidence is retained in full, not silently sliced',async()=>{
 const note='[#1001] Саня: '+('важное противоречие; '.repeat(70));
 assert.ok(note.length>900);
 const rows=[{message_id:1001,display_name:'Саня',body:'Сначала согласился, потом отказался'}];
 const fetcher=async(_url,options)=>{
   assert.match(JSON.parse(options.body).messages[1].content,/\[#1001\]/);
   return Response.json({choices:[{message:{content:note},finish_reason:'stop'}]});
 };
 const result=await analyzeChunk({env:{GROQ_API_KEY:'fake'},rows,fetcher});
 assert.equal(result.note,note.trim());
 assert.equal(result.count,1);
 assert.deepEqual(result.ids,[1001]);
});
