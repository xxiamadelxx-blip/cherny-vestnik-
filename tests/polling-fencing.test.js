import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {pollTelegram} from '../src/polling.js';

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0006_telegram_poller.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){const st=sqlite.prepare(sql);return {bind(...args){return {
    first:async()=>st.get(...args)||null,
    run:async()=>({meta:{changes:st.run(...args).changes}})
  };}};}};
  return {sqlite,env:{DB,TELEGRAM_BOT_TOKEN:'test-token'}};
}
const response=updates=>Response.json({ok:true,result:updates});
const update=id=>({update_id:id,message:{message_id:id,text:'msg '+id}});
test('poller persists every update and resumes after a handler crash',async()=>{
  const {sqlite,env}=fixture();
  let first=true;
  const fetcher=async()=>response([update(1),update(2)]);
  await assert.rejects(pollTelegram(env,{now:1000,fetcher,handleUpdate:async item=>{
    if(item.update_id===2&&first){first=false;throw Error('temporary crash');}
  }}),/temporary crash/);
  assert.equal(sqlite.prepare('SELECT last_update_id FROM telegram_poller').get().last_update_id,1);
  const seen=[];
  const resumed=await pollTelegram(env,{now:2000,fetcher,handleUpdate:async item=>seen.push(item.update_id)});
  assert.deepEqual(seen,[2]);
  assert.equal(resumed.processed,1);
  assert.equal(sqlite.prepare('SELECT last_update_id FROM telegram_poller').get().last_update_id,2);
});
test('an expired invocation cannot erase newer poll lease or overwrite its cursor',async()=>{
  const {sqlite,env}=fixture();
  const now=1000, lease=now+115000;
  const fetcher=async()=>{
    // Another Cron claimed the lease after the first one expired.
    sqlite.prepare('UPDATE telegram_poller SET lease_until=?,last_update_id=? WHERE name=?')
      .run(lease+115000,20,'primary');
    return response([update(1)]);
  };
  await assert.rejects(pollTelegram(env,{now,fetcher,handleUpdate:async()=>{}}),/lease lost/);
  const row=sqlite.prepare('SELECT lease_until,last_update_id FROM telegram_poller').get();
  assert.equal(row.lease_until,lease+115000);
  assert.equal(row.last_update_id,20);
});
test('poller does not claim a currently active lease',async()=>{
  const {sqlite,env}=fixture();
  sqlite.prepare('UPDATE telegram_poller SET lease_until=999999').run();
  const result=await pollTelegram(env,{now:1000,fetcher:async()=>{throw Error('should not call Telegram');},handleUpdate:async()=>{}});
  assert.equal(result.status,'locked');
});
