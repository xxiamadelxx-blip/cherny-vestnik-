import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionD1} from '../scripts/provision-d1.mjs';
import {activate,stableWebhookSecret,setTelegramWebhook} from '../scripts/activate-cloudflare.mjs';

const UUID='12345678-1234-1234-1234-123456789abc';
const apiEnv = {CLOUDFLARE_API_TOKEN:'fake',CLOUDFLARE_ACCOUNT_ID:'fake',TELEGRAM_BOT_TOKEN:'123:TEST',GROQ_API_KEY:'fake'};

function localConfig() {
  const dir=mkdtempSync(join(tmpdir(),'vestnik-'));
  const configPath=join(dir,'wrangler.jsonc');
  writeFileSync(configPath,JSON.stringify({d1_databases:[{binding:'DB',database_id:'REPLACE_WITH_D1_DATABASE_UUID'}]}));
  return {dir,configPath};
}

test('Cloudflare deployment reuses existing D1 and never creates a duplicate',async()=>{
  const f=localConfig();let calls=0;
  try {
    const result=await provisionD1({token:'fake',accountId:'fake',configPath:f.configPath,fetcher:async(url,opts)=>{
      calls++;assert.match(url,/name=cherny-vestnik/);assert.equal(opts.method,undefined);
      return Response.json({success:true,result:[{name:'cherny-vestnik',uuid:UUID}]});
    }});
    assert.equal(calls,1);assert.equal(result.created,false);
    assert.equal(JSON.parse(readFileSync(f.configPath)).d1_databases[0].database_id,UUID);
  } finally {rmSync(f.dir,{force:true,recursive:true});}
});

test('Cloudflare deployment creates missing D1 database once',async()=>{
  const f=localConfig();const methods=[];
  try {
    const result=await provisionD1({token:'fake',accountId:'fake',configPath:f.configPath,fetcher:async(url,opts)=>{
      methods.push(opts.method||'GET');
      if(opts.method==='POST') assert.deepEqual(JSON.parse(opts.body),{name:'cherny-vestnik'});
      return Response.json({success:true,result:opts.method==='POST'?{name:'cherny-vestnik',uuid:UUID}:[]});
    }});
    assert.deepEqual(methods,['GET','POST']);assert.equal(result.created,true);
    assert.equal(JSON.parse(readFileSync(f.configPath)).d1_databases[0].database_id,UUID);
  } finally {rmSync(f.dir,{force:true,recursive:true});}
});

test('Cloudflare D1 failure aborts before editing Wrangler config',async()=>{
  const f=localConfig();
  try {
    const original=readFileSync(f.configPath,'utf8');
    await assert.rejects(provisionD1({token:'fake',accountId:'fake',configPath:f.configPath,
      fetcher:async()=>Response.json({success:false,errors:[]})}),/rejected/);
    assert.equal(readFileSync(f.configPath,'utf8'),original);
  } finally {rmSync(f.dir,{force:true,recursive:true});}
});

test('Telegram webhook is registered only after all Worker secrets and health check',async()=>{
  const order=[];
  const result=await activate({env:apiEnv,putSecret:async(k,v)=>{
    order.push('secret:'+k);assert.ok(v.length>0);
  },fetcher:async(url,options)=>{
    if(url.includes('cloudflare.com')) {order.push('subdomain');return Response.json({success:true,result:{subdomain:'example'}});}
    if(url.endsWith('/healthz')) {order.push('health');return Response.json({ok:true});}
    if(url.endsWith('/setWebhook')) {
      order.push('webhook');const body=JSON.parse(options.body);
      assert.equal(body.url,'https://cherny-vestnik.example.workers.dev/webhook');
      assert.match(body.secret_token,/^[0-9a-f]{48}$/);
      return Response.json({ok:true,result:true});
    }
    throw new Error('Unexpected URL');
  }});
  assert.deepEqual(order,['secret:TELEGRAM_BOT_TOKEN','secret:GROQ_API_KEY','secret:TELEGRAM_WEBHOOK_SECRET','subdomain','health','webhook']);
  assert.equal(result.webhookConfigured,true);
});

test('Missing required secret stops deployment before any network or Worker changes',async()=>{
  await assert.rejects(activate({env:{...apiEnv,GROQ_API_KEY:''},fetcher:()=>{throw Error('should not be called');},putSecret:()=>{throw Error('should not be called');}}),/GROQ_API_KEY/);
});


test('Telegram webhook HMAC is stable between deploys and never exposes the bot token',()=>{
 const first=stableWebhookSecret('1111:LONG_TEST_SECRET','account-one');
 assert.equal(first,stableWebhookSecret('1111:LONG_TEST_SECRET','account-one'));
 assert.notEqual(first,stableWebhookSecret('2222:OTHER_TEST_SECRET','account-one'));
 assert.notEqual(first,stableWebhookSecret('1111:LONG_TEST_SECRET','account-two'));
 assert.match(first,/^[a-f0-9]{48}$/);
 assert.ok(!first.includes('LONG_TEST_SECRET'));
});
test('Telegram webhook registration retries 429 and 503 without rotating the secret',async()=>{
 const waits=[],secrets=[];let calls=0;
 await setTelegramWebhook({
   url:'https://cherny-vestnik.example.workers.dev',
   token:'123:test',secret:'a'.repeat(48),
   wait:async value=>{waits.push(value);},
   fetcher:async(_url,opts)=>{
     const req=JSON.parse(opts.body);
     secrets.push(req.secret_token);
     calls++;
     if(calls===1)return Response.json({ok:false},{status:429,headers:{'retry-after':'3'}});
     if(calls===2)return Response.json({ok:false},{status:503});
     return Response.json({ok:true,result:true});
   }
 });
 assert.equal(calls,3);
 assert.deepEqual(waits,[3000,1200]);
 assert.deepEqual(secrets,Array(3).fill('a'.repeat(48)));
});
test('Telegram webhook registration stops on permanent 401, no automatic retries',async()=>{
 let attempts=0;
 await assert.rejects(setTelegramWebhook({
  url:'https://cherny-vestnik.example.workers.dev',token:'fake',secret:'1'.repeat(48),
  wait:()=>{throw Error('must not sleep');},
  fetcher:async()=>{attempts++;return Response.json({ok:false},{status:401});}
 }),/HTTP 401/);
 assert.equal(attempts,1);
});


test('Telegram reports transient Cloudflare DNS failure as HTTP 400; retry rather than treating it as invalid key',async()=>{
 const waits=[];let calls=0;
 const result=await setTelegramWebhook({
   url:'https://cherny-vestnik.example.workers.dev',
   token:'fake-token',secret:'2'.repeat(48),wait:async ms=>{waits.push(ms)},
   fetcher:async()=>{
     calls++;
     return calls<3?Response.json({
       ok:false,description:'Bad Request: bad webhook: Failed to resolve host: Temporary failure in name resolution'
     },{status:400}):Response.json({ok:true,result:true});
   }
 });
 assert.equal(result,true);
 assert.equal(calls,3);
 assert.deepEqual(waits,[2000,4000]);
});
