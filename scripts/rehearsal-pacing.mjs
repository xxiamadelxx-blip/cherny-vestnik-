// CI rehearsal pacing, separate from production Worker scheduling.
// Every loop preserves the in-memory DB and already analyzed message chunks.
export function rehearsalDelayMs(outcome,budget,now=Date.now(),maxPauseMs=8*60_000) {
  if(outcome==='processing')return 31_000;
  if(outcome!=='waiting')return 0;
  const retryAt=Number(budget?.next_attempt_at||0);
  const delay=Math.max(1100,Math.ceil(retryAt-now+1200));
  if(delay>maxPauseMs)
    throw new Error('Groq free quota deferred until '+new Date(retryAt).toISOString()+'; do not classify this CI rehearsal as an AI failure');
  return delay;
}
