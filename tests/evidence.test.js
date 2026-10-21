import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {verifyEditorialEvidence,verifyPublishedDigest,citedMessageIds,EvidenceValidationError,canonicalDigestDate,correctNearbyNameTypos,correctNearMissQuotes,normalizeSourceMarkers,correctDirectSpeechAttribution,verifyNoFabricatedScenes} from '../src/evidence.js';

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
