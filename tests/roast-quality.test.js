import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeRoastTone,assessRoastSignals} from '../src/roast-quality.js';

const section='💀 ЧЁРНЫЙ ВЕСТНИК\n🔥 Главное позорище\n⚔️ Главный срач\n🏆 Номинации\n🪦 Приговор дня\n';

test('three swears copied from participant quotes do not count as editor toxicity',()=>{
  const a=analyzeRoastTone(section+'«Блядь, нахуй, пиздец» [#1001]. Сухой пересказ событий.');
  assert.equal(a.editorialSwearCount,0);
  assert.equal(assessRoastSignals(a).pass,false);
});
test('generic insulting a person without a punchline fails blandness gate',()=>{
  const a=analyzeRoastTone(section+'Ты не игрок, ты идиот. Это не цель, это провал. Блядь, нахуй, пиздец.');
  assert.ok(a.clichés.length>=2);
  assert.ok(assessRoastSignals(a).problems.some(x=>x.includes('generic')));
});
test('distinct editor curses in a dense factual roast pass mechanical signal gate',()=>{
  const s=section+'Вчера спонсировал экономию за сорок тысяч, сегодня оплачивает финансовое просветление. '
    +'Блядь, вместо чека получил экскурсию по собственным оправданиям. '
    +'Второй герой снова пообещал быть через пять минут. Нахуй часы, если расписание придумано методом гадания по ключам? '
    +'Геймпад капитулировал раньше хозяина. Какая ёбаная техническая независимость!';
  const tone=analyzeRoastTone(s);
  assert.equal(tone.editorialSwearCount,3);
  assert.equal(tone.editorialSwearRoots.length,3);
  assert.equal(tone.namedSections,4);
  assert.equal(assessRoastSignals(tone).pass,true);
});
test('originality estimate flags verbatim copied long jokes outside quotes',()=>{
  const joke='У тебя время продаётся по подписке, а собственный календарь ушёл в самоволку и требует выкуп.';
  const tone=analyzeRoastTone(section+joke+'. '+joke+'. Блядь, ёбаный пиздец!',[{body:joke}]);
  assert.equal(tone.recycledLongLines.length,2);
  assert.equal(assessRoastSignals(tone).pass,false);
});


test('politely telling the roast victims not to get angry is a rejected soft finale',()=>{
 const sample='💀 ЧЁРНЫЙ ВЕСТНИК\n🔥 Главное позорище\n⚔️ Главный срач\n🏆 Номинации\n🪦 Приговор дня\n'
  +'Блядь, какая экономия. Нахуй часы. Ёбаные обещания. Старайтесь сильно не злиться: всё равно весело.';
 const tone=analyzeRoastTone(sample);
 assert.equal(tone.hasSoftFinale,true);
 assert.ok(assessRoastSignals(tone).problems.some(s=>s.includes('soft')));
});

test('explicit punchline labels are not a substitute for jokes',()=>{
 const tone=analyzeRoastTone(section+'Панчлайн: дружный разговор превратился в скучную стенгазету.');
 assert.ok(tone.explicitPunchlineLabels.length>0);
 assert.ok(assessRoastSignals(tone).problems.some(p=>p.includes('punchline labels')));
});
