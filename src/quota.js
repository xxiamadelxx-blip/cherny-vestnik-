// Durable Groq pacing. Official response headers take precedence.
// Our UTC token counter sees only THIS bot, not other API clients in the Groq org.
export const DEFAULT_SOFT_TOKEN_BUDGET = 180_000;
const SCOPE = 'organization', MINUTE=60_000, MAX_WAIT=48*60*MINUTE;
export class GroqDeferredError extends Error {
  constructor(retryAt,reason='rate limited'){
    super('Groq deferred: '+reason);
    this.name='GroqDeferredError'; this.retryAt=retryAt;
  }
}
const day = now => new Date(now).toISOString().slice(0,10);
const tomorrow = now => Date.parse(day(now)+'T00:00:00.000Z')+86_400_000;
const positiveInteger = value => {
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value); return Number.isFinite(n)&&n>=0?Math.floor(n):null;
};
const getInt=(headers,key)=>positiveInteger(headers?.get?.(key));
const setting=(value,fallback,min,max)=>{
  const parsed=positiveInteger(value);
  return parsed===null?fallback:Math.min(max,Math.max(min,parsed));
};
export function parseResetDuration(value) {
  const input=String(value??'').trim();
  if(!input)return null;
  const pattern=/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
  const factors={ms:1,s:1000,m:60_000,h:3_600_000,d:86_400_000};
  let total=0,matched='',item;
  while((item=pattern.exec(input))!==null){matched+=item[0];total+=Number(item[1])*factors[item[2]];}
  return matched===input&&Number.isFinite(total)?Math.min(MAX_WAIT,Math.ceil(total)):null;
}
export function retryAfterMs(value,now) {
  const s=String(value??'').trim();
  if(!s)return null;
  if(/^\d+(?:\.\d+)?$/.test(s))
    return Math.min(now+MAX_WAIT,now+Math.max(1000,Math.ceil(Number(s)*1000)));
  const date=Date.parse(s);
  return Number.isFinite(date)?Math.min(now+MAX_WAIT,Math.max(now+1000,date)):null;
}
function resetAt(headers,name,now) {
  const ms=parseResetDuration(headers?.get?.(name));
  return ms===null?0:now+ms;
}
export async function readGroqBudget(env) {
  if(!env?.DB)return null;
  return await env.DB.prepare('SELECT * FROM groq_budget WHERE scope=?').bind(SCOPE).first()||null;
}
export function quotaWaitUntil(state,now=Date.now(),env={}) {
  if(!state)return null;
  const soft=setting(env.GROQ_DAILY_TOKEN_SOFT_LIMIT,DEFAULT_SOFT_TOKEN_BUDGET,10000,1_000_000);
  const reserve=setting(env.GROQ_TOKEN_RESERVE,3500,500,12000);
  let until=Number(state.next_attempt_at||0);
  if(state.day_utc===day(now)&&Number(state.used_tokens||0)>=soft)
    until=Math.max(until,tomorrow(now));
  if(state.remaining_requests!==null&&Number(state.remaining_requests)<=0)
    until=Math.max(until,Number(state.reset_requests_at||0));
  if(state.remaining_tokens!==null&&Number(state.remaining_tokens)<reserve)
    until=Math.max(until,Number(state.reset_tokens_at||0));
  return until>now?until:null;
}
export async function requireGroqAllowance(env,now=Date.now()) {
  const until=quotaWaitUntil(await readGroqBudget(env),now,env);
  if(until)throw new GroqDeferredError(until,'waiting for quota reset');
}
// Count completed AND truncated requests; both can consume provider tokens.
export async function noteGroqSuccess(env,response,usage,now=Date.now()) {
  if(!env?.DB)return;
  const h=response.headers;
  const remainingRequests=getInt(h,'x-ratelimit-remaining-requests');
  const remainingTokens=getInt(h,'x-ratelimit-remaining-tokens');
  const resetRequests=resetAt(h,'x-ratelimit-reset-requests',now);
  const resetTokens=resetAt(h,'x-ratelimit-reset-tokens',now);
  const spent=positiveInteger(usage?.total_tokens)||0;
  const soft=setting(env.GROQ_DAILY_TOKEN_SOFT_LIMIT,DEFAULT_SOFT_TOKEN_BUDGET,10000,1_000_000);
  const reserve=setting(env.GROQ_TOKEN_RESERVE,3500,500,12000);
  const current=await readGroqBudget(env);
  const used=spent+(current?.day_utc===day(now)?Number(current.used_tokens||0):0);
  let next=0;
  if(remainingTokens!==null&&remainingTokens<reserve&&resetTokens>now)next=resetTokens;
  if(remainingRequests===0&&resetRequests>now)next=Math.max(next,resetRequests);
  if(used>=soft)next=Math.max(next,tomorrow(now));
  const sql='INSERT INTO groq_budget (scope,day_utc,used_tokens,remaining_requests,remaining_tokens,'
    +'reset_requests_at,reset_tokens_at,next_attempt_at,strikes,last_status,updated_at) '
    +'VALUES(?,?,?,?,?,?,?,?,0,200,?) '
    +'ON CONFLICT(scope) DO UPDATE SET day_utc=excluded.day_utc,used_tokens=excluded.used_tokens,'
    +'remaining_requests=excluded.remaining_requests,remaining_tokens=excluded.remaining_tokens,'
    +'reset_requests_at=excluded.reset_requests_at,reset_tokens_at=excluded.reset_tokens_at,'
    +'next_attempt_at=MAX(groq_budget.next_attempt_at,excluded.next_attempt_at),'
    +'strikes=0,last_status=200,updated_at=excluded.updated_at';
  await env.DB.prepare(sql).bind(SCOPE,day(now),used,remainingRequests,remainingTokens,resetRequests,resetTokens,next,now).run();
}
// 429: honor retry-after; when daily requests or minute tokens are exhausted,
// wait for provider reset; without headers apply bounded exponential backoff.
export async function noteGroqLimit(env,response,now=Date.now()) {
  const current=await readGroqBudget(env);
  const strikes=Math.min(8,Number(current?.strikes||0)+1);
  const base=Math.min(6*60*MINUTE,MINUTE*2**(strikes-1));
  const retry=retryAfterMs(response.headers?.get?.('retry-after'),now);
  const leftRequests=getInt(response.headers,'x-ratelimit-remaining-requests');
  const leftTokens=getInt(response.headers,'x-ratelimit-remaining-tokens');
  const resetRequests=resetAt(response.headers,'x-ratelimit-reset-requests',now);
  const resetTokens=resetAt(response.headers,'x-ratelimit-reset-tokens',now);
  let until=Math.max(now+base,retry||0);
  if(leftRequests===0&&resetRequests>now)until=Math.max(until,resetRequests);
  if(leftTokens===0&&resetTokens>now)until=Math.max(until,resetTokens);
  if(current?.day_utc===day(now)&&Number(current.used_tokens||0)>=
    setting(env.GROQ_DAILY_TOKEN_SOFT_LIMIT,DEFAULT_SOFT_TOKEN_BUDGET,10000,1_000_000))
    until=Math.max(until,tomorrow(now));
  if(env?.DB){
    const sql='INSERT INTO groq_budget (scope,day_utc,used_tokens,remaining_requests,remaining_tokens,'
      +'reset_requests_at,reset_tokens_at,next_attempt_at,strikes,last_status,updated_at) '
      +'VALUES(?,?,0,?,?,?,?,?,?,429,?) '
      +'ON CONFLICT(scope) DO UPDATE SET remaining_requests=excluded.remaining_requests,'
      +'remaining_tokens=excluded.remaining_tokens,reset_requests_at=excluded.reset_requests_at,'
      +'reset_tokens_at=excluded.reset_tokens_at,'
      +'next_attempt_at=MAX(groq_budget.next_attempt_at,excluded.next_attempt_at),'
      +'strikes=excluded.strikes,last_status=429,updated_at=excluded.updated_at';
    await env.DB.prepare(sql).bind(SCOPE,day(now),leftRequests,leftTokens,resetRequests,resetTokens,until,strikes,now).run();
  }
  return until;
}
