/* Самопроверка движка «Дожми сегодня» (Node, без DOM). */
'use strict';

var path = require('path');
require(path.join(__dirname, 'app.js'));

var E = globalThis.TurnikEngine;
var fails = 0;

function ok(cond, msg, extra) {
  if (cond) { console.log('ok   ' + msg); return; }
  fails++;
  console.log('FAIL ' + msg + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
}

function eq(got, want, msg) { ok(got === want, msg, { got: got, want: want }); }

/* «Сегодня» из ТЗ: пятница 13 ноября 2026 года. */
var TODAY = new Date(Date.UTC(2026, 10, 13));
var PLAN = 1550000;

function load(demo) {
  var built = E.demos[demo].build();
  var bytes = built.bytes || new TextEncoder().encode(built.text);
  var decoded = E.decodeBytes(bytes.buffer ? bytes.buffer : bytes);
  var delim = E.detectDelimiter(decoded.text);
  var rows = E.parseCsv(decoded.text, delim);
  var headerIndex = E.findHeaderRow(rows);
  var parsed = E.extractRecords(rows, headerIndex);
  parsed.decoded = decoded;
  parsed.delim = delim;
  parsed.rows = rows;
  parsed.headerIndex = headerIndex;
  parsed.built = built;
  return parsed;
}

function byId(list) {
  var map = {};
  list.forEach(function (d) { map[String(d.id)] = d; });
  return map;
}

/* ── 1. разбор значений ── */
eq(E.parseAmount('1,2 млн'), 1200000, 'сумма: 1,2 млн');
eq(E.parseAmount('980 тыс'), 980000, 'сумма: 980 тыс');
eq(E.parseAmount('320000,50'), 320000.5, 'сумма: 320000,50');
eq(E.parseAmount('2 100 000'), 2100000, 'сумма: 2 100 000');
eq(E.parseAmount('96 000 руб.'), 96000, 'сумма: 96 000 руб.');
eq(E.parseAmount('—'), null, 'сумма: прочерк → null');
eq(E.parseDate('12.01.2026').toISOString().slice(0, 10), '2026-01-12', 'дата: 12.01.2026');
eq(E.parseDate('12 января 2026').toISOString().slice(0, 10), '2026-01-12', 'дата: 12 января 2026');
eq(E.parseDate('5 дек 2026').toISOString().slice(0, 10), '2026-12-05', 'дата: 5 дек 2026');
eq(E.parseDate('не дата'), null, 'дата: мусор → null');

/* ── 2. рабочие дни (правило «счёт действует 5 рабочих дней») ── */
eq(E.workingDaysSince(new Date(Date.UTC(2026, 10, 9)), TODAY), 4, 'раб. дней с 09.11 по 13.11 = 4');
eq(E.workingDaysSince(new Date(Date.UTC(2026, 10, 2)), TODAY), 9, 'раб. дней с 02.11 по 13.11 = 9');
eq(E.addWorkingDays(new Date(Date.UTC(2026, 10, 9)), 5).toISOString().slice(0, 10), '2026-11-16',
  'счёт от 09.11 действует до 16.11');

/* ── 3. шаг из комментария ── */
var step12 = E.stepFromComment('12.11 Позвонить, выяснить потребность');
eq(step12.text, 'Позвонить, выяснить потребность', 'шаг: текст без даты-префикса');
eq(step12.date.day + '.' + step12.date.month, '12.11', 'шаг: дата-префикс извлечена');
eq(E.stepFromComment('').text, '', 'шаг: пустой комментарий');

/* ── 4. колонки листа «Сделки» ── */
var real = load('real');
eq(real.decoded.encoding, 'UTF-8', 'боевая: кодировка UTF-8');
eq(real.delim, ',', 'боевая: разделитель запятая (как выгружает Google)');
eq(real.headerIndex, 0, 'боевая: шапка в первой строке');

var map = real.map;
eq(map.id, 0, 'колонка №');
eq(map.client, 1, 'колонка Клиент');
eq(map.clientType, 2, 'колонка Тип клиента');
eq(map.product, 3, 'колонка Товар');
eq(map.amount, 4, 'колонка Сумма');
eq(map.stage, 5, 'колонка Этап');
eq(map.created, 6, 'колонка Создана');
eq(map.lastContact, 7, 'колонка Последний контакт');
eq(map.nextDate, 8, 'колонка Следующий шаг (дата)');
eq(map.comment, 9, 'колонка Комментарий менеджера');
eq(real.records.length, 40, 'боевая: 40 сделок');

var r3 = real.records[2];
eq(r3.amount, 2100000, 'боевая: сумма 2 100 000 распознана');
eq(r3.step, 'Первый звонок: «Пришлите КП на всё, сравним». Потребность не выясняли.',
  'боевая: шаг взят из комментария');
eq(r3.nextDate, null, 'боевая: пустая колонка даты шага = нет дедлайна');


/* ── 5. боевой расклад на 13.11.2026 ── */
var res = E.analyze(real.records, TODAY, PLAN);

eq(res.total, 40, 'боевая: всего 40 сделок');
eq(res.picked.length, 5, 'боевая: выбрано 5');

var pickedIds = res.picked.map(function (d) { return String(d.id); });
eq(pickedIds.join(','), '27,12,28,37,36', 'боевая: пятёрка = 27, 12, 28, 37, 36');
console.log('     топ-5: ' + res.picked.map(function (d) {
  return d.id + '/' + d.score + '/~' + d.daysToMoney + 'дн.' + (d.unsure ? '!' : '');
}).join(', '));

var sortedOk = res.picked.every(function (d, i, arr) { return i === 0 || arr[i - 1].score >= d.score; });
ok(sortedOk, 'боевая: порядок по убыванию баллов');

var deals = byId(res.all);
eq(deals['27'].action.indexOf('Выставить счёт'), 0, 'боевая: №27 — выставить счёт (клиент согласовал КП)');
eq(deals['36'].action.indexOf('Перевыставить счёт'), 0, 'боевая: №36 — счёт 9 раб. дней, перевыставить');
ok(deals['28'].action.indexOf('15.12') !== -1, 'боевая: №28 — проект договора до 15.12');
ok(deals['37'].action.indexOf('перерасчёт') !== -1, 'боевая: №37 — перерасчёт по запросу директора');
eq(deals['12'].daysToMoney, 3, 'боевая: №12 — счёт ещё действует (4 раб. дня), деньги быстрее всех');

/* ── 6. правила компании ── */
eq(deals['14'].verdict, 'escalation', 'правило скидки: №14 (30%) — решение руководителя');
ok(deals['14'].reason.indexOf('7%') !== -1, 'правило скидки: причина ссылается на 7%');
eq(deals['10'].verdict, 'escalation', 'правило оплаты: №10 (отсрочка физлицу) — решение руководителя');
eq(deals['36'].invoiceWd, 9, 'правило счёта: №36 — 9 рабочих дней счёту');
ok(deals['6'].flags.noLpr, 'правило ЛПР: №6 — контакт только с секретарём');
eq(deals['6'].daysToMoney, 25, 'правило ЛПР: №6 — +5 дней на выход на директора');

/* ── 7. что отсеивается ── */
var deadIds = res.dead.map(function (d) { return String(d.id); }).sort();
eq(deadIds.join(','), '1,34,39,9', 'вне игры: дубль, конкурент, оплата пришла, неверный номер');
ok(deals['1'].reason.indexOf('дубль') !== -1, 'дубль: №1 помечен дублем');
eq(deals['12'].verdict, 'today', 'дубль: №12 осталась в работе');

var parkedIds = res.parked.map(function (d) { return String(d.id); });
ok(parkedIds.indexOf('23') !== -1, 'отложено: №23 — бюджет 2027');
ok(parkedIds.indexOf('26') !== -1, 'отложено: №26 — аукцион в декабре');
ok(parkedIds.indexOf('18') !== -1, 'отложено: №18 — «вернёмся позже»');
ok(parkedIds.indexOf('30') === -1, '№30 не отложена: у неё просроченный шаг');
eq(res.parked.length, 10, 'отложено ровно 10 сделок');

/* ── 8. «не уверен, что делать» ── */
eq(deals['8'].verdict, 'today', '№8 осталась кандидатом: шаг просрочен');
eq(deals['8'].unsure, true, '№8 — «не уверен, что делать»');
ok(deals['8'].reason.indexOf('просрочен') !== -1, '№8 — причина: срок шага прошёл');
eq(deals['30'].unsure, true, '№30 — «не уверен, что делать»');
ok(res.picked.every(function (d) { return !d.unsure; }), 'в пятёрке нет сделок с неясным шагом');

/* ── 9. план и итог ── */
eq(res.covered, 2570000, 'сумма пятёрки 2 570 000 ₽');
ok(res.covered >= PLAN, 'пятёрка закрывает план 1 550 000 ₽');
eq(res.missing, 0, 'до плана не хватает 0');
eq(res.rest.length, 5, 'показаны ближайшие после пятёрки');
console.log('     резерв: ' + res.rest.map(function (d) {
  return d.id + '/' + d.score + '/~' + d.daysToMoney + 'дн.';
}).join(', '));
ok(res.rest.map(function (d) { return String(d.id); }).indexOf('3') !== -1,
  'в резерве: №3 на 2 100 000 ₽');

/* ── 10. устойчивость: другая дата ── */
var later = E.analyze(real.records, new Date(Date.UTC(2026, 10, 20)), PLAN);
ok(later.picked.length === 5, 'на 20.11 тоже есть пятёрка');
ok(later.picked.map(function (d) { return String(d.id); }).indexOf('28') !== -1,
  'на 20.11 №28 всё ещё в игре');

/* ── 11. грязная выгрузка: cp1251, шапка не сверху ── */
var dirty = load('dirty');
eq(dirty.decoded.encoding, 'windows-1251', 'грязная: кодировка windows-1251');
ok(dirty.decoded.text.indexOf('Ромашка') !== -1, 'грязная: кириллица декодирована');
eq(dirty.delim, ';', 'грязная: разделитель ;');
eq(dirty.headerIndex, 2, 'грязная: шапка найдена на 3-й строке');
eq(dirty.records.length, 8, 'грязная: 8 сделок');
eq(dirty.skipped, 2, 'грязная: пропущены разделитель и повтор шапки');
eq(dirty.records[0].amount, 1200000, 'грязная: «1,2 млн» → 1 200 000');
eq(dirty.records[1].amount, 980000, 'грязная: «980 тыс» → 980 000');
eq(dirty.records[3].amount, 320000.5, 'грязная: «320000,50»');
eq(dirty.records[0].product, 'Турник, 11 шт.', 'грязная: запятая внутри поля сохранена');
eq(dirty.map.clientType, 2, 'грязная: «Тип клиента» опознан');
eq(dirty.map.comment, 9, 'грязная: «Комментарий менеджера» опознан');

var dirtyRes = E.analyze(dirty.records, TODAY, 0);
var dirtyDeals = byId(dirtyRes.all);
eq(dirtyRes.picked.length, 5, 'грязная: пятёрка собрана');
eq(dirtyDeals['2'].action.indexOf('Выставить счёт'), 0, 'грязная: «выставляйте счёт» → выставить счёт');
eq(dirtyDeals['7'].verdict, 'escalation', 'грязная: скидка 25% → к руководителю');
eq(dirtyDeals['8'].verdict, 'dead', 'грязная: «Оплачено» → вне игры');
eq(dirtyDeals['6'].verdict, 'parked', 'грязная: контакта нет 45 дней → отложено');
eq(dirtyDeals['4'].flags.gov, true, 'грязная: МБОУ распознан как бюджетный');

/* ── 12. минимальная выгрузка: 3 колонки ── */
var minimal = load('minimal');
eq(minimal.records.length, 4, 'минимальная: 4 сделки');
eq(minimal.map.nextStep, undefined, 'минимальная: колонки шага нет');
eq(minimal.records[0].id, 'Строка 2', 'минимальная: номер генерируется');

var minRes = E.analyze(minimal.records, TODAY, 0);
eq(minRes.dead.length, 1, 'минимальная: «Архив» вне игры');
eq(minRes.picked.length, 3, 'минимальная: выбраны 3 активные');
ok(minRes.picked.every(function (d) { return d.unsure; }), 'минимальная: без шага — все «не уверен»');

/* ── 13. крайняя выгрузка: дожимать нечего ── */
var edge = load('edge');
var edgeRes = E.analyze(edge.records, TODAY, 0);
eq(edgeRes.picked.length, 0, 'крайняя: пятёрки нет');
eq(edgeRes.dead.length, 6, 'крайняя: 6 вне игры');
eq(edgeRes.parked.length, 1, 'крайняя: 1 отложена');

/* ── 14. стадии и правила как функции ── */
function one(stage, comment) {
  return E.analyze([{
    id: 'X', row: 1, client: 'Клиент', clientType: 'юрлицо', product: 'Турник',
    stage: stage, amount: 100000, created: null, comment: comment || '',
    step: E.stepFromComment(comment || '').text,
    stepDateInComment: E.stepFromComment(comment || '').date,
    nextDate: null, lastContact: TODAY
  }], TODAY, 0);
}
eq(one('Счёт выставлен').dead.length, 0, 'стадия: «Счёт выставлен» остаётся');
eq(one('Ожидает оплаты').dead.length, 0, 'стадия: «Ожидает оплаты» остаётся');
eq(one('Счёт оплачен').dead.length, 1, 'стадия: «Счёт оплачен» отсеивается');
eq(one('Закрыт успешно').dead.length, 1, 'стадия: «Закрыт успешно» отсеивается');
eq(one('КП отправлено', 'Просят скидку 20%').escalation.length, 1, 'скидка 20% → эскалация');
eq(one('КП отправлено', 'Просят скидку 5%').escalation.length, 0, 'скидка 5% — менеджер волен сам');

console.log(fails ? '\nПРОВАЛЕНО: ' + fails : '\nВСЁ ЧИСТО');
process.exit(fails ? 1 : 0);
