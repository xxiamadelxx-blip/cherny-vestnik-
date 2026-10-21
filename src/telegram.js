export async function telegram(env, method, params, fetcher = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const res = await fetcher(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(params), signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${method}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram API error: ${method}: ${String(data.description).slice(0,150)}`);
  return data.result;
}

export async function send(env, chatId, text, fetcher = fetch) {
  return telegram(env, 'sendMessage', {chat_id:chatId, text, disable_web_page_preview:true}, fetcher);
}

export async function isAdmin(env, chatId, userId, fetcher = fetch) {
  const member = await telegram(env, 'getChatMember', {chat_id:chatId, user_id:userId}, fetcher);
  return ['creator', 'administrator'].includes(member.status);
}
