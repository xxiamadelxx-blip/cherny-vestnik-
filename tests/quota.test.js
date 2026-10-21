import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  parseResetDuration,retryAfterMs,readGroqBudget,quotaWaitUntil,
  requireGroqAllowance,noteGroqSuccess,noteGroqLimit,GroqDeferredError
} from '../src/quota.js';
import {createDigest} from '../src/ai.js';

function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0003_groq_budget.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...p){return {
    first:async()=>statement.get(...p)||null,
    all:async()=>({results:statement.all(...p)}),
    run:async()=>({meta:{changes:statement.run(...p).changes}})
  };}};}};
  return {sqlite,env:{DB,GROQ_API_KEY:'test'}};
}
const NOW=Date.UTC(2026,9,21,12,0,0);

test('Groq Go-style reset durations and Retry-After are parsed safely',()=>{
  assert.equal(parseResetDuration('2m59.56s'),179560);
  assert.equal(parseResetDuration('7.66s'),7660);
  assert.equal(parseResetDuration('1h2m3.4s'),3723400);
  assert.equal(parseResetDuration('garbage'),null);
  assert.equal(parseResetDuration(''),null);
  assert.equal(retryAfterMs('125',NOW),NOW+125000);
  assert.equal(retryAfterMs(new Date(NOW+90_000).toUTCString(),NOW),NOW+90000);
  assert.equal(retryAfterMs('bad',NOW),null);
});
test('429 records server Retry-After and prevents new Groq requests until reset',async()=>{
  const {env}=fixture();
  const response=new Response('',{status:429,headers:{
    'retry-after':'125','x-ratelimit-remaining-tokens':'0',
    'x-ratelimit-reset-tokens':'2m','x-ratelimit-remaining-requests':'500'
  }});
  const until=await noteGroqLimit(env,response,NOW);
  assert.equal(until,NOW+125000);
  const state=await readGroqBudget(env);
  assert.equal(state.last_status,429);
  assert.equal(state.remaining_requests,500);
  assert.equal(state.remaining_tokens,0);
  assert.equal(state.next_attempt_at,until);
  await assert.rejects(requireGroqAllowance(env,NOW+1000),
    err=>err instanceof GroqDeferredError&&err.retryAt===until);
  await requireGroqAllowance(env,NOW+125001);
});
test('zero remaining requests waits for daily provider reset, not minute reset',async()=>{
  const {env}=fixture();
  const h={'retry-after':'3','x-ratelimit-remaining-requests':'0',
    'x-ratelimit-reset-requests':'2h10m','x-ratelimit-remaining-tokens':'7000'};
  const until=await noteGroqLimit(env,new Response('',{status:429,headers:h}),NOW);
  assert.equal(until,NOW+7800000);
  assert.equal(quotaWaitUntil(await readGroqBudget(env),NOW+60_000,env),until);
});
test('missing rate-limit headers use exponential cooldown across failures',async()=>{
  const {env}=fixture();
  const failed=new Response('',{status:429});
  const a=await noteGroqLimit(env,failed,NOW);
  const b=await noteGroqLimit(env,failed,NOW+10_000);
  assert.equal(a,NOW+60_000);
  assert.equal(b,NOW+130_000);
  assert.equal((await readGroqBudget(env)).strikes,2);
});
test('successful response tracks token usage and predicts minute reset',async()=>{
  const {env}=fixture();
  const response=new Response('',{status:200,headers:{
    'x-ratelimit-remaining-requests':'999',
    'x-ratelimit-reset-requests':'2h',
    'x-ratelimit-remaining-tokens':'900',
    'x-ratelimit-reset-tokens':'38.5s'
  }});
  await noteGroqSuccess(env,response,{total_tokens:4200},NOW);
  const state=await readGroqBudget(env);
  assert.equal(state.used_tokens,4200);
  assert.equal(state.remaining_tokens,900);
  assert.equal(quotaWaitUntil(state,NOW+1000,env),NOW+38500);
  await requireGroqAllowance(env,NOW+39000);
});
test('local soft TPD budget defers until next UTC day and never charges money',async()=>{
  const {env}=fixture();
  env.GROQ_DAILY_TOKEN_SOFT_LIMIT='10000';
  const response=new Response('',{status:200});
  await noteGroqSuccess(env,response,{total_tokens:7000},NOW);
  await noteGroqSuccess(env,response,{total_tokens:4000},NOW+1000);
  const state=await readGroqBudget(env);
  assert.equal(state.used_tokens,11000);
  assert.equal(quotaWaitUntil(state,NOW+2000,env),Date.UTC(2026,9,22,0));
  await requireGroqAllowance(env,Date.UTC(2026,9,22,0,1));
});
test('real AI caller inspects Groq headers before making another completion',async()=>{
  const {env}=fixture();
  let calls=0;
  const fetcher=async()=>{
    calls++;
    return Response.json({
      choices:[{message:{content:'💀 ЧЁРНЫЙ ВЕСТНИК. Саня снова пообещал экономить и полез за новой кофемашиной. Полный ёбаный цирк.'},finish_reason:'stop'}],
      usage:{total_tokens:3750}
    },{headers:{
      'x-ratelimit-remaining-tokens':'800','x-ratelimit-reset-tokens':'1m',
      'x-ratelimit-remaining-requests':'900'
    }});
  };
  const rows=[{message_id:31,display_name:'Саня',body:'Куплю кофемашину за сорок тысяч'}];
  await createDigest({env,day:'2026-10-21',total:1,rows,fetcher});
  assert.equal(calls,1);
  await assert.rejects(createDigest({env,day:'2026-10-21',total:1,rows,fetcher}),
    error=>error instanceof GroqDeferredError);
  assert.equal(calls,1,'must not issue second HTTP request during cooldown');
});
