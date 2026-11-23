import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  trimValues: false,
});
const many = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const clean = (value) => String(value ?? '').trim();
const plain = (value) => typeof value === 'object' ? value?.['#text'] ?? '' : value ?? '';
const text = (entry) => clean(entry?.t === undefined
  ? many(entry?.r).map(({t}) => plain(t)).join('')
  : plain(entry.t));
const publishable = (value, max = 200) => {
  const s = clean(value);
  return s.length <= max && !/(?:https?:\/\/|www\.|\S+@\S+|(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2})/i.test(s)
    ? s : '';
};

export function normalize(value) {
  return clean(value).normalize('NFKC').toLowerCase().replaceAll('ё', 'е')
    .replace(/[^а-яa-z0-9]+/gi, ' ').trim();
}
const locationName = (value) => normalize(value.replace(/\s*[-–—]?\s*(?:ак|[сc])$/i, ''));
const aliasesOf = (name) => [name, name.replace(/\([^()]+\)/g, '').trim(),
  ...[...name.matchAll(/\(([^()]+)\)/g)].map((m) => m[1])];

function addressKey(value) {
  return normalize(value.replace(/\([^()]*этаж[^()]*\)/gi,''))
    .replace(/(?:^| )(?:москва|г|улица|ул|дом|д)(?= |$)/g,' ')
    .replace(/(?:^| )(?:корпус|корп|к) *(?=\d)/g,'к')
    .replace(/(?:^| )(?:строение|стр|с) *(?=\d)/g,'с')
    .replace(/ +/g,' ').trim();
}

function readWorkbook(bytes, sheetName = 'Переезды') {
  const docs = unzipSync(new Uint8Array(bytes), {filter: ({name, originalSize}) =>
    originalSize < 12_000_000 && /^xl\/(?:workbook|sharedStrings|styles|worksheets\/sheet1)\.xml$/.test(name)});
  const get = (name) => xml.parse(strFromU8(docs['xl/' + name + '.xml']));
  const sheets = many(get('workbook').workbook.sheets.sheet);
  if (sheets.length !== 1 || sheets[0]['@name'] !== sheetName) throw new Error('unexpected workbook');
  const strings = many(docs['xl/sharedStrings.xml'] ? get('sharedStrings').sst.si : []).map(text);
  const style = get('styles').styleSheet;
  const fills = many(style.fills.fill);
  const styles = many(style.cellXfs.xf);
  const value = (cell) => !cell ? '' : cell['@t'] === 's' ? strings[Number(cell.v)]
    : cell['@t'] === 'inlineStr' ? text(cell.is) : clean(cell.v);

  return many(get('worksheets/sheet1').worksheet.sheetData.row).map((row) => {
    const cells = Object.fromEntries(many(row.c).map((cell) => [cell['@r'].replace(/\d+$/, ''), cell]));
    const fill = fills[Number(styles[Number(cells.B?.['@s'] ?? 0)]?.['@fillId'] ?? 0)]?.patternFill;
    const color = fill?.patternType === 'solid' || fill?.['@patternType'] === 'solid'
      ? fill?.fgColor?.['@rgb']?.slice(-6).toUpperCase() ?? '?' : '';
    return {value: (col) => value(cells[col]), color};
  });
}

export function parseAcceptance(bytes) {
  const [header,...rows] = readWorkbook(bytes,'Приём по отделениям');
  const columns = ['A','B','C','D','E','F'];
  const titles = ['Отделение','Адрес','Базовые категории','Расширенные категории','Источник','Проверено'];
  if (columns.some((col,i) => header?.value(col) !== titles[i])) throw new Error('unexpected acceptance columns');
  const categories = (s) => [...new Set(clean(s).split(/[;\r\n]+/).map((x) => publishable(x,150)).filter(Boolean))];
  const accepted = new Map();
  for (const {value} of rows) {
    const name = publishable(value('A'),150);
    const address = publishable(value('B'),350);
    const basic = categories(value('C'));
    const extra = categories(value('D'));
    if (!name || !address || (!basic.length && !extra.length)) continue;
    const url = clean(value('E'));
    const source = /^https:\/\/(?:www\.)?mosgorlombard\.ru\/o-kompanii\/contacts\/[a-z0-9_-]+\/?$/i.test(url) ? url : '';
    const date = clean(value('F')).replace(/^(\d{2})\.(\d{2})\.(\d{4})$/,'$3-$2-$1');
    const checkedOn = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
    const key = branchKey({name,address});
    if (accepted.has(key)) throw new Error('duplicate branch acceptance row');
    accepted.set(key,{basic,extra,source,checkedOn});
  }
  return accepted;
}

export const branchKey = ({name,address}) => JSON.stringify([name,address]);

function classify(note, color, dateLabel) {
  const s = normalize(note);
  const [day, month, year] = dateLabel.split('.');
  const planned = day && new Date(Date.UTC(2000 + Number(year.slice(-2)), Number(month) - 1, Number(day)))
    .toISOString().slice(0, 10) > new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow'}).format();
  if (/под вопросом|уточн|возможен переезд/.test(s) || color === 'DCDFE4') return 'review';
  if (/закрыт[аоы]?|ликвидирован/.test(s) && !/не закрыт|временно|переезд|переехал/.test(s)) return 'closed';
  if (planned || ['FCE8B2', 'FCE5CD', 'FFD966', 'F9CB9C', 'FF9900'].includes(color)
    || /собирается переезжать|планируется переезд/.test(s)) return 'planned';
  if (color === 'DCF2DC' || /переезд|переехал/.test(s)) return 'moved';
  if (!color || color === 'FFFFFF') return note ? 'review' : 'active';
  return 'review';
}

function relocationSteps(note, date) {
  const steps = [];
  let currentDate = date;
  for (const line of note.split(/\r?\n/)) {
    const lineDate = line.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/)?.[0];
    if (lineDate) currentDate = lineDate;
    const kind = /мех|техник|ювелир|витрина|залоги/i.exec(line);
    const category = kind?.index === undefined ? '' : /^мех/i.test(kind[0])
      ? (/техник/i.test(line) ? 'Меховые изделия и техника' : 'Меховые изделия')
      : /^ювелир/i.test(kind[0]) ? (/техник/i.test(line) ? 'Ювелирные изделия и техника' : 'Ювелирные изделия')
      : /^витрина/i.test(kind[0]) ? 'Витрина' : /^техник/i.test(kind[0]) ? 'Техника' : 'Залоги';
    let part = line.replace(/^\s*\d+\.\s+(?=[а-я])/i, '').trim();
    const hasDestination = /(?:переезд|переехал)/i.test(part) || /^.+?\s+[–—-]\s+/.test(part);
    if (!hasDestination || /возможен переезд|под вопросом/.test(part.toLowerCase())) continue;
    const lo = part.match(/(?:^|\s)(?:в|на)\s+(?:ЛО\s+)?(?=[а-я0-9])/i);
    if (lo) part = part.slice(lo.index + lo[0].length);
    else if (/^.+?\s+[–—-]\s+/.test(part)) part = part.replace(/^.+?\s+[–—-]\s+/, '');
    else continue;

    part = part.replace(/^Мосгорломбард\s+/i, '').replace(/,\s*\(/, ' (');
    const marker = part.search(/\s*\((?=(?:г\.|москва|московская|ул\.|[а-яё]+(?:,|\sул\.)|\d))/i);
    const colon = part.search(/\s+по адресу\s*:/i);
    const boundary = Math.min(marker < 0 ? Infinity : marker, colon < 0 ? Infinity : colon);
    const tail = Number.isFinite(boundary) ? part.slice(boundary).trim() : '';
    const address = publishable(tail.startsWith('(')
      ? tail.replace(/^\(/, '').replace(/\)\.?$/, '')
      : tail.replace(/^по адресу\s*:\s*/i, ''));
    const head = (Number.isFinite(boundary) ? part.slice(0, boundary) : part).trim().replace(/[.,:]$/, '');
    for (const chunk of head.split(/\s*\/\s*/)) {
      const name = publishable(chunk, 90);
      if (!name || !/^(?:[а-яё0-9][а-яё0-9 .()–—-]{1,88})$/i.test(name) || /пишем|письмо|звонить|ранее|уточн/i.test(name)) continue;
      steps.push({name, address, date: currentDate, category});
    }
  }
  return steps;
}

export function parseDirectory(bytes, coordinates = {}) {
  const rows = readWorkbook(bytes);
  const entries = [];
  let type = 'Ломбард';
  let hasHeader = false;
  for (const {value, color} of rows) {
    if (/^вывеска.*ресейл маркет/i.test(value('A'))) type = 'Ресейл Маркет';
    if (value('B') === 'Ломбард' && value('F') === 'Адрес ЛО') hasHeader = true;
    if (!/^\d+(?:\.0+)?$/.test(value('A'))) continue;
    const name = publishable(value('B'), 150);
    if (!name) continue;
    const address = publishable(value('F'), 350);
    const note = clean(value('G'));
    const goldLetterRequired = note.split(/\r?\n/).some((line) =>
      /(?:ювелирные изделия|по золоту)\s*[:–—-]?\s*(?:пишем|(?:нужно|необходимо)\s+(?:писать|написать|отправить))\s+письмо(?:[.,;! ]|$)/i.test(line.trim()));
    const date = note.match(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/)?.[0] ?? '';
    const status = classify(note, color, date);
    const point = status === 'active' ? coordinates[address]?.point ?? null : null;
    const metro = publishable(value('E'), 120);
    const hours = status === 'active' || status === 'planned' ? publishable(value('D'), 120) : '';
    const steps = ['moved', 'planned'].includes(status) ? relocationSteps(note, date) : [];
    entries.push({id: String(entries.length + 1), name, address, metro, hours, type, status, date, point, steps, goldLetterRequired});
  }
  if (!hasHeader || !entries.length) throw new Error('unexpected directory columns or empty directory');
  const targets = new Map();
  for (const item of entries) {
    for (const alias of new Set(aliasesOf(item.name).flatMap((name) => [normalize(name), locationName(name)]))) {
      if (!targets.has(alias)) targets.set(alias, []);
      targets.get(alias).push(item);
    }
  }
  for (const item of entries) {
    for (const step of item.steps) {
      const keys = [normalize(step.name), locationName(step.name.replace(/\([^()]+\)/g, ''))];
      const candidates = (targets.get(keys[0]) ?? targets.get(keys[1]) ?? []).filter(({id}) => id !== item.id);
      const key = step.address && addressKey(step.address);
      const matchingAddress = key ? (candidates.length ? candidates : entries).filter((r) =>
        r.id !== item.id && r.address && addressKey(r.address) === key) : [];
      const target = candidates.length === 1 ? candidates[0] : matchingAddress.length === 1 ? matchingAddress[0] : null;
      if (!target) continue;
      step.id = target.id;
      step.name = target.name;
      step.address ||= target.address;
    }
    item.steps = item.steps.filter((step, i, all) =>
      !all.slice(0,i).some((a) => a.id === step.id && a.name === step.name && a.date === step.date &&
        a.category === step.category && a.address === step.address));
  }
  return entries;
}
