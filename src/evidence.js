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


// The authoritative release date is the day stored in D1, not an AI guess.
export function canonicalDigestDate(body, day) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Invalid digest day');
  const [year,month,dayOfMonth]=day.split('-');
  const display=dayOfMonth+'.'+month+'.'+year;
  const lines=String(body??'').split('\n');
  const header=lines.findIndex((line,index)=>index<3&&line.includes('ЧЁРНЫЙ ВЕСТНИК'));
  if(header<0)return '💀 ЧЁРНЫЙ ВЕСТНИК | '+display+'\n\n'+String(body??'');
  const iso=/\b20\d{2}-\d{2}-\d{2}\b/;
  const dotted=/\b\d{2}[.\/]\d{2}[.\/]20\d{2}\b/;
  if(iso.test(lines[header]))lines[header]=lines[header].replace(iso,display);
  else if(dotted.test(lines[header]))lines[header]=lines[header].replace(dotted,display);
  else lines[header]=lines[header]+' | '+display;
  return lines.join('\n');
}

// Conservative non-generative correction for a dropped INTERIOR letter in the
// nominative name immediately attached to a message source pointer.
// Never edit text inside a quotation or try to guess wholly different names.
export function correctNearbyNameTypos(body, rows) {
  let text=String(body??'');
  const source=new Map(rows.map(r=>[Number(r.message_id),String(r.display_name||'').split(/\s+/)[0]]));
  const pointers=[...text.matchAll(/\[#(\d+)\]/g)].reverse();
  for(const pointer of pointers){
    const name=source.get(Number(pointer[1]));
    if(!name||name.length<4)continue;
    const from=Math.max(0,pointer.index-170);
    const span=text.slice(from,pointer.index);
    if(new RegExp('(?<![\\p{L}])'+name+'(?![\\p{L}])','iu').test(span))continue;
    const tokens=[...span.matchAll(/(?<![\p{L}])[А-ЯЁ][а-яё]{2,20}(?![\p{L}])/gu)];
    for(const token of tokens){
      const candidate=token[0];
      if(candidate.length!==name.length-1)continue;
      let match=false;
      for(let i=1;i<name.length-1;i++){
        if((name.slice(0,i)+name.slice(i+1)).toLocaleLowerCase('ru-RU')===candidate.toLocaleLowerCase('ru-RU')){
          match=true;break;
        }
      }
      if(!match)continue;
      const localIndex=token.index;
      // Never mutate a quoted phrase: the quote guard checks literal source text.
      const prefix=span.slice(0,localIndex);
      const inQuotes=(prefix.match(/«/g)||[]).length>(prefix.match(/»/g)||[]).length;
      if(inQuotes)continue;
      const absolute=from+localIndex;
      text=text.slice(0,absolute)+name+text.slice(absolute+candidate.length);
      break;
    }
  }
  return text;
}
