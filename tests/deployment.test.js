import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionD1} from '../scripts/provision-d1.mjs';
import {activate} from '../scripts/activate-cloudflare.mjs';

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
