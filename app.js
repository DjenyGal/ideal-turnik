/* «Идеальный турник» · движок правил v1.0
   CSV + дата → 5 сделок с действием на сегодня.
   Без нейросети: только фиксированные правила, одинаковые на всех выгрузках. */

(function (root) {
  'use strict';

  var TOP_N = 5;
  var MAX_PER_CLIENT = 2;
  var DAY = 86400000;

  /* ── мелкие утилиты ─────────────────────────────────── */

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\u00a0/g, ' ')
      .replace(/[«»"'`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function formatMoney(v) {
    if (!Number.isFinite(v)) return '—';
    return Math.round(v).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
  }

  function daysBetween(a, b) {
    return Math.round((a.getTime() - b.getTime()) / DAY);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(d) {
    if (!d) return '';
    return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  /* ── кодировка ──────────────────────────────────────── */

  function decodeBytes(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16 LE' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16 BE' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
    } catch (e) {
      return { text: new TextDecoder('windows-1251').decode(bytes), encoding: 'windows-1251' };
    }
  }

  /* ── CSV ────────────────────────────────────────────── */

  function countOutsideQuotes(line, delim) {
    var count = 0;
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && ch === delim) {
        count++;
      }
    }
    return count;
  }

  function detectDelimiter(text) {
    var lines = text.split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 6);
    var candidates = [';', ',', '\t', '|'];
    var best = ';';
    var bestScore = -1;
    for (var i = 0; i < candidates.length; i++) {
      var score = 0;
      for (var j = 0; j < lines.length; j++) score += countOutsideQuotes(lines[j], candidates[i]);
      if (score > bestScore) { bestScore = score; best = candidates[i]; }
    }
    return bestScore > 0 ? best : ',';
  }

  function parseCsv(text, delim) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\r') {
        if (text[i + 1] !== '\n') {
          row.push(field);
          rows.push(row);
          row = [];
          field = '';
        }
      } else {
        field += ch;
      }
    }

    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /* ── колонки ────────────────────────────────────────── */

  var COLUMN_RULES = [
    {
      key: 'lastContact', label: 'последний контакт',
      test: function (n) {
        return /последн[а-яё]*\s*(контакт|касани|активност)/.test(n) ||
          /дата\s*(последнего\s*)?контакт/.test(n);
      }
    },
    {
      key: 'nextDate', label: 'дата следующего шага',
      test: function (n) {
        var base = /(дата|срок|дедлайн|deadline)/.test(n);
        var subject = /(шаг|действ|задач|контакт|звонк|встреч)/.test(n);
        return (base && subject) || /^(срок|дедлайн)$/.test(n);
      }
    },
    {
      key: 'nextStep', label: 'следующий шаг',
      test: function (n) {
        return /следующ[а-яё]*\s*(шаг|действ|контакт)/.test(n) && !/дата/.test(n) ||
          /(^|\s)(шаг|действие|задача)(\s|$)/.test(n) ||
          /next\s*step/.test(n);
      }
    },
    {
      key: 'comment', label: 'комментарий',
      test: function (n) { return /(комментар|примечан|заметк|описан|история\s+сделк)/.test(n); }
    },
    {
      key: 'created', label: 'дата создания',
      test: function (n) { return /(создан|дата\s+поступлен|created)/.test(n); }
    },
    {
      key: 'clientType', label: 'тип клиента',
      test: function (n) { return /(тип\s+клиента|сегмент|категор|клиент\s*:\s*тип)/.test(n); }
    },
    {
      key: 'product', label: 'товар',
      test: function (n) { return /(^|\s)(товар|позиц|продукт|услуга|объект)/.test(n) || /прода[её]м/.test(n); }
    },
    {
      key: 'amount', label: 'сумма',
      test: function (n) { return /(сумм|бюджет|стоимост|amount|цена)/.test(n); }
    },
    {
      key: 'stage', label: 'стадия',
      test: function (n) { return /(стади|этап|статус|воронк|stage)/.test(n); }
    },
    {
      key: 'client', label: 'клиент',
      test: function (n) { return /(клиент|компани|заказчик|название|контрагент|customer|company)/.test(n); }
    },
    {
      key: 'id', label: 'номер сделки',
      test: function (n) { return /(номер|^№|ид|id|сделк|deal)/.test(n); }
    }
  ];

  function mapHeader(cells) {
    var map = {};
    cells.forEach(function (cell, index) {
      var n = norm(cell);
      if (!n) return;
      for (var i = 0; i < COLUMN_RULES.length; i++) {
        var rule = COLUMN_RULES[i];
        if (map[rule.key] != null) continue;
        if (rule.test(n)) { map[rule.key] = index; return; }
      }
    });
    return map;
  }

  function findHeaderRow(rows) {
    var limit = Math.min(rows.length, 12);
    var bestIndex = -1;
    var bestScore = 0;
    for (var i = 0; i < limit; i++) {
      var score = Object.keys(mapHeader(rows[i])).length;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    return bestScore >= 2 ? bestIndex : -1;
  }

  /* ── значения ───────────────────────────────────────── */

  function parseAmount(raw) {
    if (raw == null) return null;
    var s = String(raw).trim().replace(/\u00a0/g, ' ');
    if (!s) return null;
    var low = s.toLowerCase();
    if (/^(—|-|–|нет|н\/д|n\/a|nan)$/.test(low)) return null;

    var mult = 1;
    if (/(млрд|миллиард)/.test(low)) mult = 1e9;
    else if (/(млн|миллион)/.test(low)) mult = 1e6;
    else if (/(тыс|тысяч)/.test(low)) mult = 1e3;

    var num = low
      .replace(/млрд\.?|миллиард[а-яё]*|млн\.?|миллион[а-яё]*|тыс\.?|тысяч[а-яё]*|руб\.?|рублей|р\.|₽|rub|rur/gi, ' ')
      .replace(/[^\d.,\-]/g, '')
      .trim();
    if (!num || !/\d/.test(num)) return null;

    var hasDot = num.indexOf('.') !== -1;
    var hasComma = num.indexOf(',') !== -1;

    if (hasDot && hasComma) {
      if (num.lastIndexOf(',') > num.lastIndexOf('.')) num = num.replace(/\./g, '').replace(',', '.');
      else num = num.replace(/,/g, '');
    } else if (hasComma) {
      var partsC = num.split(',');
      if (partsC.length === 2 && partsC[1].length > 0 && partsC[1].length <= 2) {
        num = partsC[0] + '.' + partsC[1];
      } else {
        num = num.replace(/,/g, '');
      }
    } else if (hasDot) {
      var partsD = num.split('.');
      if (partsD.length > 2) {
        num = partsD.join('');
      } else if (partsD[1] && partsD[1].length === 3 && partsD[0].length <= 3) {
        num = partsD.join('');
      }
    }

    var value = parseFloat(num);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * mult * 100) / 100;
  }

  var MONTH_NAMES = [
    ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['ма', 5], ['июн', 6],
    ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10], ['ноябр', 11], ['декабр', 12],
    ['янв', 1], ['фев', 2], ['мар', 3], ['апр', 4], ['май', 5], ['авг', 8],
    ['сен', 9], ['сент', 9], ['окт', 10], ['ноя', 11], ['дек', 12]
  ];

  function monthFromName(name) {
    var n = norm(name);
    for (var i = 0; i < MONTH_NAMES.length; i++) {
      if (n.indexOf(MONTH_NAMES[i][0]) === 0) return MONTH_NAMES[i][1];
    }
    return 0;
  }

  function makeDate(year, month, day) {
    if (!(year > 1900 && year < 2200) || month < 1 || month > 12 || day < 1 || day > 31) return null;
    var d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d;
  }

  function parseDate(raw) {
    if (raw == null) return null;
    var s = String(raw).trim().replace(/\u00a0/g, ' ');
    if (!s) return null;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;
    s = s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, '');

    var m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
      return makeDate(+m[1], +m[2], +m[3]);
    }
    if ((m = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/))) {
      var y = +m[3];
      if (y < 100) y += 2000;
      return makeDate(y, +m[2], +m[1]);
    }
    if ((m = s.match(/^(\d{1,2})\s+([а-яёa-z]+)\.?\s*(\d{4})?$/i))) {
      var mon = monthFromName(m[2]);
      if (mon) return makeDate(m[3] ? +m[3] : new Date().getUTCFullYear(), mon, +m[1]);
    }
    if (/^\d{5}$/.test(s)) {
      var serial = +s;
      if (serial > 20000 && serial < 80000) return new Date(Date.UTC(1899, 11, 30) + serial * DAY);
    }
    return null;
  }

  /* ── разбор комментария ─────────────────────────────── */

  var LEADING_DATE = /^\s*(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?\s*[,:\-–]?\s*/;

  function stepFromComment(comment) {
    var raw = String(comment || '').trim();
    if (!raw) return { text: '', date: null };

    var m = raw.match(LEADING_DATE);
    var date = null;
    if (m) {
      var day = +m[1];
      var month = +m[2];
      var year = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
      date = { day: day, month: month, year: year };
      raw = raw.slice(m[0].length);
    }
    return { text: raw.trim(), date: date };
  }

  /* Дата из префикса комментария с привязкой к «сегодня»:
     год берётся тот же, что у сегодня; если дата в будущем больше чем на 6 месяцев — прошлый год. */
  function resolveCommentDate(prefix, today) {
    if (!prefix) return null;
    var year = prefix.year || today.getUTCFullYear();
    var d = makeDate(year, prefix.month, prefix.day);
    if (!d) return null;
    if (d.getTime() - today.getTime() > 180 * DAY) {
      d = makeDate(year - 1, prefix.month, prefix.day);
    }
    return d;
  }

  /* Любая дата вида дд.мм внутри текста. */
  function findDateInText(text, today) {
    var m = String(text || '').match(/(\d{1,2})[.\/](\d{1,2})(?!\d)/);
    if (!m) return null;
    return resolveCommentDate({ day: +m[1], month: +m[2], year: null }, today);
  }

  function findPercent(text) {
    var m = String(text || '').match(/(\d{1,3})\s*%/);
    return m ? +m[1] : null;
  }

  /* ── рабочие дни ────────────────────────────────────── */

  function isWeekend(d) {
    var wd = d.getUTCDay();
    return wd === 0 || wd === 6;
  }

  /* Сколько рабочих дней прошло с даты по сегодня (не считая самой даты). */
  function workingDaysSince(from, to) {
    if (!from || !to) return null;
    var count = 0;
    var cur = new Date(from.getTime());
    var guard = 0;
    while (cur.getTime() < to.getTime() && guard < 4000) {
      cur = new Date(cur.getTime() + DAY);
      guard++;
      if (!isWeekend(cur)) count++;
    }
    return count;
  }

  /* Прибавить N рабочих дней к дате. */
  function addWorkingDays(from, n) {
    var cur = new Date(from.getTime());
    var added = 0;
    var guard = 0;
    while (added < n && guard < 4000) {
      cur = new Date(cur.getTime() + DAY);
      guard++;
      if (!isWeekend(cur)) added++;
    }
    return cur;
  }

  /* ── строки → сделки ────────────────────────────────── */

  function extractRecords(rows, headerIndex) {
    var header = rows[headerIndex].map(function (c) { return String(c == null ? '' : c).trim(); });
    var map = mapHeader(header);
    var headerSig = header.map(norm).join('|');
    var records = [];
    var skipped = 0;

    for (var i = headerIndex + 1; i < rows.length; i++) {
      var cells = rows[i].map(function (c) { return String(c == null ? '' : c).trim(); });
      if (cells.every(function (c) { return !c; })) continue;
      if (cells.every(function (c) { return /^[-–—_=.\s]*$/.test(c); })) { skipped++; continue; }
      if (cells.map(norm).join('|') === headerSig) { skipped++; continue; }

      var get = function (key) { return map[key] != null ? (cells[map[key]] || '') : ''; };
      var comment = get('comment');
      var stepColumn = get('nextStep');
      var fromComment = stepFromComment(comment);

      records.push({
        row: i + 1,
        id: get('id') || ('Строка ' + (i + 1)),
        client: get('client'),
        clientType: get('clientType'),
        product: get('product'),
        stage: get('stage'),
        amountRaw: get('amount'),
        amount: parseAmount(get('amount')),
        created: parseDate(get('created')),
        comment: comment,
        step: stepColumn || fromComment.text,
        stepDateInComment: fromComment.date,
        nextDateRaw: get('nextDate'),
        nextDate: parseDate(get('nextDate')),
        lastContactRaw: get('lastContact'),
        lastContact: parseDate(get('lastContact'))
      });
    }

    return { header: header, map: map, records: records, skipped: skipped };
  }

  /* ── правила компании (лист «Правила») ──────────────── */

  var COMPANY_RULES = {
    invoiceWorkingDays: 5,
    discountManagerPercent: 7,
    makeWorkingDays: [10, 14],
    deliveryDays: [2, 5],
    prepay: 'Юрлица и физлица платят 100% предоплатой, отсрочка только госзаказчику по контракту.',
    lpr: 'Решает руководитель или владелец (ЛПР). Секретарь и завхоз не ЛПР, кроме бюджетного учреждения, где договор готовит завхоз.'
  };

  /* Признаки, которые читаются из комментария менеджера, стадии и типа клиента. */
  var SIGNAL = {
    duplicate: /дубль\s+сделки|заведена\s+повторно/,
    boughtElsewhere: /купили\s+у\s+конкурента|взяли\s+у\s+конкурента|у\s+конкурента\s+дешевле/,
    moneyAlreadyIn: /оплата\s+пришла|оплата\s+поступила|оплачено\s+100|пришла\s+100\s*%/,
    badPhone: /номер[^\n]{0,30}неверн/,
    noConnection: /не\s+дозвонились|не\s+отвечает/,
    clientGone: /клиент\s+пропал|прочитано\s+без\s+ответа/,
    postponed: /верн[её]мся\s+позже|пока\s+не\s+до\s+этого|бюджет\s+на\s+20\d\d|просили\s+вернуться|аукцион|размещение\s+в/,
    readyToPay: /выставляйте\s+сч[её]т|кп\s+устраивает|готов\s+брать|оплатим\s+на\s+этой\s+неделе|оплатим\s+сегодня|выставля[й]?те/,
    waitingOurMove: /не\s+ответили|не\s+выставлен|не\s+отправлен|не\s+выслан|просрочена|не\s+выполнена|не\s+прислали/,
    noLpr: /секретар|передаст\s+руководству|контакта\s+директора\s+нет|нет\s+контакта\s+директора/,
    insideDecision: /согласуют\s+внутри|ответ\s+обещали|изучает|созвон\s+назначен|жд[её]м\s+ответа/,
    needsData: /размер[ыа]|фото\s+площадки|выяснить\s+потребност|потребность\s+не\s+выясня|выясняем/,
    deferral: /отсрочк|рассрочк/,
    discountAsk: /скидк/,
    invoiceSent: /сч[её]т\s+отправлен|сч[её]т\s+выставлен|сч[её]т\s+послали/
  };

  var CLOSED_STAGE = /(^|\s)(отказ[а-яё]*|отклонен[а-яё]*|закрыт[а-яё]*|архив[а-яё]*|выполнен[а-яё]*|реализован[а-яё]*|провал[а-яё]*|оплачен[оа]?|оплата\s+получена|успешн[а-яё]*|lost|won|closed|done)(\s|$)/;

  function readSignals(rec) {
    var text = norm(rec.comment) + ' | ' + norm(rec.stage) + ' | ' + norm(rec.clientType);
    var flags = {};
    Object.keys(SIGNAL).forEach(function (key) { flags[key] = SIGNAL[key].test(text); });
    flags.closed = CLOSED_STAGE.test(norm(rec.stage));
    flags.gov = /госзаказчик|бюджетн|школ|детск[а-яё]*\s+сад|мбоу|мбдоу|администрац/.test(
      norm(rec.clientType) + ' ' + norm(rec.client) + ' ' + norm(rec.comment));
    flags.discountPercent = flags.discountAsk ? findPercent(rec.comment) : null;
    flags.spendDeadline = (norm(rec.comment).match(/освоить\s+до\s+(\d{1,2}[.\/]\d{1,2})/) || [])[1] || null;
    flags.deliveryPromise = (norm(rec.comment).match(/доставк[ауе]?[^\n]{0,14}?(\d{1,2}[.\/]\d{1,2})/) || [])[1] || null;
    return flags;
  }

  function stageKey(stage) {
    var s = norm(stage);
    if (/сч[её]т/.test(s)) return 'invoice';
    if (/кп|коммерческ/.test(s)) return 'quote';
    if (/согласован|переговор|торг/.test(s)) return 'agreement';
    if (/квалифик|выяснен/.test(s)) return 'qualification';
    if (/нов|заявк|лид/.test(s)) return 'new';
    return 'other';
  }

  function sizeScore(amount, plan) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    if (plan && amount >= plan) return 30;
    if (plan && amount >= plan * 0.6) return 22;
    if (amount >= 700000) return 22;
    if (amount >= 300000) return 14;
    if (amount >= 150000) return 8;
    return 0;
  }

  function velocityScore(days) {
    if (days <= 3) return 90;
    if (days <= 7) return 78;
    if (days <= 14) return 62;
    if (days <= 21) return 45;
    if (days <= 30) return 28;
    return 12;
  }

  function moneyDays(rec, flags, stage, invoiceWd, aheadDays) {
    var d;
    if (stage === 'invoice') d = (invoiceWd != null && invoiceWd > COMPANY_RULES.invoiceWorkingDays) ? 7 : 3;
    else if (stage === 'quote') d = flags.readyToPay ? 6 : (flags.waitingOurMove ? 9 : 18);
    else if (stage === 'agreement') {
      if (flags.spendDeadline) d = 12;
      else if (flags.readyToPay) d = 8;
      else if (flags.insideDecision) d = Math.max(3, (aheadDays || 0) + 4);
      else d = 20;
    } else if (stage === 'qualification') d = 25;
    else if (stage === 'new') d = flags.needsData ? 30 : 25;
    else d = 20;

    if (flags.noLpr) d += 5;
    if (flags.gov && !flags.spendDeadline) d += 7;
    return d;
  }

  /* Что сделать сегодня: формулировка собирается из правил и сигналов. */
  function makeAction(rec, flags, stage, invoiceWd) {
    var c = norm(rec.comment);
    var money = formatMoney(rec.amount) + ' ₽';

    if (flags.readyToPay && /не\s+выставлен|не\s+выслан/.test(c)) {
      return 'Выставить счёт на ' + money + ' сегодня: клиент КП согласовал, ждёт только счёт.';
    }
    if (stage === 'invoice' && invoiceWd != null && invoiceWd > COMPANY_RULES.invoiceWorkingDays) {
      return 'Перевыставить счёт: старому ' + invoiceWd + ' раб. дней, а по правилу счёт живёт ' +
        COMPANY_RULES.invoiceWorkingDays + ' раб. дней. Потом уточнить дату платежа.';
    }
    if (stage === 'invoice') {
      return 'Подтвердить оплату по действующему счёту: связаться с бухгалтерией и договориться о дне платежа.';
    }
    if (flags.spendDeadline) {
      return 'Отправить проект договора до ' + flags.spendDeadline +
        ': бюджет нужно освоить, документ ждут от нас, готовит его завхоз.';
    }
    if (flags.waitingOurMove && /пересч[её]т|цвет|спецификац|фото/.test(c)) {
      return 'Сделать перерасчёт по запросу клиента и отправить сегодня — мяч на нашей стороне.';
    }
    if (flags.noLpr) {
      return 'Выйти на ЛПР: секретарь решение не принимает, запросить разговор с руководителем или владельцем.';
    }
    if (flags.needsData) {
      return 'Позвонить, закрыть недостающие данные по объекту и назначить дату КП.';
    }
    if (flags.insideDecision && rec.nextDate) {
      return 'Не дёргать клиента: ответ обещали ' + fmtDate(rec.nextDate) +
        '. Сегодня подготовить аргументы и держать слот на связи.';
    }
    if (rec.step) return rec.step;
    return '';
  }

  function evaluate(rec, ctx) {
    var today = ctx.today;
    var flags = readSignals(rec);
    var stage = stageKey(rec.stage);
    var step = String(rec.step || '').trim();
    var commentDate = resolveCommentDate(rec.stepDateInComment, today);
    var nextDate = rec.nextDate;
    var overdueDays = nextDate ? daysBetween(today, nextDate) : null;
    var aheadDays = overdueDays != null && overdueDays < 0 ? -overdueDays : null;
    var lastTouch = rec.lastContact || commentDate || rec.created;
    var silence = lastTouch ? daysBetween(today, lastTouch) : null;
    var invoiceWd = stage === 'invoice' ? workingDaysSince(rec.lastContact || commentDate || rec.created, today) : null;

    var out = {
      id: rec.id, row: rec.row, client: rec.client, clientType: rec.clientType,
      product: rec.product, stage: rec.stage, amount: rec.amount, step: step,
      comment: rec.comment, nextDate: nextDate, lastContact: rec.lastContact,
      created: rec.created, flags: flags, verdict: 'today', reason: '',
      daysToMoney: null, score: 0, unsure: false, action: '', tags: [],
      overdueDays: overdueDays && overdueDays > 0 ? overdueDays : 0,
      aheadDays: aheadDays, silence: silence, invoiceWd: invoiceWd
    };

    if (flags.closed) return park(out, 'dead', 'стадия закрытая: ' + rec.stage);
    if (flags.duplicate) return park(out, 'dead', 'дубль другой сделки');
    if (flags.boughtElsewhere) return park(out, 'dead', 'клиент купил у конкурента');
    if (flags.moneyAlreadyIn) return park(out, 'dead', 'деньги уже пришли — это отгрузка, не продажа');
    if (flags.badPhone) return park(out, 'dead', 'номер недостоверный, клиент не отвечает');

    if (flags.postponed) return park(out, 'parked', 'клиент отложил покупку');
    if (aheadDays != null && aheadDays > 30) {
      return park(out, 'parked', 'шаг назначен через ' + aheadDays + ' ' + plural(aheadDays, 'день', 'дня', 'дней'));
    }
    var stale = silence != null && silence > 30;
    if (stale && stage !== 'invoice' && !flags.readyToPay && !flags.waitingOurMove) {
      return park(out, 'parked', 'контакт потерян ' + silence + ' ' + plural(silence, 'день', 'дня', 'дней') + ' назад');
    }
    if (flags.discountPercent != null && flags.discountPercent > COMPANY_RULES.discountManagerPercent) {
      return park(out, 'escalation', 'скидка ' + flags.discountPercent + '% — у менеджера право до ' +
        COMPANY_RULES.discountManagerPercent + '%');
    }
    if (flags.deferral && !flags.gov) {
      return park(out, 'escalation', 'просят отсрочку, а по правилу нужна 100% предоплата');
    }

    out.daysToMoney = moneyDays(rec, flags, stage, invoiceWd, aheadDays);
    out.action = makeAction({
      comment: rec.comment, step: step, nextDate: nextDate, amount: rec.amount
    }, flags, stage, invoiceWd);

    var score = velocityScore(out.daysToMoney);
    if (flags.readyToPay) score += 55;
    if (flags.waitingOurMove) score += 35;
    if (flags.insideDecision) score += 12;
    if (flags.needsData && rec.created && daysBetween(today, rec.created) <= 7) score += 10;
    if (overdueDays === 0) score += 25;
    else if (overdueDays != null && overdueDays > 0) score += 18;
    if (silence != null && silence >= 14 && silence <= 30) score += 10;
    if (stale) score -= 25;
    score += sizeScore(rec.amount, ctx.plan);
    if (!Number.isFinite(rec.amount) || rec.amount <= 0) score -= 25;
    if (!norm(rec.client)) score -= 20;
    out.score = score;
    out.tags = buildTags(out, flags, stage);

    if (!step) {
      out.unsure = true;
      out.reason = 'следующего шага в выгрузке нет';
    } else if (overdueDays != null && overdueDays > 0) {
      out.unsure = true;
      out.reason = 'шаг «' + step + '» просрочен на ' + overdueDays + ' ' +
        plural(overdueDays, 'день', 'дня', 'дней') + ' — сначала проверить, актуальна ли потребность';
    } else if (stage === 'invoice' && /выяснить|потребност|первый\s+звонок/.test(norm(step))) {
      out.unsure = true;
      out.reason = 'шаг «' + step + '» противоречит стадии «' + rec.stage + '»';
    }

    return out;
  }

  function park(out, verdict, reason) {
    out.verdict = verdict;
    out.reason = reason;
    return out;
  }

  function buildTags(out, flags, stage) {
    var tags = [];
    tags.push({ text: 'деньги ~' + out.daysToMoney + ' дн.', kind: out.daysToMoney <= 7 ? 'hot' : '' });
    if (flags.readyToPay) tags.push({ text: 'клиент готов', kind: 'hot' });
    if (flags.waitingOurMove) tags.push({ text: 'барьер на нашей стороне', kind: 'late' });
    if (flags.noLpr) tags.push({ text: 'нет контакта с ЛПР', kind: 'late' });
    if (flags.needsData) tags.push({ text: 'не хватает данных', kind: '' });
    if (flags.insideDecision) tags.push({ text: 'решение внутри клиента', kind: '' });
    if (flags.gov) tags.push({ text: 'госзаказчик', kind: '' });
    if (stage === 'invoice' && out.invoiceWd != null && out.invoiceWd > COMPANY_RULES.invoiceWorkingDays) {
      tags.push({ text: 'счёт просрочен (' + out.invoiceWd + ' р.д.)', kind: 'late' });
    }
    if (out.silence != null && out.silence >= 14 && out.silence <= 30) {
      tags.push({ text: 'молчит ' + out.silence + ' дн.', kind: '' });
    }
    if (out.silence != null && out.silence > 30) {
      tags.push({ text: 'контакт потерян ' + out.silence + ' дн.', kind: 'late' });
    }
    if (out.aheadDays != null && out.aheadDays > 0) {
      tags.push({ text: 'шаг через ' + out.aheadDays + ' дн.', kind: '' });
    }
    return tags;
  }

  function analyze(records, today, plan) {
    var ctx = { today: today, plan: plan || 0 };
    var evaluated = records.map(function (r) { return evaluate(r, ctx); });

    var seen = {};
    evaluated.forEach(function (d) {
      if (d.verdict === 'dead') return;
      var key = norm(d.client) + '|' + norm(d.product) + '|' + (d.amount || 0);
      var prev = seen[key];
      if (!prev) { seen[key] = d; return; }
      var keep = String(d.comment || '').length > String(prev.comment || '').length ? d : prev;
      var drop = keep === d ? prev : d;
      drop.verdict = 'dead';
      drop.reason = 'дубль сделки №' + keep.id;
      seen[key] = keep;
    });

    var candidates = evaluated.filter(function (d) { return d.verdict === 'today'; });
    candidates.sort(function (a, b) {
      return (b.score - a.score) ||
        (a.daysToMoney - b.daysToMoney) ||
        ((b.amount || 0) - (a.amount || 0)) ||
        String(a.id).localeCompare(String(b.id), 'ru', { numeric: true });
    });

    var picked = [];
    var perClient = {};
    candidates.forEach(function (d) {
      if (picked.length >= TOP_N) return;
      var key = norm(d.client) || ('row:' + d.row);
      var used = perClient[key] || 0;
      if (used >= MAX_PER_CLIENT) return;
      perClient[key] = used + 1;
      picked.push(d);
    });

    var covered = picked.reduce(function (sum, d) {
      return sum + (Number.isFinite(d.amount) && d.amount > 0 ? d.amount : 0);
    }, 0);

    var pickedIds = {};
    picked.forEach(function (d) { pickedIds[d.row] = true; });
    var notPicked = candidates.filter(function (d) { return !pickedIds[d.row]; });
    var rest = notPicked.slice(0, 5);
    var unsureList = notPicked.filter(function (d) { return d.unsure; });

    return {
      picked: picked,
      all: evaluated,
      candidates: candidates,
      rest: rest,
      unsureList: unsureList,
      escalation: evaluated.filter(function (d) { return d.verdict === 'escalation'; }),
      parked: evaluated.filter(function (d) { return d.verdict === 'parked'; }),
      dead: evaluated.filter(function (d) { return d.verdict === 'dead'; }),
      total: records.length,
      plan: ctx.plan,
      covered: covered,
      missing: Math.max(0, ctx.plan - covered)
    };
  }

  /* ── демо-выгрузки ──────────────────────────────────── */

  var RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function todayUTC() {
    var n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  }

  function shift(base, days) {
    return new Date(base.getTime() + days * DAY);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDots(d) {
    return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  function fmtIso(d) { return d.toISOString().slice(0, 10); }

  function fmtLong(d) {
    return d.getUTCDate() + ' ' + RU_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function fmtShort(d) {
    return d.getUTCDate() + ' ' + RU_MONTHS_SHORT[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function csvFromRows(rows, delim) {
    return rows.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        if (s.indexOf(delim) !== -1 || s.indexOf('"') !== -1 || /[\r\n]/.test(s)) {
          return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
      }).join(delim);
    }).join('\r\n');
  }

  var CP1251_EXTRA = {
    0x0401: 0xa8, 0x0451: 0xb8, 0x2116: 0xb9, 0x00ab: 0xab, 0x00bb: 0xbb,
    0x2014: 0x97, 0x2013: 0x96, 0x2026: 0x85
  };

  function encodeCp1251(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out[i] = c;
      else if (c >= 0x0410 && c <= 0x044f) out[i] = c - 0x0410 + 0xc0;
      else if (CP1251_EXTRA[c]) out[i] = CP1251_EXTRA[c];
      else out[i] = 0x3f;
    }
    return out;
  }

  /* Боевая выгрузка = лист «Сделки» из ТЗ: 40 строк, «Сегодня» — пятница 13.11.2026. */
  var REAL_HEADER = ['№', 'Клиент', 'Тип клиента', 'Товар', 'Сумма, ₽', 'Этап', 'Создана',
    'Последний контакт', 'Следующий шаг (дата)', 'Комментарий менеджера'];

  var REAL_ROWS = [
    ['1', 'ООО «СпортПарк»', 'юрлицо', 'Уличный комплекс WR-12', '480 000', 'Счёт выставлен', '27.10.2026', '09.11.2026', '', 'Дубль сделки, заведена повторно по звонку того же клиента.'],
    ['2', 'ООО «Стандарт»', 'юрлицо', 'Тренажёр уличный, 3 шт.', '141 000', 'Новая заявка', '20.10.2026', '12.11.2026', '20.11.2026', '12.11 Позвонить, выяснить потребность'],
    ['3', 'ООО «СтройИнвест»', 'юрлицо', 'Оборудование для 4 дворов', '2 100 000', 'Новая заявка', '12.11.2026', '12.11.2026', '', '12.11 Первый звонок: «Пришлите КП на всё, сравним». Потребность не выясняли.'],
    ['4', 'ООО «Парк Сервис»', 'юрлицо', 'Турник уличный, 11 шт.', '154 000', 'Новая заявка', '20.10.2026', '11.11.2026', '24.11.2026', '11.11 Позвонить, выяснить потребность'],
    ['5', 'ООО «Вектор»', 'юрлицо', 'Детский комплекс, 3 шт.', '495 000', 'Новая заявка', '20.10.2026', '09.11.2026', '19.11.2026', '09.11 Позвонить, выяснить потребность'],
    ['6', 'ООО «Гранд-Девелопмент»', 'юрлицо', 'Площадки для ЖК, 3 шт.', '1 450 000', 'Согласование', '22.10.2026', '11.11.2026', '', '11.11 Говорил с секретарём: всё нравится, передаст руководству. Контакта директора нет.'],
    ['7', 'ИП Мамедов', 'юрлицо', 'Комплекс WR-6, 3 шт.', '375 000', 'Согласование', '03.11.2026', '11.11.2026', '24.11.2026', '11.11 Согласуют внутри, ответ обещали 24.11'],
    ['8', 'МБДОУ д/с №7', 'госзаказчик', 'Рукоход, 2 шт.', '76 000', 'КП отправлено', '08.09.2026', '02.10.2026', '06.11.2026', '02.10 Клиент обещал посмотреть КП и перезвонить, с тех пор не дозвонились. Задача на звонок 06.11 просрочена.'],
    ['9', 'ООО «ДомСпорт»', 'юрлицо', 'Турники настенные, 50 шт.', '175 000', 'КП отправлено', '14.10.2026', '30.10.2026', '', '30.10 Купили у конкурента, дешевле на 12%.'],
    ['10', 'Андрей (физлицо)', 'физлицо', 'Уличный комплекс для дачи', '340 000', 'Согласование', '03.11.2026', '12.11.2026', '', '12.11 Готов брать сразу, если дадим отсрочку оплаты 60 дней.'],
    ['11', 'ТСЖ «Липки»', 'юрлицо', 'Брусья, 9 шт.', '144 000', 'Новая заявка', '20.10.2026', '12.11.2026', '18.11.2026', '12.11 Позвонить, выяснить потребность'],
    ['12', 'ООО «СпортПарк»', 'юрлицо', 'Уличный комплекс WR-12', '480 000', 'Счёт выставлен', '27.10.2026', '09.11.2026', '', '09.11 Счёт отправлен. Главбух: «оплатим на этой неделе». Больше не звонили.'],
    ['13', 'Ольга (физлицо)', 'физлицо', 'Рукоход', '38 000', 'Квалификация', '25.08.2026', '02.10.2026', '', '02.10 Ждали от клиента размеры и фото площадки, клиент пропал.'],
    ['14', 'ООО «Альфа-Спорт»', 'юрлицо', 'Тренажёры уличные, 10 шт.', '450 000', 'КП отправлено', '25.10.2026', '07.11.2026', '', '07.11 Сказали: дорого, у других на 30% дешевле. Просят скидку 30%.'],
    ['15', 'ООО «Ресурс»', 'юрлицо', 'Турник уличный, 9 шт.', '126 000', 'Согласование', '08.09.2026', '25.09.2026', '', '25.09 Писали в мессенджер, прочитано без ответа. Следующий шаг не поставлен.'],
    ['16', 'Фитнес-студия «Ритм»', 'юрлицо', 'Брусья, 5 шт.', '80 000', 'Согласование', '14.07.2026', '02.10.2026', '', '02.10 Ждали от клиента размеры и фото площадки, клиент пропал.'],
    ['17', 'ООО «Город»', 'юрлицо', 'Детский комплекс', '165 000', 'Согласование', '05.11.2026', '10.11.2026', '18.11.2026', '10.11 Согласуют внутри, ответ обещали 18.11'],
    ['18', 'ООО «Пик»', 'юрлицо', 'Брусья, 3 шт.', '48 000', 'Новая заявка', '28.07.2026', '09.10.2026', '27.10.2026', '09.10 Последний разговор: «пока не до этого, вернёмся позже». Задача на 27.10 не выполнена.'],
    ['19', 'ООО «Квартал»', 'юрлицо', 'Тренажёр уличный, 11 шт.', '517 000', 'Новая заявка', '03.11.2026', '10.11.2026', '20.11.2026', '10.11 Позвонить, выяснить потребность'],
    ['20', 'ООО «БазаСпорт»', 'юрлицо', 'Спортивный комплекс, 3 шт.', '435 000', 'Квалификация', '26.10.2026', '12.11.2026', '17.11.2026', '12.11 Выясняем размеры площадки, ждём фото']
  ];

  var REAL_ROWS_2 = [
    ['21', 'ООО «Регион-Строй»', 'юрлицо', 'Рукоход, 2 шт.', '76 000', 'КП отправлено', '20.10.2026', '12.11.2026', '17.11.2026', '12.11 КП отправлено 12.11, клиент изучает, созвон назначен'],
    ['22', 'Спортшкола «Олимп»', 'госзаказчик', 'Комплекс WR-6', '125 000', 'Квалификация', '03.11.2026', '09.11.2026', '20.11.2026', '09.11 Выясняем размеры площадки, ждём фото'],
    ['23', 'Фитнес-клуб «Пульс»', 'юрлицо', 'Рукоходы, 4 шт.', '210 000', 'Согласование', '01.10.2026', '28.10.2026', '02.03.2027', '28.10 Бюджет на 2027 год, просили вернуться в марте.'],
    ['24', 'ООО «Лидер»', 'юрлицо', 'Рукоход, 9 шт.', '342 000', 'Согласование', '08.09.2026', '09.10.2026', '', '09.10 Ждали от клиента размеры и фото площадки, клиент пропал.'],
    ['25', 'ООО «Терра»', 'юрлицо', 'Тренажёр уличный, 6 шт.', '282 000', 'КП отправлено', '03.11.2026', '12.11.2026', '25.11.2026', '12.11 КП отправлено 12.11, клиент изучает, созвон назначен'],
    ['26', 'Администрация пос. Лесной', 'госзаказчик', 'Воркаут-площадка', '760 000', 'Согласование', '08.10.2026', '05.11.2026', '10.12.2026', '05.11 Закупка будет через аукцион, размещение в декабре.'],
    ['27', 'ИП Карпенко', 'юрлицо', 'Брусья + турник, 8 комплектов', '320 000', 'КП отправлено', '05.11.2026', '12.11.2026', '', '12.11 Клиент: «КП устраивает, выставляйте счёт». Счёт не выставлен.'],
    ['28', 'МБОУ СОШ №14', 'госзаказчик', 'Спортплощадка для школы', '890 000', 'Согласование', '15.10.2026', '10.11.2026', '20.11.2026', '10.11 Завхоз: деньги надо освоить до 15.12, ждут от нас проект договора. Договор пока не отправлен.'],
    ['29', 'ООО «Нова»', 'юрлицо', 'Брусья, 10 шт.', '160 000', 'КП отправлено', '11.08.2026', '25.09.2026', '', '25.09 Ждали от клиента размеры и фото площадки, клиент пропал.'],
    ['30', 'ИП Смирнова', 'юрлицо', 'Брусья, 7 шт.', '112 000', 'Квалификация', '11.08.2026', '09.10.2026', '21.10.2026', '09.10 Клиент обещал посмотреть КП и перезвонить, с тех пор не дозвонились. Задача на звонок 21.10 просрочена.'],
    ['31', 'ООО «ЭкоДвор»', 'юрлицо', 'Брусья, 11 шт.', '176 000', 'КП отправлено', '30.10.2026', '09.11.2026', '25.11.2026', '09.11 КП отправлено 09.11, клиент изучает, созвон назначен'],
    ['32', 'ИП Белова', 'юрлицо', 'Брусья, 2 шт.', '32 000', 'Квалификация', '28.07.2026', '09.10.2026', '', '09.10 Писали в мессенджер, прочитано без ответа. Следующий шаг не поставлен.'],
    ['33', 'ТСН «Солнечный»', 'юрлицо', 'Скамья для пресса, 10 шт.', '150 000', 'Новая заявка', '14.07.2026', '02.10.2026', '03.11.2026', '02.10 Последний разговор: «пока не до этого, вернёмся позже». Задача на 03.11 не выполнена.'],
    ['34', 'ООО «Атлет»', 'юрлицо', 'Шведские стенки, 20 шт.', '540 000', 'Счёт выставлен', '12.10.2026', '06.11.2026', '', '06.11 Оплата пришла 100%. Ждём отгрузку.'],
    ['35', 'Игорь (физлицо)', 'физлицо', 'Комплекс WR-6', '125 000', 'Согласование', '05.11.2026', '10.11.2026', '19.11.2026', '10.11 Согласуют внутри, ответ обещали 19.11'],
    ['36', 'ТСЖ «Северный»', 'юрлицо', 'Детско-спортивный комплекс', '270 000', 'Счёт выставлен', '20.10.2026', '02.11.2026', '', '02.11 Ждём оплату, бухгалтер в отпуске до 12.11. Просили доставку к 20.11.'],
    ['37', 'ООО «Фитнес-Лайн»', 'юрлицо', 'Силовые тренажёры, 6 шт.', '610 000', 'КП отправлено', '29.10.2026', '11.11.2026', '', '11.11 Директор попросил поменять цвет покраски на чёрный и пересчитать. Не ответили.'],
    ['38', 'ИП Орлов', 'юрлицо', 'Баскетбольная стойка, 3 шт.', '174 000', 'КП отправлено', '05.11.2026', '06.11.2026', '19.11.2026', '06.11 КП отправлено 06.11, клиент изучает, созвон назначен'],
    ['39', 'Сергей (физлицо)', 'физлицо', 'Домашний комплекс', '68 000', 'Квалификация', '10.10.2026', '', '', 'Не отвечает 3 недели, номер, похоже, неверный.'],
    ['40', 'ИП Галиев', 'юрлицо', 'Турник уличный, 11 шт.', '154 000', 'Квалификация', '05.11.2026', '12.11.2026', '18.11.2026', '12.11 Выясняем размеры площадки, ждём фото']
  ];

  function buildReal() {
    var rows = [REAL_HEADER].concat(REAL_ROWS, REAL_ROWS_2);
    return {
      text: csvFromRows(rows, ','),
      encoding: 'UTF-8',
      name: 'sdelki_13.11.2026.csv',
      today: '2026-11-13',
      plan: 1550000
    };
  }

  function buildDirty() {
    var t = todayUTC();
    var d = function (n) { return fmtDots(shift(t, n)); };
    var rows = [
      ['Выгрузка из CRM «Идеальный турник»', 'лист «Сделки»', fmtDots(t)],
      ['', '', '', '', '', '', '', '', '', ''],
      ['№', 'Наименование клиента', 'Тип клиента', 'Что продаём', 'Сумма сделки, руб.', 'Этап воронки', 'Сделка создана', 'Дата последнего касания', 'Срок', 'Комментарий менеджера'],
      ['1', 'ООО "Ромашка"', 'юрлицо', 'Турник, 11 шт.', '1,2 млн', 'Счёт выставлен', d(-20), d(-4), '', 'Счёт отправлен, обещали оплатить на этой неделе'],
      ['2', 'Фитнес-клуб "Атлет"', 'юрлицо', 'Брусья, 9 шт.', '980 тыс', 'КП отправлено', d(-15), d(-1), fmtIso(shift(t, 0)), '12.11 КП устраивает, выставляйте счёт. Счёт не выставлен'],
      ['3', 'ИП Смирнов', 'физлицо', 'Рукоход', '96 000 руб.', 'Новая заявка', d(-3), fmtShort(shift(t, -1)), fmtShort(shift(t, 2)), 'Позвонить, выяснить потребность'],
      ['4', 'МБОУ "Школа 7"', 'госзаказчик', 'Площадка', '320000,50', 'Согласование', d(-30), d(-2), d(-1), 'Завхоз: деньги надо освоить до 25.12, ждут проект договора. Договор не отправлен'],
      ['-----', '-----', '-----', '-----', '-----', '-----', '-----', '-----', '-----', '-----'],
      ['№', 'Наименование клиента', 'Тип клиента', 'Что продаём', 'Сумма сделки, руб.', 'Этап воронки', 'Сделка создана', 'Дата последнего касания', 'Срок', 'Комментарий менеджера'],
      ['5', 'ООО "СпортМаркет"', 'юрлицо', 'Комплекс', '0', 'Согласование', d(-40), d(-12), '', 'Директор попросил пересчитать, не ответили'],
      ['6', 'Детский сад "Солнышко"', 'госзаказчик', 'Турник', '154 000', 'КП отправлено', d(-60), d(-45), d(-7), 'Клиент обещал посмотреть КП, не дозвонились'],
      ['', '', '', '', '', '', '', '', '', ''],
      ['7', 'ООО "Гранит"', 'юрлицо', 'Шведская стенка', '1 050 000', 'КП отправлено', d(-10), d(-3), '', 'Просят скидку 25%, у других дешевле'],
      ['8', 'ООО "ТехноПарк"', 'юрлицо', 'Комплекс WR-6', '890 000', 'Оплачено', d(-25), d(-3), '', 'Оплата пришла 100%, ждём отгрузку']
    ];
    var text = csvFromRows(rows, ';');
    return { bytes: encodeCp1251(text), encoding: 'windows-1251', name: 'gryaznaya_vygruzka.csv' };
  }

  function buildMinimal() {
    var rows = [
      ['Клиент', 'Сумма', 'Стадия'],
      ['ООО «Ромашка»', '480 000', 'Счёт выставлен'],
      ['ИП Смирнов', '96 000', 'Новая заявка'],
      ['Школа №17', '320 000', 'КП отправлено'],
      ['ООО «Дельта»', '300 000', 'Архив']
    ];
    return { text: csvFromRows(rows, ';'), encoding: 'UTF-8', name: 'minimal_3_kolonki.csv' };
  }

  function buildEdge() {
    var t = todayUTC();
    var d = function (n) { return fmtDots(shift(t, n)); };
    var rows = [
      ['№', 'Клиент', 'Стадия', 'Сумма', 'Последний контакт', 'Комментарий менеджера'],
      ['С-2001', 'ООО «Ромашка»', 'Закрыт успешно', '480 000', d(-5), 'Всё хорошо'],
      ['С-2002', 'ИП Смирнов', 'Отказ', '96 000', d(-10), 'Клиент отказался'],
      ['С-2003', 'Школа №17', 'Архив', '320 000', d(-20), ''],
      ['С-2004', 'ООО «СпортМаркет»', 'Оплачено', '780 000', d(-3), 'Оплата пришла 100%'],
      ['С-2005', 'ООО «Гранит»', 'Выполнен', '154 000', d(-8), ''],
      ['С-2006', 'Фитнес «Ритм»', 'КП отправлено', '120 000', d(-6), 'Купили у конкурента, дешевле на 10%'],
      ['С-2007', 'ООО «Пик»', 'Согласование', '200 000', d(-4), 'Просили вернуться в марте, бюджет следующего года']
    ];
    return { text: csvFromRows(rows, ';'), encoding: 'UTF-8', name: 'vse_ne_dozhimat.csv', today: fmtIso(t) };
  }

  var DEMOS = {
    real: { label: 'Боевая: лист «Сделки», 40 сделок', build: buildReal },
    dirty: { label: 'Грязная: cp1251, «млн», даты текстом', build: buildDirty },
    minimal: { label: 'Минимальная: 3 колонки', build: buildMinimal },
    edge: { label: 'Крайняя: дожимать нечего', build: buildEdge }
  };

  root.TurnikEngine = {
    decodeBytes: decodeBytes,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    parseAmount: parseAmount,
    parseDate: parseDate,
    stepFromComment: stepFromComment,
    workingDaysSince: workingDaysSince,
    addWorkingDays: addWorkingDays,
    mapHeader: mapHeader,
    findHeaderRow: findHeaderRow,
    extractRecords: extractRecords,
    evaluate: evaluate,
    analyze: analyze,
    demos: DEMOS,
    rules: COMPANY_RULES,
    formatMoney: formatMoney,
    fmtDate: fmtDate,
    plural: plural
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ── интерфейс ──────────────────────────────────────── */

(function () {
  'use strict';

  if (typeof document === 'undefined') return; /* движок тестируется в Node без DOM */

  var Engine = (typeof globalThis !== 'undefined' ? globalThis : this).TurnikEngine;
  var el = {};
  var state = {
    name: '', encoding: '', parsed: null, today: null, sizeKb: 0,
    plan: 1550000
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function localTodayIso() {
    var n = new Date();
    return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate());
  }

  function isoToDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }

  function fmtDate(d) {
    return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function $(id) { return document.getElementById(id); }

  function init() {
    ['file', 'load', 'pick-file', 'file-status', 'file-name', 'today', 'plan', 'run',
      'reset', 'list', 'counter', 'summary', 'summary-nums', 'print',
      'print-date', 'others'
    ].forEach(function (id) {
      el[id.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] = $(id);
    });

    el.today.value = localTodayIso();
    el.plan.value = Engine.formatMoney(state.plan);

    el.load.addEventListener('click', fetchSheet);
    el.pickFile.addEventListener('click', function () {
      el.file.value = '';
      el.file.click();
    });

    el.file.addEventListener('change', function () {
      if (el.file.files && el.file.files[0]) readFile(el.file.files[0]);
    });

    /* Зоны-окна больше нет: файл можно бросить куда угодно на страницу. */
    ['dragenter', 'dragover'].forEach(function (type) {
      document.addEventListener(type, function (e) {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        document.body.classList.add('is-dragging');
      });
    });
    ['dragleave', 'dragend'].forEach(function (type) {
      document.addEventListener(type, function () { document.body.classList.remove('is-dragging'); });
    });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      document.body.classList.remove('is-dragging');
      readFile(e.dataTransfer.files[0]);
    });

    el.run.addEventListener('click', run);
    el.reset.addEventListener('click', reset);
    el.print.addEventListener('click', printResult);

    el.today.addEventListener('change', function () {
      if (state.parsed) run();
    });
    el.plan.addEventListener('change', function () {
      state.plan = Engine.parseAmount(el.plan.value) || 0;
      if (state.parsed) run();
    });
  }

  /* ── загрузка ───────────────────────────────────────── */

  var SHEET_ID = '1-IMz283RylHMfqthH2Wl-aGPery_kxUT8ZvTIw7YObM';
  var SHEET_GID = '1239697447'; /* вторая вкладка — лист «Сделки» */
  var SHEET_CSV = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
    '/export?format=csv&gid=' + SHEET_GID;
  var SHEET_JSONP = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
    '/gviz/tq?gid=' + SHEET_GID + '&tqx=out:json;responseHandler:';

  /* Moonshot AI не отдаёт CORS-заголовок на /export, поэтому прямой fetch из браузера
     не проходит. JSONP-режим (/gviz/tq ... responseHandler) грузится тегом <script> и
     CORS не трогает — это и есть основной канал чтения листа. */
  function loadViaJsonp(done) {
    var name = 'turnikJsonp' + Date.now();
    var tag = document.createElement('script');
    var timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      try { delete window[name]; } catch (e) { window[name] = null; }
      if (tag.parentNode) tag.parentNode.removeChild(tag);
    }

    window[name] = function (data) {
      cleanup();
      if (!data || data.status === 'error') {
        done(new Error(data && data.sup ? data.sup.message : 'таблица не вернула данные'));
        return;
      }
      done(null, data);
    };

    tag.onerror = function () { cleanup(); done(new Error('запрос к таблице заблокирован')); };
    timer = setTimeout(function () { cleanup(); done(new Error('таймаут 15 секунд')); }, 15000);
    tag.src = SHEET_JSONP + name + '&_=' + Date.now();
    document.head.appendChild(tag);
  }

  function csvCell(value) {
    var s = String(value == null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function gvizCellText(cell) {
    if (!cell) return '';
    if (cell.f != null && String(cell.f) !== '') return String(cell.f);
    var v = cell.v;
    if (v == null) return '';
    if (typeof v === 'string') {
      var m = v.match(/^Date\((\d+),(\d+),(\d+)/);
      if (m) return pad2(+m[3]) + '.' + pad2(+m[2] + 1) + '.' + m[1];
    }
    if (typeof v === 'number') return String(v);
    return String(v);
  }

  function tableToCsv(data) {
    var cols = data.table.cols || [];
    var rows = data.table.rows || [];
    var lines = [cols.map(function (c) { return csvCell(c.label || ''); }).join(',')];

    rows.forEach(function (row) {
      var cells = row.c || [];
      var line = [];
      for (var i = 0; i < cells.length; i++) line.push(csvCell(gvizCellText(cells[i])));
      lines.push(line.join(','));
    });

    return lines.join('\r\n');
  }

  function fetchSheet() {
    el.load.disabled = true;
    setStatus('Читаю лист «Сделки» из таблицы…', false, false);

    loadViaJsonp(function (err, data) {
      if (!err) {
        var csv = tableToCsv(data);
        var buffer = new TextEncoder().encode(csv).buffer;
        el.load.disabled = false;
        if (!setData(buffer, 'лист «Сделки» из таблицы')) return;
        run();
        return;
      }

      /* Запасной канал: прямой CSV-запрос — проходит, если таблицу откроют с CORS. */
      fetch(SHEET_CSV + '&_=' + Date.now(), { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('таблица ответила ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (buf) {
          el.load.disabled = false;
          if (!setData(buf, 'лист «Сделки» из таблицы')) return;
          run();
        })
        .catch(function (err2) {
          el.load.disabled = false;
          setStatus('Таблица не открылась: ' + (err.message || 'нет доступа'), true, true);
          showNotice(
            '<p>Лист «Сделки» не читается: ' + esc(err.message) + '.</p>' +
            '<p class="drop-hint">Проверь, что у таблицы открыт доступ «все, у кого есть ссылка», ' +
            'и что это вторая вкладка — лист «Сделки». Если доступ есть, но запрос блокируется, ' +
            'скачай CSV <a href="' + SHEET_CSV + '" target="_blank" rel="noopener">ссылкой</a> ' +
            'и подставь файл кнопкой «Выбрать файл».</p>'
          );
        });
    });
  }

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      if (setData(reader.result, file.name)) run();
    };
    reader.onerror = function () {
      setStatus('Файл не читается', true, true);
      showNotice('<p>Файл не удалось прочитать. Попробуйте другой CSV из листа «Сделки».</p>');
    };
    reader.readAsArrayBuffer(file);
  }

  function setData(buffer, name) {
    var decoded = Engine.decodeBytes(buffer);
    var text = decoded.text.replace(/^\uFEFF/, '');
    var delim = Engine.detectDelimiter(text);
    var rows = Engine.parseCsv(text, delim);
    var headerIndex = Engine.findHeaderRow(rows);

    if (headerIndex < 0) {
      state.parsed = null;
      el.run.disabled = true;
      setStatus(name + ' — шапка не найдена', true, true);
      showNotice('<p>В файле нет строки с названиями колонок.</p>' +
        '<p class="drop-hint">Нужна выгрузка листа «Сделки»: Файл → Скачать → CSV.</p>');
      return false;
    }

    var parsed = Engine.extractRecords(rows, headerIndex);

    state.name = name;
    state.encoding = decoded.encoding;
    state.sizeKb = buffer.byteLength / 1024;
    state.parsed = {
      header: parsed.header,
      map: parsed.map,
      records: parsed.records,
      skipped: parsed.skipped,
      rowCount: rows.length,
      headerIndex: headerIndex,
      delim: delim
    };

    setStatus(name + ' · ' + parsed.records.length + ' ' +
      Engine.plural(parsed.records.length, 'сделка', 'сделки', 'сделок') + ' · ' + decoded.encoding, false, false);
    el.run.disabled = false;
    return true;
  }

  function setStatus(text, isError, showPick) {
    el.fileName.textContent = text;
    el.fileStatus.hidden = false;
    el.fileStatus.className = 'file-status' + (isError ? ' is-error' : '');
    el.pickFile.hidden = !showPick;
  }

  function showNotice(html) {
    el.list.innerHTML = '<div class="empty">' + html + '</div>';
  }

  /* ── запуск и вывод ─────────────────────────────────── */

  function run() {
    if (!state.parsed) return;
    var today = isoToDate(el.today.value);
    if (!today) {
      el.today.value = localTodayIso();
      today = isoToDate(el.today.value);
    }
    state.today = today;
    state.plan = Engine.parseAmount(el.plan.value) || 0;
    el.printDate.textContent = 'за ' + fmtDate(today) + ' · план ' + Engine.formatMoney(state.plan) + ' ₽';
    renderResult(Engine.analyze(state.parsed.records, today, state.plan));
  }

  function renderResult(res) {
    el.list.innerHTML = '';
    el.counter.textContent = 'в выгрузке ' + res.total + ' ' +
      Engine.plural(res.total, 'сделка', 'сделки', 'сделок') +
      ' · кандидатов на сегодня ' + res.candidates.length +
      ' · отложено ' + res.parked.length +
      ' · вне игры ' + res.dead.length;

    if (!res.picked.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '<p>Дожимать сегодня нечего: все сделки закрыты, отложены клиентом или требуют решения руководителя.</p>' +
        '<p class="drop-hint">Ниже список причин по каждой сделке.</p>';
      el.list.appendChild(empty);
      el.summary.hidden = true;
      renderOthers(res);
      return;
    }

    res.picked.forEach(function (deal, index) {
      var card = document.createElement('article');
      card.className = 'card' +
        (deal.unsure ? ' is-unsure' : '') +
        (deal.overdueDays > 0 ? ' is-late' : '');
      card.innerHTML = cardHtml(deal, index + 1);
      el.list.appendChild(card);
    });

    el.summaryNums.textContent = 'Итог: ' + res.picked.map(function (d) { return d.id; }).join(', ');
    el.summary.hidden = false;
    renderOthers(res);
  }

  function renderOthers(res) {
    var groups = [
      { key: 'rest', title: 'Ближайшие после пятёрки', items: res.rest, detail: true },
      { key: 'escalation', title: 'Нужно решение руководителя', items: res.escalation },
      { key: 'unsure', title: 'Не уверен, что делать', items: res.unsureList },
      { key: 'parked', title: 'Отложено', items: res.parked },
      { key: 'dead', title: 'Вне игры', items: res.dead }
    ];
    var html = '';

    groups.forEach(function (group) {
      if (!group.items.length) return;
      html += '<div class="bucket" data-key="' + group.key + '"><div class="bucket-title">' +
        esc(group.title) + '<span class="bucket-count">' + group.items.length + '</span></div><ul>';
      group.items.forEach(function (d) {
        html += '<li><b>№' + esc(d.id) + '</b> ' + esc(d.client || 'клиент не указан');
        if (group.detail) {
          html += ' — деньги ~' + d.daysToMoney + ' дн., ' + d.score + ' баллов' +
            (d.unsure ? ', шаг под вопросом' : '');
        } else {
          html += ' — ' + esc(d.reason);
        }
        html += '</li>';
      });
      html += '</ul></div>';
    });

    el.others.innerHTML = html;
    el.others.hidden = !html;
  }

  function cardHtml(deal, rank) {
    var hasAmount = Number.isFinite(deal.amount) && deal.amount > 0;
    var amountHtml = hasAmount
      ? Engine.formatMoney(deal.amount) + ' ₽<small>сумма</small>'
      : '—<small>сумма не указана</small>';

    var who = [deal.clientType, deal.product].filter(Boolean).join(' · ');
    var next = [];

    if (deal.step) {
      next.push('Шаг в выгрузке: ' + esc(deal.step) +
        (deal.nextDate ? ' (от ' + fmtDate(deal.nextDate) + ')' : ' (дата не указана)'));
      if (deal.overdueDays > 0) {
        next.push('<b>просрочен на ' + deal.overdueDays + ' ' +
          Engine.plural(deal.overdueDays, 'день', 'дня', 'дней') + '</b>');
      } else if (deal.aheadDays != null && deal.aheadDays > 0) {
        next.push('срок через ' + deal.aheadDays + ' ' +
          Engine.plural(deal.aheadDays, 'день', 'дня', 'дней'));
      } else if (deal.nextDate) {
        next.push('<b>срок сегодня</b>');
      }
    }

    if (deal.daysToMoney != null) {
      next.push('деньги примерно через <b>' + deal.daysToMoney + ' ' +
        Engine.plural(deal.daysToMoney, 'день', 'дня', 'дней') + '</b>');
    }

    if (deal.lastContact && deal.silence != null) {
      next.push('контакт ' + fmtDate(deal.lastContact) + ' — ' +
        Math.max(0, deal.silence) + ' ' + Engine.plural(Math.max(0, deal.silence), 'день', 'дня', 'дней') + ' назад');
    }

    var tags = deal.tags.map(function (tag) {
      var cls = 'tag' + (tag.kind === 'late' ? ' tag-late' : tag.kind === 'hot' ? ' tag-hot' : '');
      return '<span class="' + cls + '">' + esc(tag.text) + '</span>';
    }).join('');
    tags += '<span class="tag">' + (deal.score > 0 ? '+' : '') + deal.score + ' ' +
      Engine.plural(deal.score, 'балл', 'балла', 'баллов') + '</span>';

    var actionText = deal.unsure ? deal.reason : (deal.action || deal.step);

    return '' +
      '<div class="card-rank">' + rank + '</div>' +
      '<div class="card-main">' +
        '<div class="card-id">№ ' + esc(deal.id) + (who ? ' · ' + esc(who) : '') + '</div>' +
        '<div class="card-client">' + esc(deal.client || 'Клиент не указан') + '</div>' +
        '<div class="card-stage">' + esc(deal.stage || 'стадия не указана') + '</div>' +
      '</div>' +
      '<div class="card-amount">' + amountHtml + '</div>' +
      '<div class="card-action"><span class="card-action-label">' +
        (deal.unsure ? 'Не уверен, что делать' : 'Что сделать сегодня') + '</span>' +
        esc(actionText) + '</div>' +
      (next.length ? '<div class="card-next">' + next.join(' · ') + '</div>' : '') +
      '<div class="card-why">' + tags + '</div>';
  }

  /* ── сброс, фильтры, печать ─────────────────────────── */

  function emptyHtml() {
    return '<div class="empty"><div class="empty-mark" aria-hidden="true">' +
      '<svg viewBox="0 0 64 64" width="72" height="72" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
      '<path d="M8 40h48M8 24h48"/><circle cx="16" cy="32" r="8"/><circle cx="48" cy="32" r="8"/><path d="M24 32h16"/></svg>' +
      '</div><p>Пока пусто. Нажмите «Загрузить/обновить CSV» — программа возьмёт лист «Сделки» прямо из таблицы.</p></div>';
  }

  function reset() {
    state.parsed = null;
    state.name = '';
    state.encoding = '';

    el.file.value = '';
    el.run.disabled = true;
    el.fileStatus.hidden = true;
    el.fileStatus.className = 'file-status';
    el.fileName.textContent = '';
    el.pickFile.hidden = true;
    el.list.innerHTML = emptyHtml();
    el.counter.textContent = '';
    el.summary.hidden = true;
    el.summaryNums.textContent = '';
    el.others.innerHTML = '';
    el.others.hidden = true;
  }

  function printResult() {
    if (!state.parsed) return;
    run();
    window.print();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
