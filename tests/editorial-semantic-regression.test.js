import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyEditorialEvidence,EvidenceValidationError} from '../src/evidence.js';

const messages=[
 {message_id:1025,display_name:'Марта',body:'Мы уже сели в пиццерию напротив метро.'},
 {message_id:1029,display_name:'Игорь',body:'Нашёл пиццерию. Вы уже съели всё, суки?'}
];

test('an unanswered food question is not proof that pizza was eaten',()=>{
 const invented='Пицца уже была съедена, когда Игорь появился [#1029].';
 assert.throws(()=>verifyEditorialEvidence(invented,messages),
   error=>error instanceof EvidenceValidationError&&/unconfirmed consumption/.test(error.message));
});

test('an invented empty restaurant is not licensed by a question about food',()=>{
 const invented='Игорь зашёл в пустой зал [#1029].';
 assert.throws(()=>verifyEditorialEvidence(invented,messages),
   error=>error instanceof EvidenceValidationError&&/unsourced empty venue/.test(error.message));
});

test('the actual question can be quoted accurately without inventing an answer',()=>{
 const truthful='Игорь нашёл пиццерию и спросил: «Вы уже съели всё, суки?» [#1029].';
 assert.doesNotThrow(()=>verifyEditorialEvidence(truthful,messages));
});

test('confirmed food consumption is allowed, not censored by the safeguard',()=>{
 const source=[...messages,{message_id:1031,display_name:'Марта',body:'Да, всю пиццу съели, пока ты шёл.'}];
 assert.doesNotThrow(()=>verifyEditorialEvidence('Пиццу уже съели [#1031].',source));
});


test('reported question about eating in a pizzeria is not asserted consumption',()=>{
 const truthful='Игорь нашёл пиццерию и спросил, уже ли все съели [#1029].';
 assert.doesNotThrow(()=>verifyEditorialEvidence(truthful,messages));
});

test('question explicitly mentioning pizza does not assert it was eaten',()=>{
 const truthful='Игорь спросил, всю ли пиццу уже съели [#1029].';
 assert.doesNotThrow(()=>verifyEditorialEvidence(truthful,messages));
});

test('unquoted categorical answer to a mere question is rejected',()=>{
 assert.throws(()=>verifyEditorialEvidence('Суки, вы снова всё съели [#1029].',messages),
  e=>e instanceof EvidenceValidationError&&/unconfirmed consumption/.test(e.message));
});

test('participant cannot be presented as in debt on a third-party joke',()=>{
 const source=[
  {message_id:1015,display_name:'Саня',body:'Я заказал кофемашину. Это инвестиция в экономию.'},
  {message_id:1030,display_name:'Дима',body:'Саня купил экономию в кредит, ха-ха.'}
 ];
 assert.throws(()=>verifyEditorialEvidence('Саня официально влез в долги ради кофе [#1030].',source),
  e=>e instanceof EvidenceValidationError&&/credit claim/.test(e.message));
 assert.doesNotThrow(()=>verifyEditorialEvidence('По словам Димы, Саня якобы купил экономию в кредит [#1030].',source));
});
