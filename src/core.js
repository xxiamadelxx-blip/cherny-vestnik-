export const MAX_TEXT = 3800;
export const ONE_DAY_MS = 86_400_000;
export const MESSAGE_RETENTION_MS = 4 * ONE_DAY_MS;
export const MEMORY_RETENTION_MS = 14 * ONE_DAY_MS;

export function localClock(nowMs, timeZone = 'Europe/Moscow') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(nowMs));
  const part = (name) => parts.find(p => p.type === name)?.value;
  return {day: `${part('year')}-${part('month')}-${part('day')}`,
    hhmm: `${part('hour')}:${part('minute')}`};
}

export function scheduledDue(hhmm, nowHhmm) {
  const toMinutes = v => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm) && toMinutes(nowHhmm) >= toMinutes(hhmm);
}

export function cleanText(s, maxLength = 700) {
  return String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeMessage(message) {
  if (!message || !['group', 'supergroup'].includes(message.chat?.type)) return null;
  if (message.from?.is_bot || message.forward_origin) return null;
  const body = cleanText(message.text ?? message.caption, 4096);
  if (!body || body.startsWith('/')) return null;
  const displayName = cleanText(
    [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
    message.sender_chat?.title || 'Аноним', 65);
  return {
    chat_id: String(message.chat.id),
    message_id: message.message_id,
    user_id: String(message.from?.id ?? `sender:${message.sender_chat?.id || 'unknown'}`),
    display_name: displayName,
    body,
    posted_at: Number(message.date) * 1000
  };
}

export function countParticipants(rows) {
  const counts = new Map();
  for (const m of rows) counts.set(m.user_id, {name: m.display_name, count: (counts.get(m.user_id)?.count || 0) + 1});
  return [...counts.values()].sort((a,b) => b.count - a.count).slice(0, 5);
}

export function splitTelegramText(source, limit = MAX_TEXT) {
  const result = [];
  let remaining = String(source).trim();
  while (remaining) {
    if (remaining.length <= limit) {result.push(remaining); break;}
    let split = remaining.lastIndexOf('\n\n', limit);
    if (split < limit * 0.35) split = remaining.lastIndexOf('\n', limit);
    if (split < limit * 0.35) split = remaining.lastIndexOf(' ', limit);
    if (split < limit * 0.35) split = limit;
    // Do not split UTF-16 surrogate pairs.
    if (split > 0 && /[\uD800-\uDBFF]/.test(remaining[split - 1]) && /[\uDC00-\uDFFF]/.test(remaining[split])) split--;
    result.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }
  return result;
}

export function fallbackDigest({day, total, sampleRows, sampled}) {
  const leaders = countParticipants(sampleRows).map((p,i) => `${i + 1}. ${p.name}: ${p.count} сообщений в выборке`).join('\n') || 'Сегодня без претендентов.';
  const tail = total > sampled ? `\nИз ${total} сообщений в сводку отобрано ${sampled}.` : '';
  return `💀 ЧЁРНЫЙ ВЕСТНИК | ${day}\n\nСегодня чат произвёл ${total} сообщений. Это, блядь, уже статистика, а не переписка.\n\n🏆 Самые разговорчивые по выборке:\n${leaders}\n\n⚠️ Нейросеть не ответила, поэтому выдумывать срачи и цитаты не будем. Это честный статистический выпуск.${tail}`;
}

export function safeAiOutput(raw, validMessageIds) {
  const text = String(raw ?? '').trim();
  if (text.length < 40) throw new Error('AI generated empty or implausibly short text');
  // Strip any fabricated source pointers; do not fabricate references to real people.
  return text.replace(/\[#(\d+)\]/g, (match, id) => validMessageIds.has(Number(id)) ? match : '[без подтверждения]')
    .slice(0, 11000);
}

// Consecutive batches: unlike selectTranscript, no input message is sampled away.
// The caller advances its durable cursor ONLY after a batch is analyzed and saved.
export function packTranscript(rows, maxChars = 5400, maxEntries = 40) {
  const selected = [];
  const ids = [];
  let length = 0;
  for (const m of rows) {
    if (selected.length >= maxEntries) break;
    const line = `[#${m.message_id}] ${cleanText(m.display_name, 65)}: ${cleanText(m.body, 4096)}`;
    if (selected.length && length + line.length + 1 > maxChars) break;
    selected.push(line);
    ids.push(Number(m.message_id));
    length += line.length + 1;
  }
  return {transcript:selected.join('\n'),count:selected.length,ids};
}