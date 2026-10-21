import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {composeDigest} from '../src/ai.js';
import {GroqDeferredError} from '../src/quota.js';

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of ['0003_groq_budget.sql','0004_digest_reductions.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const DB={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {
    first:async()=>statement.get(...args)||null,
    all:async()=>({results:statement.all(...args)}),
    run:async()=>({meta:{changes:statement.run(...args).changes}})
  };}};}};
  return {sqlite,env:{DB,GROQ_API_KEY:'fake',GROQ_MODEL:'qwen/qwen3.8-27b'}};
}
test('multi-level editorial checkpoint resumes after 429 without regenerating finished reductions',async()=>{
  const {sqlite,env}=fixture();
  const notes=Array.from({length:6},(_,i)=>({
    note:'[#'+(1001+i)+'] Автор: '+('говорил о причине, последствиях и противоречии; '.repeat(49)),
    ids:[1001+i]
  }));
  let calls=0,finished=0,firstOnly=0,failed=false;
  const fetcher=async(_url,init)=>{
    const req=JSON.parse(init.body);
    if(req.messages[0].content.startsWith('Сжать доказанные')){
      calls++;
      if(calls===3&&!failed){
        failed=true;
        return Response.json({error:'rate limit'},{status:429,headers:{'retry-after':'160'}});
      }
      if(req.messages[1].content.includes('1001'))firstOnly++;
      return Response.json({choices:[{message:{
        content:'[#1001] Автор: спорил о причинах; [#1002] Автор: указал на последствия и противоречия.'
      },finish_reason:'stop'}]});
    }
    finished++;
    return Response.json({choices:[{message:{
      content:'💀 ЧЁРНЫЙ ВЕСТНИК. Автор вчера объявил одно, сегодня обратное. Ёбаный цирк с расходами и обещаниями. Факты совпадают с беседой.'
    },finish_reason:'stop'}]});
  };
  const args={env,day:'2026-10-21',total:1000,notes,fetcher,chatId:'-100fixture'};
  await assert.rejects(composeDigest(args),error=>error instanceof GroqDeferredError);
  assert.equal(calls,3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM digest_reductions').get().n,2);
  // This second call must reuse 2 saved summaries and never hit Groq before reset.
  await assert.rejects(composeDigest(args),error=>error instanceof GroqDeferredError);
  assert.equal(calls,3);
  // Emulate actual quota reset; no sleeping or real API secrets.
  sqlite.prepare('UPDATE groq_budget SET next_attempt_at=0,remaining_tokens=NULL,remaining_requests=NULL').run();
  const result=await composeDigest(args);
  assert.match(result.body,/ЧЁРНЫЙ ВЕСТНИК/);
  assert.equal(finished,1);
  assert.ok(sqlite.prepare('SELECT COUNT(*) AS n FROM digest_reductions').get().n>=6);
  assert.equal(firstOnly,1,'cached first group must not be sent again');
});
