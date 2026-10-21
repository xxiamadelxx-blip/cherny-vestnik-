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
  if(/\[\s*[,;]?\s*#\s*\d+\s*\]/u.test(text) && /\[\s*[,;]\s*#|\[#\s+\d+/u.test(text))
    throw new EvidenceValidationError('malformed source pointer');
  for(const match of text.matchAll(/[\u3400-\u9fff]+/gu)) {
    if(!sourceRows.some(row=>String(row.body||'').includes(match[0])))
      throw new EvidenceValidationError('non-source foreign script fragment');
  }
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


// Repair only NEAR-MISS quotes by substituting a genuinely contiguous span from
// the cited raw message. A fabricated quote with unrelated words still FAILS.
// This costs zero Groq tokens and never invents source text.
function sourceWords(text) {
  return [...String(text).matchAll(/[\p{L}\p{N}]+/gu)]
    .map(m=>({word:m[0].toLocaleLowerCase('ru-RU'),start:m.index,end:m.index+m[0].length}));
}
function sameStem(a,b) {
  if(a===b)return true;
  // Word ending changes ('понимаем' vs 'понимаете') may be repaired,
  // but quoted output is always replaced with a literal source excerpt.
  return a.length>=5&&b.length>=5&&a.slice(0,3)===b.slice(0,3);
}
function nearestLiteralSource(quote,source) {
  const required=sourceWords(quote).map(t=>t.word);
  const words=sourceWords(source);
  if(required.length<2||required.length>45||words.length>800)return null;
  let winner=null;
  const maxWidth=Math.min(180,Math.max(70,quote.length*3));
  for(let i=0;i<words.length;i++){
    for(let j=i;j<words.length&&j<i+38;j++){
      const width=words[j].end-words[i].start;
      if(width>maxWidth)break;
      const candidates=words.slice(i,j+1).map(t=>t.word);
      if(!required.every(term=>candidates.some(word=>sameStem(term,word))))continue;
      if(!winner||width<winner.width)
        winner={width,source:source.slice(words[i].start,words[j].end)};
      break;
    }
  }
  return winner?.source||null;
}
export function correctNearMissQuotes(body,sourceRows) {
  const source=new Map(sourceRows.map(row=>[Number(row.message_id),String(row.body||'')]));
  return String(body??'').replace(QUOTED_SOURCE,(full,quoted,id)=>{
    const actual=source.get(Number(id));
    if(!actual||normalized(actual).includes(normalized(quoted)))return full;
    const literal=nearestLiteralSource(quoted,actual);
    if(!literal)return full;
    const opening=full[0];
    const closing=opening==='«'?'»':opening==='“'?'”':'"';
    const start=full.indexOf(closing,1);
    if(start<0)return full;
    return opening+literal+closing+full.slice(start+closing.length);
  });
}


// Fix common model formatting mistakes such as "[, #1028]" without ever
// inventing a new message ID. The normal citation validator runs afterwards.
export function normalizeSourceMarkers(body) {
  return String(body??'').replace(/\[\s*[,;]?\s*#\s*(\d+)\s*\]/g, '[#$1]');
}

const SPEECH_VERBS='(?:написал[а]?|сказал[а]?|спросил[а]?|ответил[а]?|поинтересовал[а]сь|заявил[а]?|уверял[а]?|напомнил[а]?|заметил[а]?|признал[а]?|объяснил[а]?|подметил[а]?|отметил[а]?|утверждал[а]?)';

// A very narrow safe fix: the subject directly adjacent to "[#ID] said"
// must be that ID's author, never a different group participant.
// Statements ABOUT someone, without speech verbs, are not modified.
export function correctDirectSpeechAttribution(body, sourceRows) {
  const authors=new Map(sourceRows.map(r=>[Number(r.message_id),String(r.display_name||'').split(/\s+/)[0]]));
  const known=new Set([...authors.values()].map(x=>x.toLocaleLowerCase('ru-RU')));
  const pattern=new RegExp('(?<![\\p{L}])([А-ЯЁ][а-яё]{2,20})(\\s*\\[#(\\d+)\\]\\s*'+SPEECH_VERBS+')','gu');
  return String(body??'').replace(pattern,(full,candidate,tail,id)=>{
    const actual=authors.get(Number(id));
    if(!actual||!known.has(candidate.toLocaleLowerCase('ru-RU')))return full;
    if(actual.toLocaleLowerCase('ru-RU')===candidate.toLocaleLowerCase('ru-RU'))return full;
    return actual+tail;
  });
}
