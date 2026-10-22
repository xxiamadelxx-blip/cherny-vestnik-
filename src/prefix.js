// Every saved chunk must cover the exact chronological source prefix.
// A late Telegram event may carry an older timestamp, so OFFSET alone is
// not sufficient without this audit.
export async function reconcileAnalyzedPrefix(db,chatId,day,start,end) {
  const parts=(await db.prepare(`SELECT ids_json,processed FROM digest_chunks
    WHERE chat_id=? AND local_day=? ORDER BY chunk_no`).bind(String(chatId),day).all()).results||[];
  const ids=parts.flatMap(p=>JSON.parse(p.ids_json).map(Number));
  const done=parts.reduce((n,p)=>n+Number(p.processed),0);
  if(!done)return {processed:0,invalidated:false};
  const actual=(await db.prepare(`SELECT message_id FROM messages
    WHERE chat_id=? AND posted_at>=? AND posted_at<?
    ORDER BY posted_at,message_id LIMIT ?`).bind(String(chatId),start,end,done).all()).results||[];
  if(done===ids.length&&actual.length===done&&
    ids.every((id,i)=>id===Number(actual[i].message_id)))
    return {processed:done,invalidated:false};
  await db.prepare('DELETE FROM digest_chunks WHERE chat_id=? AND local_day=?').bind(String(chatId),day).run();
  await db.prepare('DELETE FROM digest_reductions WHERE chat_id=? AND local_day=?').bind(String(chatId),day).run();
  return {processed:0,invalidated:true};
}
