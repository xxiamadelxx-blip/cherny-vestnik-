import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {verifyEditorialEvidence,verifyPublishedDigest,citedMessageIds,EvidenceValidationError,canonicalDigestDate,correctNearbyNameTypos} from '../src/evidence.js';

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
