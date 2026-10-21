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

test('editor forbids turning third-party sarcasm into proven financial facts or changing people names',()=>{
 const prompt=systemPrompt();
 assert.match(prompt,/Шутка или догадка/);
 assert.match(prompt,/НЕ является доказанным фактом/);
 assert.match(prompt,/кредит|долг/);
 assert.match(prompt,/имена копируй БУКВА В БУКВУ/);
 assert.match(prompt,/Сатира может быть злее факта/);
});
