import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';


export function stableWebhookSecret(token,accountId) {
  if(!token||!accountId)throw new Error('Cannot derive stable Telegram webhook secret');
  // Deterministic and private, so a failed webhook registration never breaks
  // future deployments by silently rotating the Worker-side secret.
  return createHmac('sha256',token)
    .update('cherny-vestnik:telegram-webhook:v1:'+accountId)
    .digest('hex').slice(0,48);
}

export async function setTelegramWebhook({fetcher=fetch,url,token,secret,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let status=0,lastReason='unavailable';
  for(let attempt=0;attempt<4;attempt++){
    try {
      const result=await fetcher('https://api.telegram.org/bot'+token+'/setWebhook',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url:url+'/webhook',secret_token:secret,
          allowed_updates:['message'],drop_pending_updates:false,max_connections:3}),
        signal:AbortSignal.timeout(16000)
      });
      status=result.status;
      let reply;
      try {reply=await result.json();}catch{reply=null;}
      if(result.ok&&reply?.ok===true)return true;
      // 400/401/403 are configuration errors, not transient.
      if(result.status!==429&&result.status<500) {
        const description=String(reply?.description||'unspecified Telegram rejection')
          .replaceAll(token,'[token]').replaceAll(secret,'[secret]').replaceAll(url,'[worker]')
          .replace(/https?:\/\/[^\s]+/g,'[url]')
          .slice(0,180);
        lastReason=description;
        if(result.status===400 && /failed to resolve host|temporary failure in name resolution|dns lookup/i.test(description)) {
          // Telegram occasionally cannot resolve Cloudflare workers.dev from its
          // own DNS, even though the Worker is live on the public Internet.
          // Telegram reports this transient infrastructure issue as HTTP 400.
          if(attempt===3)break;
          await wait(2000*2**attempt);
          continue;
        }
        throw new Error('Telegram setWebhook rejected request (HTTP '+result.status+'): '+description);
      }
      if(attempt===3)break;
      const retryHeader=Number(result.headers?.get('retry-after'));
      const backoff=Number.isFinite(retryHeader)&&retryHeader>0?
        Math.min(16000,Math.ceil(retryHeader*1000)):
        600*2**attempt;
      await wait(backoff);
    }catch(error){
      if(/setWebhook rejected request/.test(String(error)))throw error;
      if(attempt===3)break;
      await wait(600*2**attempt);
    }
  }
  throw new Error('Telegram setWebhook failed after four attempts (last HTTP '+status+'): '+lastReason);
}


export async function deleteTelegramWebhook({fetcher=fetch,token,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let status=0;
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await fetcher('https://api.telegram.org/bot'+token+'/deleteWebhook',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({drop_pending_updates:false}),signal:AbortSignal.timeout(16000)
      });
      status=response.status;
      const result=await response.json();
      if(response.ok&&result?.ok===true)return true;
      if(response.status!==429&&response.status<500)
        throw Error('Telegram deleteWebhook rejected request (HTTP '+response.status+')');
    }catch(err){
      if(/deleteWebhook rejected request/.test(String(err)))throw err;
      if(attempt===3)break;
    }
    if(attempt!==3)await wait(700*2**attempt);
  }
  throw Error('Telegram deleteWebhook failed after four attempts (last HTTP '+status+')');
}

export async function activate({env = process.env, fetcher = fetch, putSecret = null}) {
  const required = ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','TELEGRAM_BOT_TOKEN','GROQ_API_KEY'];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing GitHub Actions secret: ${key}`);
  const cf = async (route) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}${route}`, {
      headers: {Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`}
    });
    if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.success) throw new Error('Cloudflare request failed');
    return data.result;
  };
  const runner = putSecret || (async (name, value) => {
    if (!value?.trim()) throw new Error(`Refusing to upload an empty secret: ${name}`);
    const result = spawnSync('npx', ['wrangler','secret','put',name], {
      input: value + '\n', encoding: 'utf8', env, stdio: ['pipe','pipe','pipe']
    });
    // Do not print the child output, which might contain sensitive data.
    if (result.status !== 0) throw new Error(`Worker secret ${name} upload failed (exit ${result.status})`);
  });
  const webhookSecret = stableWebhookSecret(env.TELEGRAM_BOT_TOKEN,env.CLOUDFLARE_ACCOUNT_ID);
  await runner('TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN);
  await runner('GROQ_API_KEY', env.GROQ_API_KEY);
  await runner('TELEGRAM_WEBHOOK_SECRET', webhookSecret);
  const result = await cf('/workers/subdomain');
  if (!/^[a-z\d-]+$/i.test(result?.subdomain || '')) throw new Error('Cloudflare Workers subdomain is missing');
  const url = `https://cherny-vestnik.${result.subdomain}.workers.dev`;
  const health = await fetcher(url + '/healthz');
  if (!health.ok) throw new Error(`Deployed Worker health check failed: HTTP ${health.status}`);
  if(env.TELEGRAM_TRANSPORT==='polling'){
    // Telegram-side DNS cannot consistently resolve workers.dev. Disabling the
    // webhook is required for getUpdates to work. Preserve queued messages.
    await deleteTelegramWebhook({fetcher,token:env.TELEGRAM_BOT_TOKEN});
    return {url,webhookConfigured:false,polling:true};
  }
  await setTelegramWebhook({fetcher,url,token:env.TELEGRAM_BOT_TOKEN,secret:webhookSecret});
  return {url,webhookConfigured:true,polling:false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  activate({}).then(result => console.log(result.polling?`Bot deployed in DNS-independent Telegram polling mode: ${result.url}`:`Bot deployed and webhook registered: ${result.url}`))
    .catch(error => {console.error(String(error.message)); process.exitCode = 1;});
}
