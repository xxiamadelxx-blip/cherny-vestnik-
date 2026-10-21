import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preflight} from '../scripts/preflight.mjs';

const env = {CLOUDFLARE_ACCOUNT_ID:'acct',CLOUDFLARE_API_TOKEN:'cloud',TELEGRAM_BOT_TOKEN:'tg-secret',GROQ_API_KEY:'groq-secret'};
function successResponse(json, status = 200) {return {ok:status<400,status,json:async()=>json};}
function mockFetch(options = {}) {
  const calls = [];
  const fn = async (url, init={}) => {
    calls.push({url,init});
    if (url.endsWith('/getMe')) return successResponse({ok:true,result:{id:123,username:'TestBot'}});
    if (url.endsWith('/models')) return successResponse({data:[{id:'qwen/qwen3.8-27b'}]});
    if (url.endsWith('/chat/completions')) return successResponse({choices:[{message:{content:'проверка'}}]});
    if (url.includes('/d1/database')) return successResponse({success:true,result:[]});
    if (url.includes('/workers/subdomain')) return successResponse({success:true,result:{subdomain:'my-account'}});
    throw Error('Unexpected URL '+url);
  };
  return {fn,calls};
}
test('Preflight checks live APIs without sending Telegram messages or deploying',async()=>{
  const {fn,calls} = mockFetch();
  const lines=[];
  const result=await preflight({env,fetcher:fn,log:x=>lines.push(x)});
  assert.equal(result.botUsername,'TestBot');
  assert.equal(result.checks.length,5);
  assert.equal(calls.length,5);
  assert(calls.every(c=>!c.url.includes('/sendMessage') && !c.url.includes('/setWebhook')));
  assert(lines.at(-1).includes('Not deployed'));
});
test('Preflight fails locally when secret is absent, with no API calls',async()=>{
  const {fn,calls} = mockFetch();
  await assert.rejects(preflight({env:{...env,GROQ_API_KEY:''},fetcher:fn,log:()=>{}}),/GROQ_API_KEY/);
  assert.equal(calls.length,0);
});
test('Preflight rejects unavailable Groq model before requesting completion',async()=>{
  const {fn,calls} = mockFetch();
  const bad = async (url,init) => url.endsWith('/models') ? successResponse({data:[{id:'other'}]}) : fn(url,init);
  await assert.rejects(preflight({env,fetcher:bad,log:()=>{}}),/unavailable/);
  assert.equal(calls.length,1);
});
test('Preflight rejects Cloudflare Workers missing subdomain',async()=>{
  const {fn} = mockFetch();
  const bad = async (url,init) => url.includes('/workers/subdomain') ? successResponse({success:true,result:{}}) : fn(url,init);
  await assert.rejects(preflight({env,fetcher:bad,log:()=>{}}),/subdomain not configured/);
});
