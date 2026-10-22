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

const ANY_LITERAL_QUOTE=/[«“"]([^»”"\n]{3,350})[»”"]/gu;
function precedingCitation(text,index){
  const prefix=String(text).slice(Math.max(0,index-160),index);
  const end=Math.max(prefix.lastIndexOf('\n'),prefix.lastIndexOf('.'),prefix.lastIndexOf('!'),prefix.lastIndexOf('?'));
  const citations=[...prefix.slice(end+1).matchAll(/\[#(\d+)\]/g)];
  return citations.length?Number(citations.at(-1)[1]):null;
}
function followingCitation(text,index){
  const tail=String(text).slice(index,index+24);
  const match=tail.match(/^\s*[,.!?;:]?\s*\[#(\d+)\]/u);
  return match?Number(match[1]):null;
}


export function citedMessageIds(body) {
  return [...new Set([...String(body).matchAll(POINTER)].map(m=>Number(m[1])))];
}
function normalized(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase('ru-RU');
}

// Conservative semantic floor: reject asserted extra characters or serious
// events that were not mentioned by ANY of the cited originals. Metaphors
// ("как сантехник") remain allowed; this is not full semantic verification.
const EXTERNAL_ACTORS=[
  /сантехник/u,/охранник/u,/барист/u,/кассир/u,/курьер/u,/полицейск/u,
  /электрик/u,/пожарн/u,/таксист/u,/слесар/u,/врач(?:а|и|ом|у|ей)?/u
];
const ACTOR_ACTION=/(?:бь[её]т|бил|ударил|прибежал|приш[её]л|уволил|позвонил|потребовал|разбил|слил|вызвал|заплатил|орал|кричал|отобрал|вытащил|украл|встретил|отправил|набросился)/iu;
const SERIOUS_UNSOURCED=[
  {term:/(?<![\p{L}])пропил(?![\p{L}])/iu,source:/пропил|алкогол|выпил|пья|водк|пив[а-яё]*/iu,reason:'invented drinking allegation'},
  {term:/стиральн[а-яё]*\s+машин[а-яё]*/iu,source:/стиральн[а-яё]*/iu,reason:'invented washing-machine incident'},
  {term:/(?<![\p{L}])арестовал[а-яё]*(?![\p{L}])/iu,source:/арест|задержал|полиц/u,reason:'invented arrest'}
];
export function verifyNoFabricatedScenes(body,sourceRows){
  const source=sourceRows.map(r=>String(r.body||'')).join('\n').toLocaleLowerCase('ru-RU');
  const output=String(body||'').toLocaleLowerCase('ru-RU');
  // Explicit first-hand factual events, not harmless humorous comparisons.
  for(const condition of SERIOUS_UNSOURCED) {
    if(condition.term.test(output)&&!condition.source.test(source))
      throw new EvidenceValidationError(condition.reason);
  }
  for(const piece of output.split(/[.!?\n]+/u)) {
    if(!ACTOR_ACTION.test(piece))continue;
    if(/(?:как|словно|будто|представь|вообрази)\s+[^.!?\n]{0,25}$/u.test(piece))continue;
    for(const role of EXTERNAL_ACTORS){
      if(!role.test(piece)||role.test(source))continue;
      // "Как сантехник..." is clearly a comparison, not a real bystander.
      const matched=piece.match(role);
      const prior=piece.slice(Math.max(0,matched.index-26),matched.index);
      if(/(?:как|словно|будто|словно бы)\s*$/u.test(prior))continue;
      throw new EvidenceValidationError('unsourced third-party actor with factual action');
    }
  }
  return true;
}


// A quote may be verbatim yet still be falsely attributed to another person.
// Match an explicit "Person said ...: «literal» [#ID]" construction. Constrain
// the span to exclude other proper names, to avoid guessing narrators.
const NARRATED_SPEECH=/(?<![\p{L}])([А-ЯЁ][\p{L}]{2,20})\s+(?:(?:сухо|торжественно|вслух|потом|снова|тут\s+же)\s+){0,2}(?:подытожил[а]?|резюмировал[а]?|сказал[а]?|написал[а]?|заявил[а]?|выдал[а]?|спросил[а]?|ответил[а]?|воскликнул[а]?|гаркнул[а]?|напомнил[а]?|признал[а]?|заметил[а]?|поинтересовал[а]сь|отметил[а]?|уточнил[а]?)\s*[^А-ЯЁ.!?\n«»“"]{0,75}[«“"]([^»”"\n]{3,350})[»”"]\s*[,.!?;:]?\s*\[#(\d+)\]/gu;
const LETTER_LOOKALIKE={a:'а',e:'е',o:'о',p:'р',c:'с',x:'х',y:'у',k:'к',m:'м',h:'н',b:'в',t:'т'};
function normalizedPerson(value) {
  const token=String(value??'').split(/\s+/)[0];
  const normalizedMixed=/[а-яё]/iu.test(token)?token.replace(/[aeopcxykmhbt]/g,c=>LETTER_LOOKALIKE[c]||c):token;
  return normalizedMixed.toLocaleLowerCase('ru-RU');
}
export function verifyNarratedQuoteAttribution(body,sourceRows) {
  const speakers=new Map(sourceRows.map(row=>[Number(row.message_id),normalizedPerson(row.display_name)]));
  const known=new Set(speakers.values());
  let checked=0;
  for(const match of String(body??'').matchAll(NARRATED_SPEECH)) {
    const author=speakers.get(Number(match[3]));
    const named=normalizedPerson(match[1]);
    if(!author||!known.has(named))continue;
    checked++;
    if(author!==named)
      throw new EvidenceValidationError('verbatim quote falsely attributed to another chat participant');
  }
  return checked;
}

// Match an explicit named speaker immediately before a verbatim quote.
// JS \b treats Cyrillic letters as non-word characters; use Unicode \p{L}.
const QUOTE_SPEAKER_PREFIX=/(?<![\p{L}])([\p{Lu}][\p{Ll}]{2,22})\s+(?:сказал[а]?|ответил[а]?|заявил[а]?|пояснил[а]?|напомнил[а]?|спросил[а]?|добавил[а]?|признал[а]?|подытожил[а]?|воскликнул[а]?|выдал[а]?|пошутил[а]?|рыкнул[а]?|отметил[а]?|подчеркнул[а]?|заметил[а]?|сообщил[а]?|процитировал[а]?)(?:[^.!?«»\n]{0,100})[:：]?\s*$/u;
const QUOTE_LABEL_PREFIX=/(?<![\p{L}])([\p{Lu}][\p{Ll}]{2,22})\s*:\s*$/u;
function speakerKey(raw) {
  const input=String(raw||'').normalize('NFKC').toLocaleLowerCase('ru-RU');
  // Catch a copied Cyrillic name with one Latin homoglyph, e.g. "Мартa".
  if(!/[а-яё]/iu.test(input))return input;
  const latin={a:'а',e:'е',o:'о',p:'р',c:'с',x:'х',y:'у',k:'к',m:'м',t:'т',h:'н',b:'в'};
  return input.replace(/[aeopcyxkmt hb]/g,char=>latin[char]||char);
}
function verifyQuotedSpeaker(text,match,sourceRows) {
  const cited=sourceRows.find(row=>Number(row.message_id)===Number(match[2]));
  if(!cited)return;
  const actual=speakerKey(String(cited.display_name||'').split(/\s+/)[0]);
  const speakers=new Set(sourceRows.map(row=>speakerKey(String(row.display_name||'').split(/\s+/)[0])));
  const prefix=text.slice(Math.max(0,match.index-150),match.index).split(/[.!?\n]/u).at(-1);
  const named=prefix.match(QUOTE_SPEAKER_PREFIX)||prefix.match(QUOTE_LABEL_PREFIX);
  if(!named)return;
  const asserted=speakerKey(named[1]);
  if(speakers.has(asserted)&&asserted!==actual)
    throw new EvidenceValidationError('verbatim quote falsely attributed to the wrong Telegram speaker');
}

// A sarcastic bystander's "bought it on credit" is not first-hand proof.
// Block categorical statements about someone's loan unless that participant
// confirms credit/instalments themselves in a cited message. Reported jokes
// explicitly introduced as another speaker's opinion remain permissible.
export function verifyUnprovenLoanClaims(body,sourceRows) {
  const stripped=String(body||'').replace(/[«“"][^»”"\n]{0,800}[»”"]/gu,' ');
  const firstHand=sourceRows.filter(row=>{
    const raw=String(row.body||'');
    return /(?:в\s+кредит|кредит[ауеом]?|рассрочк[ауие])/iu.test(raw) &&
      /(?<![\p{L}])я(?![\p{L}])|(?:купил|купила|взял|взяла|оформил|оформила)/iu.test(raw);
  });
  for(const sentence of stripped.split(/[.!?\n]+/u)) {
    // Loan-as-metaphor still asserts an unproven financial obligation when it
    // names a specific member. A third party's joke is NOT an admission.
    const loanMetaphor=/кредитн[а-яё]*\s+(?:рабств|петл|ярм|каторг|оков)/iu.test(sentence);
    if(loanMetaphor && !/(?:по\s+словам|якобы|пошутил|в\s+шутку)/iu.test(sentence)) {
      const directAdmission=sourceRows.some(row=>
        /(?:в\s+кредит|кредит[ауеом]?|рассрочк)/iu.test(String(row.body||'')) &&
        /(?<![\p{L}])я(?![\p{L}])/iu.test(String(row.body||'')));
      if(!directAdmission)throw new EvidenceValidationError('unsupported categorical credit claim from third-party joke');
    }
    if(!/(?:купил[аи]?|взял[аи]?|оформил[аи]?|приобр[её]л[аи]?|покупал[аи]?)[^.!?\n]{0,85}(?:в\s+кредит|в\s+рассрочку|кредит(?![\p{L}]))/iu.test(sentence))
      continue;
    if(/(?:по\s+словам|якобы|по\s+мнению|пошутил[аи]?|шутит|предположил[аи]?|в\s+шутку)/iu.test(sentence))
      continue;
    const named=sentence.match(/(?<![\p{L}])([\p{Lu}][\p{Ll}]{2,22})\s+(?:[^.!?\n]{0,40})?(?:купил[аи]?|взял[аи]?|оформил[аи]?|приобр[её]л[аи]?|покупал[аи]?)/u);
    const credible=firstHand.some(row=>!named || speakerKey(row.display_name)===speakerKey(named[1]));
    if(!credible)throw new EvidenceValidationError('unsupported categorical credit claim from third-party joke');
  }
  return true;
}

// Remove a demonstrably unsupported financial allegation from the completed
// draft, rather than asking Groq to fabricate a new justification. Only the
// offending sentence is dropped, all other source-cited stories remain intact.
// The complete digest is validated again after this conservative operation.
export function dropUnverifiedLoanSentences(body,sourceRows) {
  const raw=String(body??'');
  const filtered=raw.replace(/[^.!?\n]+[.!?]?/gu,part=>{
    try {verifyUnprovenLoanClaims(part,sourceRows);return part;}
    catch(error) {
      if(error instanceof EvidenceValidationError &&
        /unsupported categorical credit claim/.test(error.message))return '';
      throw error;
    }
  });
  // If deletion removes ALL source anchors, never publish an empty masthead.
  // Keep the original rejected text for the existing fact-checked AI rewrite.
  return filtered!==raw && !citedMessageIds(filtered).length ? raw:filtered;
}

// The model sometimes marks an ironic single word as a verbatim quote and
// puts the neighboring message ID next to it. If the actual cited source
// cannot support that quotation, remove only the offending sentence.
// Do not change speaker IDs or conjure substitute text. Preserve enough
// remaining source references for the full verifier to check.
export function dropUnverifiableQuoteSentences(body,sourceRows) {
  const raw=String(body??'');
  const entries=new Map(sourceRows.map(r=>[Number(r.message_id),String(r.body||'')]));
  const segments=raw.split(/(?<=[.!?])(?=\s+[А-ЯЁ])/u);
  const result=segments.map(segment=>{
    for(const match of segment.matchAll(QUOTED_SOURCE)) {
      const actual=entries.get(Number(match[2]));
      if(actual && !normalized(actual).includes(normalized(match[1])))return '';
    }
    for(const match of segment.matchAll(ANY_LITERAL_QUOTE)) {
      if(followingCitation(segment,match.index+match[0].length)!==null)continue;
      const id=precedingCitation(segment,match.index);
      if(id===null)continue;
      const actual=entries.get(id);
      if(actual && !normalized(actual).includes(normalized(match[1])))return '';
    }
    return segment;
  }).join('');
  // An empty skeleton must go through the existing AI repair, not to Telegram.
  return result!==raw && !citedMessageIds(result).length?raw:result;
}

export function verifyEditorialEvidence(body, sourceRows) {
  const text=String(body??'');
  const entries=new Map(sourceRows.map(row=>[Number(row.message_id),row]));
  const refs=citedMessageIds(text);
  if(text.includes('[без подтверждения]'))throw new EvidenceValidationError('unverified citation placeholder');
  if(/\[#\d+\s*[-–—]\s*\d+\]/u.test(text))
    throw new EvidenceValidationError('unverified source ID range');
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
    verifyQuotedSpeaker(text,match,sourceRows);
  }
  // Check quotes whose source ID appears before, as well as after.
  for(const quote of text.matchAll(ANY_LITERAL_QUOTE)){
    if(followingCitation(text,quote.index+quote[0].length)!==null)continue;
    const id=precedingCitation(text,quote.index);
    if(id===null)continue;
    const source=entries.get(id);
    if(!source||!normalized(source.body).includes(normalized(quote[1])))
      throw new EvidenceValidationError('quote following source ID is not verbatim');
    checked++;
  }
  verifyNarratedQuoteAttribution(text,sourceRows);
  verifyNoFabricatedScenes(text,sourceRows);
  verifyUnprovenLoanClaims(text,sourceRows);
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
  if(required.length===1 && words.length<=800) {
    // Single-word morphological near-miss, e.g. quoted nominative vs an
    // inflected word. Require exactly ONE source candidate sharing 4 Unicode
    // letters, a small length difference, and a match within the same ID.
    // This never invents a word: returns the verbatim source token.
    const term=required[0];
    if(term.length<5)return null;
    const candidates=words.filter(x=>
      x.word.length>=5 && Math.abs(x.word.length-term.length)<=2
      && x.word.slice(0,4)===term.slice(0,4));
    return candidates.length===1?source.slice(candidates[0].start,candidates[0].end):null;
  }
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
  const correctedAfter=String(body??'').replace(QUOTED_SOURCE,(full,quoted,id)=>{
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
  return correctedAfter.replace(ANY_LITERAL_QUOTE,(full,quoted,index,text)=>{
    if(followingCitation(text,index+full.length)!==null)return full;
    const id=precedingCitation(text,index);
    if(id===null)return full;
    const actual=source.get(id);
    if(!actual||normalized(actual).includes(normalized(quoted)))return full;
    const literal=nearestLiteralSource(quoted,actual);
    return literal?full[0]+literal+full[full.length-1]:full;
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
