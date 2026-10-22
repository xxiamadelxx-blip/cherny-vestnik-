import test from 'node:test';
import assert from 'node:assert/strict';
import {dropUnverifiableQuoteSentences,verifyEditorialEvidence} from '../src/evidence.js';

const sources=[
 {message_id:1004,display_name:'Игорь',body:'Я уже почти вышел, через пять минут у метро.'},
 {message_id:1005,display_name:'Лиза',body:'Игорь, ты писал это полчаса назад.'},
 {message_id:1006,display_name:'Игорь',body:'Ключи искал, они были в кармане.'}
];

test('actual Groq quote mismatch is removed without losing adjacent facts',()=>{
 const draft='Игорь обещал через пять минут [#1004]. Полчаса спустя он всё ещё «вышел» [#1005]. Ключи оказались в кармане [#1006].';
 assert.throws(()=>verifyEditorialEvidence(draft,sources),/verbatim quote/);
 const cleaned=dropUnverifiableQuoteSentences(draft,sources);
 assert.doesNotMatch(cleaned,/всё ещё|«вышел»/);
 assert.match(cleaned,/обещал через пять минут/);
 assert.match(cleaned,/Ключи оказались в кармане/);
 assert.doesNotThrow(()=>verifyEditorialEvidence(cleaned,sources));
});

test('a truly verbatim quotation remains untouched',()=>{
 const draft='Лиза напомнила: «Игорь, ты писал это полчаса назад» [#1005].';
 assert.equal(dropUnverifiableQuoteSentences(draft,sources),draft);
 assert.doesNotThrow(()=>verifyEditorialEvidence(draft,sources));
});

test('an unsupported quote with the citation before it is excluded',()=>{
 const draft='[#1004] «уже на месте» написал редактор. Ключи оказались в кармане [#1006].';
 const cleaned=dropUnverifiableQuoteSentences(draft,sources);
 assert.doesNotMatch(cleaned,/уже на месте/);
 assert.match(cleaned,/Ключи оказались в кармане/);
});

test('when a false quotation is the only source it stays rejected',()=>{
 const draft='Неверное утверждение: «давно пришёл» [#1004].';
 assert.equal(dropUnverifiableQuoteSentences(draft,sources),draft);
 assert.throws(()=>verifyEditorialEvidence(draft,sources));
});
