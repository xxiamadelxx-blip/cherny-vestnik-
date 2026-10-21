import test from 'node:test';
import assert from 'node:assert/strict';
import {systemPrompt} from '../src/ai.js';

test('editor contract demands spicy factual jabs, not sentimental endings',()=>{
 const text=systemPrompt();
 assert.match(text,/мат|подъёб/i);
 assert.match(text,/я вас люблю/);
 assert.match(text,/ссылк|источник/);
 assert.match(text,/не (должны быть придуманы|приписывать)/);
});