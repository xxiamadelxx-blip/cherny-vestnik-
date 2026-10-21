import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {handleUpdate,runCron} from '../src/index.js';

const NOW=Date.UTC(2026,9,21,18); // 21:00 Moscow
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of [
    '0001_init.sql','0002_exhaustive.sql','0003_groq_budget.sql',
    '0004_digest_reductions.sql','0005_editorial_drafts.sql','0006_telegram_poller.sql'
  ])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(sql){const st=sqlite.prepare(sql);return {bind(...args){return {
    first:async()=>st.get(...args)||null,
    all:async()=>({results:st.all(...args)}),
    run:async()=>({meta:{changes:st.run(...args).changes}})
  };}};}};
  const env={DB,TELEGRAM_BOT_TOKEN:'mock',GROQ_API_KEY:'mock',
    TELEGRAM_TRANSPORT:'polling',TELEGRAM_POLL_BATCH:'40',TELEGRAM_POLL_PAGES:'1',BOT_TIME_ZONE:'Europe/Moscow'};
  const delivered=[],updates=Array.from({length:95},(_,i)=>({
    update_id:i+1000,
    message:{message_id:i+101,date:Math.floor((NOW-30*60_000)/1000),
      chat:{id:-100999,type:'supergroup',title:'Fictional consenting chat'},
      from:{id:1,first_name:'Вася'},text:'Обсуждаем доставку и время встречи. Номер '+(i+101)}
  }));
  let failPoll=false,pollCalls=0;
  const fetcher=async(url,options)=>{
    const u=String(url),data=JSON.parse(options.body);
    if(u.endsWith('/getChatMember'))return Response.json({ok:true,result:{status:'administrator'}});
    if(u.endsWith('/sendMessage')){
      delivered.push(data.text);return Response.json({ok:true,result:{message_id:delivered.length}});
    }
    if(u.endsWith('/getUpdates')){
      pollCalls++;
      if(failPoll)return Response.json({ok:false},{status:503});
      return Response.json({ok:true,result:updates.filter(item=>item.update_id>=data.offset).slice(0,data.limit)});
    }
    if(u.includes('api.groq.com')){
      const match=data.messages.at(-1).content.match(/\[#(\d+)\]/);
      return Response.json({choices:[{message:{
        content:'[#'+(match?.[1]||101)+'] Вася: обсуждал доставку и время встречи. Никаких иных фактов в переписке нет.'
      },finish_reason:'stop'}]});
    }
    throw Error('Unexpected mock request '+u);
  };
  const adminMessage={message:{message_id:1,date:Math.floor((NOW-40*60_000)/1000),
    chat:{id:-100999,type:'supergroup',title:'Fictional consenting chat'},
    from:{id:1,first_name:'Вася'},text:'/enable'}};
  const count=()=>sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  return {sqlite,env,fetcher,adminMessage,delivered,count,
    get pollCalls(){return pollCalls;},setPollFailure(v){failPoll=v;}};
}
test('95 queued messages are ALL ingested before the daily issue starts',async()=>{
  const f=fixture();
  await handleUpdate(f.adminMessage,f.env,f.fetcher,NOW-40*60_000);
  assert.equal(f.delivered.length,1,'/enable notice');
  assert.deepEqual(await runCron(f.env,NOW,f.fetcher),[]);
  assert.equal(f.count(),40);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0,
    'newspaper cannot be started with another Telegram page pending');
  assert.deepEqual(await runCron(f.env,NOW+60_000,f.fetcher),[]);
  assert.equal(f.count(),80);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0);
  // A short page containing 15 events is not proof that nothing else remains.
  assert.deepEqual(await runCron(f.env,NOW+120_000,f.fetcher),[]);
  assert.equal(f.count(),95);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0);
  const result=await runCron(f.env,NOW+180_000,f.fetcher);
  assert.equal(result[0].result,'processing','complete set enters the AI pipeline');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,1);
  const records=f.sqlite.prepare('SELECT window_start,window_end FROM digests').get();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE posted_at>=? AND posted_at<?')
    .get(records.window_start,records.window_end).n,95);
  assert.equal(f.sqlite.prepare('SELECT COALESCE(SUM(processed),0) AS n FROM digest_chunks').get().n,80);
  assert.equal(f.pollCalls,4);
  assert.ok(f.delivered.every(text=>!text.includes('ЧЁРНЫЙ ВЕСТНИК')),
    'no partial Telegram newspaper sent');
});
test('Telegram getUpdates failure defers release instead of publishing stale snapshot',async()=>{
  const f=fixture();
  await handleUpdate(f.adminMessage,f.env,f.fetcher,NOW-40*60_000);
  f.setPollFailure(true);
  assert.deepEqual(await runCron(f.env,NOW,f.fetcher),[]);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0);
  f.setPollFailure(false);
  const result=await runCron(f.env,NOW+60_000,f.fetcher);
  assert.deepEqual(result,[]);
  assert.equal(f.count(),40);
});
test('an existing Telegram poll lease postpones digest publication',async()=>{
  const f=fixture();
  await handleUpdate(f.adminMessage,f.env,f.fetcher,NOW-40*60_000);
  f.sqlite.prepare('UPDATE telegram_poller SET lease_until=?').run(NOW+120000);
  assert.deepEqual(await runCron(f.env,NOW,f.fetcher),[]);
  assert.equal(f.pollCalls,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0);
});


test('four-page catch-up safely drains 95 queued messages in one Cron invocation',async()=>{
  const f=fixture();
  f.env.TELEGRAM_POLL_PAGES='4';
  await handleUpdate(f.adminMessage,f.env,f.fetcher,NOW-40*60_000);
  const result=await runCron(f.env,NOW,f.fetcher);
  assert.equal(f.pollCalls,4,'40 + 40 + 15 + confirmed empty page');
  assert.equal(f.count(),95);
  assert.equal(result[0].result,'processing');
  const snapshot=f.sqlite.prepare('SELECT window_start,window_end FROM digests').get();
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM messages WHERE posted_at>=? AND posted_at<?')
    .get(snapshot.window_start,snapshot.window_end).n,95);
});
test('a deliberately short Telegram page cannot masquerade as an empty queue',async()=>{
  const f=fixture();
  let calls=0;
  f.env.TELEGRAM_POLL_PAGES='2';
  await handleUpdate(f.adminMessage,f.env,f.fetcher,NOW-40*60_000);
  const partial=async(url,options)=>{
    if(String(url).endsWith('/getUpdates')){
      calls++;
      if(calls===1)return Response.json({ok:true,result:[{
        update_id:1000,
        message:{message_id:101,date:Math.floor((NOW-1800000)/1000),
          chat:{id:-100999,type:'supergroup',title:'Fictional'},
          from:{id:1,first_name:'Вася'},text:'Сначала первая реплика'}
      }]});
      // Temporary error while fetching the next page. Not evidence of empty queue.
      return Response.json({ok:false},{status:503});
    }
    return f.fetcher(url,options);
  };
  assert.deepEqual(await runCron(f.env,NOW,partial),[]);
  assert.equal(calls,2,'must request another page after a short nonempty response');
  assert.equal(f.count(),1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digests').get().n,0);
});
