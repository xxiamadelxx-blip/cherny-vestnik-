import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rehearsalDelayMs} from '../scripts/rehearsal-pacing.mjs';

test('CI pacing resumes processing and pauses exactly until Groq Retry-After cooldown',()=>{
  const now=Date.UTC(2026,9,22,10);
  assert.equal(rehearsalDelayMs('processing',null,now),31000);
  assert.equal(rehearsalDelayMs('waiting',{next_attempt_at:now+50000},now),51200);
  assert.equal(rehearsalDelayMs('waiting',{next_attempt_at:now-1000},now),1100);
  assert.equal(rehearsalDelayMs('sent',null,now),0);
});
test('CI rehearsal distinguishes daily quota postponement from failed Groq generation',()=>{
  const now=Date.UTC(2026,9,22,10);
  assert.throws(()=>rehearsalDelayMs('waiting',{next_attempt_at:now+8*3600000},now),
    /free quota deferred/);
  assert.ok(rehearsalDelayMs('waiting',{next_attempt_at:now+5000},now)<=120000);
});
