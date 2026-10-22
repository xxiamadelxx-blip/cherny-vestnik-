import test from 'node:test';
import assert from 'node:assert/strict';
import {dropUnverifiableQuoteSentences} from '../src/evidence.js';
test('rejects an unsupported direct quotation without dropping a verified neighboring story',()=>{
 const sources=[{message_id:11,body:'The train is late.'},{message_id:12,body:'I will be there soon.'}];
 const draft='The train is late [#11]. Reporter wrote «arrived» [#12].';
 const result=dropUnverifiableQuoteSentences(draft,sources);
 assert.match(result,/train is late/);
 assert.doesNotMatch(result,/arrived/);
});
