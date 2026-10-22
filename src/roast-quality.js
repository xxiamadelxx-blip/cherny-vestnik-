// Editorial signals for a consensual adult chat roast. Mechanical indicators
// only: human reading still decides whether a joke is funny or a fact inferred.
const SWEAR = /бляд[ьяеи]?|блят[ьаеи]?|пизд[а-яё]*|(?:[зн]а)?хуй|хуйн[а-яё]*|хер[а-яё]*|(?:за)?[её]б[а-яё]*|долбо[её]б[а-яё]*|мудак[а-яё]*|сук[аиие]*|пиздец/giu;
const TRITE = [
  /ты не [^.!?\n]{2,65},?\s*ты\s[^.!?\n]{2,70}/giu,
  /это не [^.!?\n]{2,65},?\s*это\s[^.!?\n]{2,70}/giu,
  /физика гордится/giu,
  /вы все не люди/giu,
  /набор чат-ботов со сломанной логикой/giu,
  /жив[её]шь в параллельной вселенной/giu,
  /ты (?:просто )?дурак/giu,
  /(?:поздравляем|гениально)[,!.\s]/giu
];
const NEEDED = ['🔥 Главное позорище','⚔️ Главный срач','🏆','🪦 Приговор дня'];
const RU_WORD=/[а-яё]/iu;
const normalize=s=>String(s||'').toLocaleLowerCase('ru-RU').replace(/\s+/gu,' ').trim();

export function analyzeRoastTone(body,source=[]){
  const text=String(body||'');
  // Do not mistake someone else's swear word for the editor's own voice.
  const editor=text.replace(/[«“"][^»”"\n]{0,800}[»”"]/gu,' ');
  const items=[...editor.matchAll(SWEAR)].map(x=>x[0].toLocaleLowerCase('ru-RU'));
  const roots=new Set(items.map(w=>{
    if(/бля/.test(w))return 'бляд';
    if(/пизд/.test(w))return 'пизд';
    if(/ху[йяе]|хуйн|нахуй/.test(w))return 'хуй';
    if(/(?:за)?[её]б|долбо/.test(w))return 'ёб';
    if(/мудак/.test(w))return 'мудак';
    if(/сук/.test(w))return 'сук';
    return 'хер';
  }));
  const clichés=TRITE.flatMap(re=>[...editor.matchAll(re)].map(x=>x[0]));
  const normalizedSource=source.map(x=>normalize(typeof x==='string'?x:x.body)).filter(Boolean);
  // Identify exact recycled long punchlines, not ordinary shared topic words.
  const reused=[];
  for(const sentence of editor.split(/[.!?\n]+/u)){
    const cleaned=normalize(sentence.replace(/\[#\d+\]/g,''));
    if(cleaned.length<40||!RU_WORD.test(cleaned))continue;
    for(const original of normalizedSource){
      if(original.length<40)continue;
      const span=cleaned.length>100?cleaned.slice(0,100):cleaned;
      if(original.includes(span)){reused.push(cleaned.slice(0,110));break;}
    }
  }
  return {
    editorialSwearCount:items.length,
    editorialSwearRoots:[...roots],
    clichés,
    recycledLongLines:reused,
    namedSections:NEEDED.filter(x=>text.includes(x)).length,
    hasSoftFinale:/вс[её]\s+равно\s+(?:молодцы|люблю)|я вас люблю|главное, что мы друзья|не\s+(?:злитесь|обижайтесь|сердитесь)|старайтесь\s+[^.!?\n]{0,45}не\s+злиться/iu.test(editor)
  };
}

export function assessRoastSignals(tone){
  const problems=[];
  if(tone.editorialSwearCount<3)problems.push('too little profanity in the EDITOR voice');
  if(tone.editorialSwearRoots.length<2)problems.push('only one kind of expletive');
  if(tone.namedSections<4)problems.push('missing newspaper sections');
  if(tone.clichés.length>1)problems.push('generic prefab insults instead of original punchlines');
  if(tone.recycledLongLines.length>1)problems.push('too much copied user humor');
  if(tone.hasSoftFinale)problems.push('soft conciliatory finale');
  return {pass:problems.length===0,problems};
}
