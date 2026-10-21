// One cheap, source-grounded REAL Groq completion. Telegram is mocked;
// no real group is accessed and this script cannot send a real Telegram message.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleUpdate,publishDigest} from '../src/index.js';
import {verifyEditorialEvidence} from '../src/evidence.js';

const CHAT='-10055001234', NOW=Date.UTC(2026,9,21,18,0,0);
const SPEAKERS=[
  {id:31,name:'Саня'},{id:32,name:'Марта'},{id:33,name:'Игорь'},
  {id:34,name:'Лиза'},{id:35,name:'Паша'},{id:36,name:'Дима'}
];
const LINES=[
 [0,'Ребят, кофемашину за сорок тысяч не куплю. Бессмысленная трата.'],
 [1,'Саня, зафиксировали. Очень разумно.'],
 [4,'Я тоже лишних денег не трачу.'],
 [2,'Я уже почти вышел, через пять минут у метро.'],
 [3,'Игорь, ты писал это полчаса назад.'],
 [2,'Ключи искал, они были в кармане, блядь.'],
 [5,'Я спросил нейросеть, пойдёт ли дождь, показал фотографию чайника.'],
 [1,'По чайнику? Ты серьёзно, нахуй?'],
 [5,'Да, сказал, что дождь через час. ИИ редко ошибается.'],
 [4,'С геймпада в шутеры играть легко, мне помощь в прицеливании не нужна.'],
 [3,'Паша, ты вчера стрелял в стену десять минут.'],
 [4,'Я тестировал отдачу, не надо умничать.'],
 [0,'Смотрите, на кофемашину скидка, осталось всего тридцать восемь тысяч.'],
 [1,'Саня, пять минут назад ты сам говорил, что это бессмысленная трата.'],
 [0,'Всё, я заказал. Это инвестиция в экономию, вы нихуя не понимаете.'],
 [5,'Отчёт метеоролога: дождя нет, хотя чайник обещал.'],
 [3,'Дима, твой чайник получил диплом в переходе?'],
 [5,'Признаю, эксперимент с погодой оказался хуйнёй.'],
 [2,'Такси отменил, иду пешком, буду через пять минут.'],
 [1,'Уже второй комплект пяти минут, у тебя время продаётся по подписке?'],
 [4,'Ладно, я включил помощь в прицеливании.'],
 [3,'Паша, проверка отдачи окончательно победила твою гордость?'],
 [4,'Только не ржите, с ней действительно проще.'],
 [2,'Я пришёл! А где вы все?'],
 [1,'Мы уже сели в пиццерию напротив метро.'],
 [0,'Кофемашина за тридцать восемь тысяч обещает экономить 50 рублей в день.'],
 [3,'Саня, окупится через семьсот шестьдесят дней, если не сломается.'],
 [0,'Я ещё не считал, не рушьте мне мечту.'],
 [2,'Нашёл пиццерию. Вы уже съели всё, суки?'],
 [5,'День закрыт: Игорь опоздал, чайник соврал, Паша включил помощь, Саня купил экономию в кредит.']
];
const sqlFiles=['0001_init.sql','0002_exhaustive.sql','0003_groq_budget.sql','0004_digest_reductions.sql'];
function database() {
 const sqlite=new DatabaseSync(':memory:');
 for(const sql of sqlFiles)sqlite.exec(readFileSync(new URL('../migrations/'+sql,import.meta.url),'utf8'));
 const DB={prepare(q){const s=sqlite.prepare(q);return{bind(...params){return{
   first:async()=>s.get(...params)||null,
   all:async()=>({results:s.all(...params)}),
   run:async()=>({meta:{changes:s.run(...params).changes}})
 };}};}};
 return {sqlite,DB};
}
function update(row){return {message:{
  chat:{id:Number(CHAT),type:'supergroup',title:'Вымышленная редакция'},
  message_id:row.message_id,date:Math.floor(row.posted_at/1000),
  from:{id:row.user_id,first_name:row.display_name},text:row.body
}};}
export async function run({key=process.env.GROQ_API_KEY,fetcher=fetch,log=console.log}={}) {
 assert.ok(key?.trim(),'GROQ_API_KEY missing');
 const {sqlite,DB}=database();
 const env={DB,GROQ_API_KEY:key,GROQ_MODEL:'qwen/qwen3.8-27b',
   BOT_TIME_ZONE:'Europe/Moscow',TELEGRAM_BOT_TOKEN:'MOCK-TELEGRAM-NO-DELIVERY'};
 const source=LINES.map(([person,body],index)=>({
   message_id:1001+index,user_id:SPEAKERS[person].id,
   display_name:SPEAKERS[person].name,body,
   posted_at:NOW-60*60*1000+index*100000
 }));
 let aiCalls=0;const sent=[];let lastDraft='';
 const isolated=async(url,options)=>{
   const endpoint=String(url);
   if(endpoint.startsWith('https://api.groq.com/')){
     aiCalls++;
     const response=await fetcher(url,options);
     if(response.ok){
       const copy=await response.clone().json();
       lastDraft=String(copy?.choices?.[0]?.message?.content||'');
     }
     return response;
   }
   if(endpoint.endsWith('/getChatMember')&&endpoint.includes('api.telegram.org'))
     return Response.json({ok:true,result:{status:'creator'}});
   if(endpoint.endsWith('/sendMessage')&&endpoint.includes('api.telegram.org')){
     const payload=JSON.parse(options.body);
     assert.equal(String(payload.chat_id),CHAT);
     sent.push(payload.text);
     return Response.json({ok:true,result:{message_id:sent.length}});
   }
   throw Error('External destination forbidden in editorial test');
 };
 await handleUpdate(update({message_id:1,posted_at:NOW-3_600_000-1000,
   user_id:31,display_name:'Саня',body:'/enable'}),env,isolated,NOW-3_600_000-1000);
 for(const message of source) await handleUpdate(update(message),env,isolated,message.posted_at);
 const ingested=sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
 assert.equal(ingested,30);
 let outcome;
 try {outcome=await publishDigest(env,CHAT,NOW,isolated);}
 catch(error){
   mkdirSync('reports',{recursive:true});
   // Only synthetic fictional messages and the resulting draft, never user chats.
   writeFileSync('reports/editorial-live-failed.md',[
      '# Unaccepted Groq editorial draft (fictional test only)',
      'Reason: '+String(error.message),
      'Groq calls: '+aiCalls,
      '',
      '## Rejected output',
      '~~~text',lastDraft,'~~~',
      '',
      '## Original fictional source messages',
      ...source.map(m=>'[#'+m.message_id+'] '+m.display_name+': '+m.body)
   ].join('\n'));
   throw error;
 }
 const stored=sqlite.prepare('SELECT status,body FROM digests WHERE chat_id=?').get(CHAT);
 assert.equal(outcome,'sent','live Groq did not complete the accepted digest');
 assert.equal(stored.status,'sent');
 const evidence=verifyEditorialEvidence(stored.body,source);
 const total=sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
 assert.equal(total,30);
 assert.equal(aiCalls,1);
 assert.ok(sent.some(text=>text.includes('ЧЁРНЫЙ ВЕСТНИК')));
 const swears=/(бляд|блят|хуй|нахуй|пиздец|ёбан|ебат|долбо)/i.test(stored.body);
 const themes=[/кофемашин|инвестиц/i,/игор|опозд|такси|ключ/i,/паша|прицел|автонавед/i,/дим|чайник|погод/i]
   .filter(re=>re.test(stored.body)).length;
 const check={ingested,aiCalls,themes,swears,
   length:stored.body.length,cited:evidence.cited,quotesVerified:evidence.quotesChecked};
 const report=[
  '# Чёрный Вестник 0.2.2: реальный редакторский Groq smoke',
  '',
  '30 полностью вымышленных сообщений; **Groq настоящий**, Telegram изолирован.',
  '',
  '## Механические результаты',
  ...Object.entries(check).map(([k,v])=>'- '+k+': '+v),
  '',
  '## Настоящий ответ',
  '~~~text',stored.body,'~~~',
  '',
  '**Ограничение:** никакая проверка правильности ID или цитат не доказывает истинность всех пересказов и шуток. Требуется редакторский просмотр.',
  ''
 ].join('\n');
 mkdirSync('reports',{recursive:true});
 writeFileSync('reports/editorial-live.md',report);
 log('EDITORIAL LIVE: '+JSON.stringify(check));
 log('GROQ REPORT:\n'+stored.body.slice(0,5500));
 if(!swears||themes<3)throw Error('Quality gate: insufficient profanity or topic diversity');
 return {report,check};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))
 run().catch(e=>{console.error('EDITORIAL LIVE FAIL: '+String(e.message).slice(0,160));process.exitCode=1;});
