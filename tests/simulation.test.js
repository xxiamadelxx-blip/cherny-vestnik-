import test from 'node:test';
import assert from 'node:assert/strict';
import {generate300} from '../scripts/simulate-300.mjs';
import {selectTranscript} from '../src/core.js';
test('300 synthetic messages have unique ids, 8 users and 6 distinct topics',()=>{
 const messages=generate300();
 assert.equal(messages.length,300);
 assert.equal(new Set(messages.map(x=>x.id)).size,300);
 assert.equal(new Set(messages.map(x=>x.user_id)).size,8);
 assert.equal(new Set(messages.map(x=>x.scene)).size,6);
 assert.deepEqual(generate300(),messages);
 assert.ok(messages.some(x=>x.body.includes('КОТЫ ЗАХВАТИЛИ РЕДАКЦИЮ')));
 assert.equal(selectTranscript(messages.map(x=>({...x,message_id:x.id}))).sampled,85);
});