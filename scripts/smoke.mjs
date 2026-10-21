import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';

// This smoke test uses ONLY read-only Telegram and Cloudflare API calls and an
// unauthorized request to the Worker. It never processes or sends group messages.
export async function smoke({env=process.env, fetcher=fetch, log=console.log} = {}) {
  const required=['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','TELEGRAM_BOT_TOKEN'];
  const missing=required.filter(key=>!env[key]?.trim());
  if (missing.length) throw new Error('Missing GitHub secrets: '+missing.join(', '));
  const request=async(url,options={}) => fetcher(url,{...options,signal:AbortSignal.timeout(15000)});
  const accountId=encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
  const cf=await request('https://api.cloudflare.com/client/v4/accounts/'+accountId+'/workers/subdomain',{
    headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN}
  });
  if (!cf.ok) throw new Error('Cloudflare subdomain HTTP '+cf.status);
  const cfData=await cf.json();
  const subdomain=cfData?.result?.subdomain;
  if (!cfData?.success||!subdomain||!/^[a-z\d-]+$/i.test(subdomain))
    throw new Error('Cloudflare subdomain invalid');
  const base='https://cherny-vestnik.'+subdomain+'.workers.dev';
  const telegram=await request('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getWebhookInfo');
  if (!telegram.ok) throw new Error('Telegram getWebhookInfo HTTP '+telegram.status);
  const info=await telegram.json();
  const transport=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars?.TELEGRAM_TRANSPORT||'webhook';
  if(transport==='polling') {
    if(!info?.ok||info?.result?.url)throw new Error('Telegram webhook still active; getUpdates polling would be blocked');
    log('PASS Telegram webhook disabled, queued updates retained for D1 polling');
  }else{
    if(!info?.ok||info?.result?.url!==base+'/webhook')
      throw new Error('Telegram webhook not registered to expected Worker');
    log('PASS Telegram webhook URL points to expected Worker');
  }
  const health=await request(base+'/healthz');
  if (!health.ok) throw new Error('Live Worker /healthz HTTP '+health.status);
  const body=await health.json();
  if (body?.ok!==true||typeof body.version!=='string') throw new Error('Worker health payload invalid');
  const expectedVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
  if(body.version!==expectedVersion)throw new Error('Live Worker version mismatch: expected '+expectedVersion+' but found '+body.version);
  log('PASS Live Worker /healthz version '+expectedVersion);
  const forged=await request(base+'/webhook',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':'invalid-smoke-token'},
    body:JSON.stringify({update_id:-999999,message:{text:'/now'}})
  });
  if (forged.status!==403) throw new Error('Worker accepted forged webhook or unexpected HTTP '+forged.status);
  log('PASS Worker rejects forged Telegram webhook (403)');
  log('SMOKE PASS: Telegram transport '+transport+', live Worker health, anti-forgery. No chat messages sent.');
  return {url:base,version:body.version};
}
if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  smoke().catch(error=>{console.error('SMOKE FAIL: '+String(error.message).slice(0,180));process.exitCode=1;});
}
