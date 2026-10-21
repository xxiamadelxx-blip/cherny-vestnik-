// Mechanical evidence guard. It validates source IDs and verbatim quotes;
// it does NOT certify semantic paraphrases, motives or inferred chronology.
export class EvidenceValidationError extends Error {
  constructor(reason){
    super('Editorial verification rejected: '+reason);
    this.name='EvidenceValidationError';
  }
}
const QUOTED_SOURCE = /[«“"]([^»”"\n]{3,350})[»”"]\s*[,.!?;:]?\s*\[#(\d+)\]/gu;
const POINTER=/\[#(\d+)\]/g;

export function citedMessageIds(body) {
  return [...new Set([...String(body).matchAll(POINTER)].map(m=>Number(m[1])))];
}
function normalized(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('ru-RU');
}
export function verifyEditorialEvidence(body, sourceRows) {
  const text=String(body??'');
  const entries=new Map(sourceRows.map(row=>[Number(row.message_id),row]));
  const refs=citedMessageIds(text);
  if(text.includes('[без подтверждения]'))throw new EvidenceValidationError('unverified citation placeholder');
  if(refs.length>100)throw new EvidenceValidationError('excessive citation count');
  for(const id of refs) {
    if(!Number.isSafeInteger(id)||!entries.has(id))
      throw new EvidenceValidationError('missing cited message');
  }
  let checked=0;
  for(const match of text.matchAll(QUOTED_SOURCE)) {
    checked++;
    const id=Number(match[2]);
    const row=entries.get(id);
    if(!row||!normalized(row.body).includes(normalized(match[1])))
      throw new EvidenceValidationError('verbatim quote does not match the cited message');
  }
  return {cited:refs.length,quotesChecked:checked};
}
export async function fetchCitedMessages({db,chatId,body}) {
  const refs=citedMessageIds(body);
  if(refs.length>100)throw new EvidenceValidationError('excessive citation count');
  if(!refs.length)return [];
  // Only fetch messages this digest actually cites, never all chat messages.
  const placeholders=refs.map(()=>'?').join(',');
  const query='SELECT message_id,body,display_name FROM messages WHERE chat_id=? AND message_id IN ('+placeholders+')';
  const result=await db.prepare(query).bind(String(chatId),...refs).all();
  return result.results||[];
}
export async function verifyPublishedDigest({db,chatId,body,rows=null}) {
  if(!rows)rows=await fetchCitedMessages({db,chatId,body});
  return verifyEditorialEvidence(body,rows);
}
