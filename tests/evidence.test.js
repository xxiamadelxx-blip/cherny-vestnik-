import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {verifyEditorialEvidence,verifyPublishedDigest,citedMessageIds,EvidenceValidationError,canonicalDigestDate,correctNearbyNameTypos,correctNearMissQuotes,normalizeSourceMarkers,correctDirectSpeechAttribution,verifyNoFabricatedScenes,verifyNarratedQuoteAttribution} from '../src/evidence.js';

const rows=[
  {message_id:101,display_name:'Саня',body:'Я не буду включать автоприцел. Не надо мне этой помощи!'},
  {message_id:102,display_name:'Марта',body:'Саня, вчера ты говорил: я не буду включать автоприцел.'},
  {message_id:103,display_name:'Саня',body:'Ладно, включил автоприцел. Только не ржите.'},
  {message_id:104,display_name:'Дима',body:'Пошли за пиццей, блядь.'}
];
test('valid verbatim source quote and ID survive without changing spicy prose',()=>{
 const body='💀 Срач дня: Саня сменил настройку. Сначала «Я не буду включать автоприцел.» [#101], затем «Ладно, включил автоприцел.» [#103]. Блядь, мастер стабильности.';
 assert.deepEqual(citedMessageIds(body),[101,103]);
 assert.deepEqual(verifyEditorialEvidence(body,rows),{cited:2,quotesChecked:2});
});
test('attributed quotation cited to a different participant is rejected',()=>{
 assert.throws(()=>verifyEditorialEvidence('Марта ответила «Ладно, включил автоприцел.» [#102]. Ёбаный позор.',rows),
  err=>err instanceof EvidenceValidationError&&/quote/.test(err.message));
});
test('fabricated quote despite existing real citation is rejected',()=>{
 assert.throws(()=>verifyEditorialEvidence('Саня: «Я опоздал на десять часов» [#101].',rows),EvidenceValidationError);
});
test('unknown ID and placeholders cannot masquerade as corroboration',()=>{
 assert.throws(()=>verifyEditorialEvidence('Игорь внезапно влез в спор [#999].',rows),EvidenceValidationError);
 assert.throws(()=>verifyEditorialEvidence('Игорь внезапно влез в спор [без подтверждения].',rows),EvidenceValidationError);
});
test('quotes without source marker are not misrepresented as independently verified',()=>{
 assert.deepEqual(verifyEditorialEvidence('💀 Заголовок «Новый поход за пиццей» не был прямой цитатой.',rows),
   {cited:0,quotesChecked:0});
});
test('SQL audit only reads cited rows from the proper Telegram chat',async()=>{
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('CREATE TABLE messages(chat_id TEXT,message_id INTEGER,body TEXT,display_name TEXT)');
 for(const [chat,row] of [['-100demo',rows[0]],['-100demo',rows[2]],['-100other',{...rows[1],message_id:102}]])
   sqlite.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(chat,row.message_id,row.body,row.display_name);
 let selects=0;
 const db={prepare(sql){selects++;const stmt=sqlite.prepare(sql);return {bind(...args){return {all:async()=>({results:stmt.all(...args)})};}}}};
 const passed=await verifyPublishedDigest({db,chatId:'-100demo',body:'Саня признался: «Ладно, включил автоприцел.» [#103]'});
 assert.equal(passed.quotesChecked,1);
 assert.equal(selects,1);
 await assert.rejects(verifyPublishedDigest({db,chatId:'-100demo',body:'Марта сказала «Саня, вчера ты говорил» [#102]'}),EvidenceValidationError);
});
test('whitespace and case changes allowed, but missing source words not',()=>{
 assert.equal(verifyEditorialEvidence('«ладно,   ВКЛЮЧИЛ автоприцел.» [#103]',rows).quotesChecked,1);
 assert.throws(()=>verifyEditorialEvidence('«Ладно включил автоприцел.» [#103]',rows),EvidenceValidationError);
});


test('release header date is taken from authoritative D1 day, never guessed by AI',()=>{
 const source='💀 ЧЁРНЫЙ ВЕСТНИК | 20.10.2026\n\nСаня купил кофе.';
 assert.ok(canonicalDigestDate(source,'2026-10-21').startsWith('💀 ЧЁРНЫЙ ВЕСТНИК | 21.10.2026'));
 assert.ok(canonicalDigestDate('💀 ЧЁРНЫЙ ВЕСТНИК | 2026-10-20\nbody','2026-10-21').includes('21.10.2026'));
 assert.match(canonicalDigestDate('🔥 Новости дня','2026-10-21'),/^💀 ЧЁРНЫЙ ВЕСТНИК \| 21\.10\.2026/);
});
test('quoted speaker name with dropped interior letter is corrected by cited source',()=>{
 const input='Мара записала ответ «Саня, вчера ты говорил: я не буду включать автоприцел.» [#102].';
 const fixed=correctNearbyNameTypos(input,rows);
 assert.match(fixed,/Марта записала/);
 assert.match(fixed,/«Саня, вчера ты говорил: я не буду включать автоприцел.» \[#102\]/);
 assert.equal(verifyEditorialEvidence(fixed,rows).quotesChecked,1);
});
test('name correction never changes a quote or distant unrelated person',()=>{
 const rows2=[{message_id:7,display_name:'Марта',body:'Она сказала Мара.'}];
 const input='Из слова «Мара» [#7] нельзя автоматически делать имя другого участника.';
 assert.equal(correctNearbyNameTypos(input,rows2),input);
});


test('slightly distorted quote is replaced with a real contiguous excerpt at zero model cost',()=>{
 const current=[{message_id:8,body:'Я ещё не считал, не рушьте мне мечту.',display_name:'Саня'}];
 const inaccurate='Саня попросил «не рушить мечту» [#8], а сам даже не считал.';
 assert.throws(()=>verifyEditorialEvidence(inaccurate,current),EvidenceValidationError);
 const fixed=correctNearMissQuotes(inaccurate,current);
 assert.match(fixed,/«не рушьте мне мечту» \[#8\]/);
 assert.equal(verifyEditorialEvidence(fixed,current).quotesChecked,1);
});
test('reordered but source-supported quote becomes exact raw phrase',()=>{
 const current=[{message_id:9,body:'Ключи искал, они были в кармане, блядь.',display_name:'Игорь'}];
 const wrong='Игорь рассказал: «искал ключи в кармане, блядь» [#9].';
 const fixed=correctNearMissQuotes(wrong,current);
 assert.match(fixed,/«Ключи искал, они были в кармане, блядь» \[#9\]/);
 assert.equal(verifyEditorialEvidence(fixed,current).quotesChecked,1);
});
test('invented serious allegation cannot be laundered by fuzzy source quote repair',()=>{
 const wrong='Саня признал «Я ограбил банк» [#101].';
 const fixed=correctNearMissQuotes(wrong,rows);
 assert.equal(fixed,wrong);
 assert.throws(()=>verifyEditorialEvidence(fixed,rows),EvidenceValidationError);
});


test('malformed citation markers are normalized before strict source validation',()=>{
 const source=[{message_id:1028,display_name:'Саня',body:'Я ещё не считал, не рушьте мне мечту.'}];
 const malformed='Саня [, #1028] ответил, что не считал расходы.';
 assert.throws(()=>verifyEditorialEvidence(malformed,source),EvidenceValidationError);
 const normalized=normalizeSourceMarkers(malformed);
 assert.equal(normalized,'Саня [#1028] ответил, что не считал расходы.');
 assert.deepEqual(verifyEditorialEvidence(normalized,source),{cited:1,quotesChecked:0});
 assert.equal(normalizeSourceMarkers('«Да» [# 1028]'), '«Да» [#1028]');
});

test('direct speech attribution uses the actual Telegram speaker, not another group member',()=>{
 const data=[
  {message_id:1008,display_name:'Марта',body:'По чайнику? Ты серьёзно, нахуй?'},
  {message_id:1011,display_name:'Лиза',body:'Паша, ты вчера стрелял в стену десять минут.'},
  {message_id:1010,display_name:'Паша',body:'Мне автоприцел не нужен.'}
 ];
 const wrong='Лиза [#1008] поинтересовалась, серьёзно ли он. Паша [#1011] в это время играл.';
 const fixed=correctDirectSpeechAttribution(wrong,data);
 assert.match(fixed,/Марта \[#1008\] поинтересовалась/);
 assert.match(fixed,/Паша \[#1011\] в это время играл/);
 assert.doesNotThrow(()=>verifyEditorialEvidence(fixed,data));
});
test('foreign script absent from any cited source is rejected rather than silently published',()=>{
 const data=[{message_id:1029,display_name:'Игорь',body:'Вы уже съели всё, суки?'}];
 assert.throws(()=>verifyEditorialEvidence('Игорь и怒吼нул: «Вы уже съели всё, суки?» [#1029]',data),
   err=>err instanceof EvidenceValidationError && /foreign script/.test(err.message));
 assert.deepEqual(verifyEditorialEvidence('Игорь сказал: «Вы уже съели всё, суки?» [#1029]',data),
   {cited:1,quotesChecked:1});
 const chinese=[{message_id:7,display_name:'Ли',body:'Я написал 怒吼 специально.'}];
 assert.doesNotThrow(()=>verifyEditorialEvidence('В сообщении было 怒吼 [#7]',chinese));
});


test('newly invented plumber and washing-machine episode is rejected even with valid nearby citations',()=>{
  const data=[
    {message_id:1015,display_name:'Саня',body:'Я заказал кофемашину. Это инвестиция.'},
    {message_id:1026,display_name:'Саня',body:'Она экономит по 50 рублей в день.'}
  ];
  const inaccurate='Саня купил машину [#1015]. А пока сантехник уже бьёт по столу: ты слил кофе в стиральную машину [#1026].';
  assert.throws(()=>verifyEditorialEvidence(inaccurate,data),
    e=>e instanceof EvidenceValidationError&&/washing-machine|unsourced/.test(e.message));
});
test('unsourced literal third party with physical actions is rejected, but marked comparisons remain acceptable',()=>{
  const data=[{message_id:5,display_name:'Игорь',body:'Ключи всё время были в кармане.'}];
  assert.throws(()=>verifyNoFabricatedScenes('Охранник прибежал и ударил Игоря [#5].',data),EvidenceValidationError);
  assert.doesNotThrow(()=>verifyNoFabricatedScenes('Игорь ищет ключи, как сантехник без инструментов.',data));
  assert.doesNotThrow(()=>verifyNoFabricatedScenes('Игорь и сантехник обсуждали ключи [#5].',
    [{message_id:5,body:'Я и сантехник обсуждали ключи.',display_name:'Игорь'}]));
});
test('invented drinking or arrest allegation cannot be laundered with an unrelated valid ID',()=>{
  const data=[{message_id:6,display_name:'Саня',body:'Я сэкономил 50 рублей.'}];
  assert.throws(()=>verifyEditorialEvidence('Саня пропил все деньги [#6].',data),EvidenceValidationError);
  assert.throws(()=>verifyEditorialEvidence('Саню арестовали [#6].',data),EvidenceValidationError);
});


test('direct attribution guard rejects Groq quote copied from Dima but labelled Marta with Latin lookalike',()=>{
  const input=[{message_id:1030,display_name:'Дима',body:'День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит.'},
    {message_id:1020,display_name:'Марта',body:'Уже второй комплект пяти минут, у тебя время продаётся по подписке?'}];
  const wrong='Мартa подытожила всё это величие: «День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит» [#1030].';
  assert.throws(()=>verifyEditorialEvidence(wrong,input),error=>error instanceof EvidenceValidationError&&/falsely attributed/.test(error.message));
  const corrected='Дима подытожил всё это величие: «День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит» [#1030].';
  assert.equal(verifyNarratedQuoteAttribution(corrected,input),1);
  assert.equal(verifyEditorialEvidence(corrected,input).quotesChecked,1);
});
test('narrated quote checking does not confuse the subject of someone else’s words with the speaker',()=>{
  const input=[{message_id:8,display_name:'Марта',body:'Саня опять купил кофемашину.'},
    {message_id:9,display_name:'Дима',body:'Саня купил кофемашину.'}];
  const allowed='Марта [#8] напомнила, что Саня снова покупает кофемашину. Дима сказал: «Саня купил кофемашину» [#9].';
  assert.doesNotThrow(()=>verifyEditorialEvidence(allowed,input));
});


test('real Groq mixed-alphabet speaker hallucination is rejected',()=>{
  const source=[
    {message_id:1020,display_name:'Марта',body:'Опаздываешь снова?'},
    {message_id:1030,display_name:'Дима',body:'День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит.'}
  ];
  const invented='Мартa подытожила всё это величие: «День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит.» [#1030]';
  assert.throws(()=>verifyEditorialEvidence(invented,source),err=>err instanceof EvidenceValidationError && /wrong Telegram speaker/.test(err.message));
  const accurate='Дима подытожил день: «День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит.» [#1030]';
  assert.doesNotThrow(()=>verifyEditorialEvidence(accurate,source));
});
test('explicit wrong speaker by name and source ID is rejected even for exact quote',()=>{
 const sample=[
  {message_id:41,display_name:'Саня',body:'Я купил кофе.'},
  {message_id:42,display_name:'Марта',body:'Я отказалась от кофе.'}
 ];
 assert.throws(()=>verifyEditorialEvidence('Саня ответил: «Я отказалась от кофе.» [#42]',sample),
  EvidenceValidationError);
 assert.doesNotThrow(()=>verifyEditorialEvidence('Марта ответила: «Я отказалась от кофе.» [#42]',sample));
});


test('Groq source ID before quote is checked; inflected phrase is repaired from exact Telegram message',()=>{
  const originals=[{message_id:1001,display_name:'Саня',body:'Ребят, кофемашину за сорок тысяч не куплю. Бессмысленная трата.'}];
  const draft='Саня в [#1001] заявил, что это «бессмысленной тратой».';
  assert.throws(()=>verifyEditorialEvidence(draft,originals),
    err=>err instanceof EvidenceValidationError&&/source ID/.test(err.message));
  const repaired=correctNearMissQuotes(draft,originals);
  assert.match(repaired,/«Бессмысленная трата»/);
  assert.equal(verifyEditorialEvidence(repaired,originals).quotesChecked,1);
});
test('a real quote after its citation counts as checked, but editorial headline quotes do not',()=>{
  const original=[{message_id:1009,display_name:'Дима',body:'Да, сказал, что дождь через час. ИИ редко ошибается.'}];
  const newspaper='Номинация «Чайник-метеоролог»: Дима в [#1009] утверждал «дождь через час».';
  assert.equal(verifyEditorialEvidence(newspaper,original).quotesChecked,1);
  assert.deepEqual(verifyEditorialEvidence('«Чайник-метеоролог» вообще звучит смешно.',original),{cited:0,quotesChecked:0});
});

test('rumor about a loan is not proof of another participant borrowing',()=>{
 const source=[
  {message_id:501,display_name:'Саня',body:'Заказал кофемашину. Это инвестиция в экономию.'},
  {message_id:502,display_name:'Дима',body:'Саня купил экономию в кредит, ха-ха!'}
 ];
 assert.throws(()=>verifyEditorialEvidence('Саня купил экономию в кредит [#502].',source),
  err=>err instanceof EvidenceValidationError&&/credit claim/.test(err.message));
 assert.doesNotThrow(()=>verifyEditorialEvidence('По словам Димы, Саня якобы купил экономию в кредит [#502].',source));
});
test('first-person acknowledgment supports an attributed credit fact',()=>{
 const source=[
  {message_id:601,display_name:'Саня',body:'Я купил кофемашину в кредит, расплачиваться два года.'}
 ];
 assert.doesNotThrow(()=>verifyEditorialEvidence('Саня купил кофемашину в кредит [#601].',source));
});


test('one inflected word in a cited quote is corrected from the exact source',()=>{
 const originals=[{message_id:1018,display_name:'Дима',body:'Признаю, эксперимент с погодой оказался хуйнёй.'}];
 const generated='Редактор пишет: «хуйня» [#1018].';
 assert.throws(()=>verifyEditorialEvidence(generated,originals),EvidenceValidationError);
 const repaired=correctNearMissQuotes(generated,originals);
 assert.match(repaired,/«хуйнёй» \[#1018\]/);
 assert.equal(verifyEditorialEvidence(repaired,originals).quotesChecked,1);
});

test('ambiguous or unrelated one-word quotes are never guessed or silently accepted',()=>{
 const originals=[
   {message_id:20,display_name:'Игорь',body:'Такая новая книга, а старая книга лежит дома.'},
   {message_id:21,display_name:'Марта',body:'Вчера пробовала горячую пиццу.'}
 ];
 const ambiguous='«книге» [#20]';
 assert.equal(correctNearMissQuotes(ambiguous,originals),ambiguous);
 assert.throws(()=>verifyEditorialEvidence(ambiguous,originals),EvidenceValidationError);
 const fabricated='«пельмени» [#21]';
 assert.equal(correctNearMissQuotes(fabricated,originals),fabricated);
 assert.throws(()=>verifyEditorialEvidence(fabricated,originals),EvidenceValidationError);
});


test('third-party sarcasm cannot become an asserted purchase of credit',()=>{
 const originals=[
  {message_id:701,display_name:'Саня',body:'Заказал кофемашину.'},
  {message_id:702,display_name:'Дима',body:'Саня купил экономию в кредит, ха-ха!'}
 ];
 assert.throws(()=>verifyEditorialEvidence('Саня купил кредит под видом экономии [#702].',originals),
  err=>err instanceof EvidenceValidationError && /credit claim/.test(err.message));
 assert.doesNotThrow(()=>verifyEditorialEvidence('По словам Димы, Саня якобы купил экономию в кредит [#702].',originals));
});
test('numeric reference ranges are rejected, never mistaken for two validated citations',()=>{
 const originals=[
  {message_id:704,display_name:'Игорь',body:'Пять минут'},
  {message_id:705,display_name:'Лиза',body:'Прошло полчаса'}
 ];
 assert.throws(()=>verifyEditorialEvidence('Чат: опоздание [#704-705].',originals),
  err=>err instanceof EvidenceValidationError&&/ID range/.test(err.message));
 assert.doesNotThrow(()=>verifyEditorialEvidence('Игорь писал [#704], Лиза ответила [#705].',originals));
});
