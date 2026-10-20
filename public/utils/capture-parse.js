/**
 * Modul: Capture parser (Tafla global capture, "Szybkie dodawanie")
 * Zweck: Reads one line of free text ("jutro 18 fryzjer Ola", "mleko, jajka,
 *        masło") into a typed draft - date, time, assignee, meal slot,
 *        shopping items - with local rules only. Pure: no DOM, no i18n, no
 *        network; deterministic for a given `now`. Polish first, English second.
 *        The sheet (utils/capture-sheet.js) renders labels and saves; AI may
 *        later look at `leftover`, but saving never waits for it.
 * Ausfuehren der Tests: node --test test/test-capture-parse.js
 *
 * Decisions worth knowing (each one is pinned by a test):
 *   - A weekday names the NEXT such day. Named on the same weekday it means
 *     today only when a time later than `now` is given ("w poniedziałek o 18"
 *     on a Monday at noon), otherwise the same weekday next week.
 *   - "next"/"przyszły" adds a week when the day would still fall in the
 *     current week (weeks start on `weekStart`, Monday by default).
 *   - A date without a year that already passed this year rolls to next year.
 *   - A bare number is a time only with a marker ("o 18", "at 6"), an am/pm or
 *     "h" suffix, a colon, or right next to a date word ("jutro 18"). So
 *     "2 mleka" stays an amount, and "15.11" is a date unless written "o 15.11".
 *   - Auto type: a meal word wins (meal), then a list without date/time
 *     (shopping), then a time (event), then a known dish with a date (meal,
 *     dinner by default), then a date (task), then a single grocery or an
 *     amount with a unit / a grocery after a number (shopping), else task.
 *     'note' is never inferred.
 *   - Explicit 'note' keeps the text as it is (no date words removed).
 *     Explicit 'shopping' only reads members and amounts - "jutro" in a
 *     shopping line stays part of the item.
 *   - For 'meal' without a meal word the slot defaults to 'dinner'.
 *   - Callers pass only real household members (not the wall display account):
 *     a member called "Kuchnia" would match "kuchnię".
 */

export const CAPTURE_TYPES = ['task', 'event', 'shopping', 'meal', 'note'];

// ── Text folding ────────────────────────────────────────────────────────────

/** Lower-case, strip diacritics (ł too), unify dashes. */
function fold(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/[–—]/g, '-');
}

/** Folded token without surrounding quotes/brackets/sentence punctuation. */
function normToken(raw) {
  return fold(raw)
    .replace(/^[("'„“”«»‚‘’[]+/, '')
    .replace(/[)"'„“”«»‚‘’\]!?.:…]+$/, '');
}

function upperFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// A comma is a decimal mark only between two digits ("1,5 kg").
const SEPARATOR = /\r?\n|;|,(?!\d)|(?<!\d),/;
const TOKEN_RE = /(\r?\n|;|,(?!\d)|(?<!\d),)|((?:[^\s,;]|(?<=\d),(?=\d))+)/g;

function tokenize(text) {
  const tokens = [];
  let seg = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    if (m[1]) { seg += 1; continue; }
    const raw = m[2];
    let norm = normToken(raw);
    const at = norm.startsWith('@');
    if (at) norm = norm.slice(1);
    tokens.push({ raw, start: m.index, end: m.index + raw.length, norm, at, seg, used: false });
  }
  return tokens;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function validDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** Day/month without a year: this year, or next year once it has passed. */
function upcoming(now, m, d, y = null) {
  if (y != null) return validDate(y, m, d);
  const today = dayStart(now);
  const thisYear = validDate(today.getFullYear(), m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(today.getFullYear() + 1, m, d) ?? thisYear;
}

const RELATIVE_DAYS = {
  dzis: 0, dzisiaj: 0, today: 0, tonight: 0,
  jutro: 1, jutra: 1, tomorrow: 1, tmrw: 1,
  pojutrze: 2,
};

// getDay(): 0 = Sunday … 6 = Saturday.
const WEEKDAYS = {
  poniedzialek: 1, poniedzialku: 1, pon: 1, pn: 1,
  wtorek: 2, wtorku: 2, wt: 2, wto: 2,
  sroda: 3, srode: 3, srody: 3, sr: 3, sro: 3,
  czwartek: 4, czwartku: 4, czw: 4, cz: 4,
  piatek: 5, piatku: 5, pt: 5, pia: 5,
  sobota: 6, sobote: 6, soboty: 6, sob: 6, so: 6,
  niedziela: 0, niedziele: 0, niedzieli: 0, niedz: 0, nd: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 0, sun: 0,
};
// Abbreviations that are also ordinary words: only with a prefix or a time.
const AMBIGUOUS_WEEKDAYS = new Set(['so', 'sun']);

const NEXT_WORDS = new Set(['next', 'przyszly', 'przyszla', 'przyszle', 'przyszlym', 'kolejny', 'kolejna']);
const THIS_WORDS = new Set(['this', 'ten', 'ta', 'te']);
const DATE_CONNECTORS = new Set(['w', 'we', 'na', 'on', 'do', 'by', 'for', 'until']);

const MONTHS = {
  styczen: 1, stycznia: 1, sty: 1, january: 1, jan: 1,
  luty: 2, lutego: 2, lut: 2, february: 2, feb: 2,
  marzec: 3, marca: 3, mar: 3, march: 3,
  kwiecien: 4, kwietnia: 4, kwi: 4, april: 4, apr: 4,
  maj: 5, maja: 5, may: 5,
  czerwiec: 6, czerwca: 6, cze: 6, june: 6, jun: 6,
  lipiec: 7, lipca: 7, lip: 7, july: 7, jul: 7,
  sierpien: 8, sierpnia: 8, sie: 8, august: 8, aug: 8,
  wrzesien: 9, wrzesnia: 9, wrz: 9, september: 9, sep: 9, sept: 9,
  pazdziernik: 10, pazdziernika: 10, paz: 10, october: 10, oct: 10,
  listopad: 11, listopada: 11, lis: 11, november: 11, nov: 11,
  grudzien: 12, grudnia: 12, gru: 12, december: 12, dec: 12,
};

const NUMBER_WORDS = {
  jeden: 1, jedna: 1, jednego: 1, dwa: 2, dwie: 2, dwoch: 2, trzy: 3, trzech: 3, cztery: 4, czterech: 4,
  piec: 5, pieciu: 5, szesc: 6, szesciu: 6, siedem: 7, siedmiu: 7,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};
const DAY_UNITS = new Set(['dzien', 'dnia', 'dni', 'day', 'days']);
const WEEK_UNITS = new Set(['tydzien', 'tygodnia', 'tygodnie', 'tygodni', 'week', 'weeks']);

const NUM_DATE_RE = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/;
const DAY_NUM_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/;

// ── Times ───────────────────────────────────────────────────────────────────

const TIME_MARKERS = new Set(['o', 'at', 'godz', 'godzina', 'godzinie', 'ok', 'okolo', 'around', 'od', 'from']);
const RANGE_WORDS = new Set(['-', 'do', 'to', 'until', 'till']);
const CLOCK_RE = /^(\d{1,2})(?:([:.])(\d{2}))?(am|pm|a\.m|p\.m|h)?$/;
const RANGE_RE = /^(\d{1,2}(?:[:.]\d{2})?)-(\d{1,2}(?:[:.]\d{2})?)(am|pm)?$/;
const MERIDIEM_RE = /^(am|pm|a\.m|p\.m)$/;

const UNIT_ALIASES = {
  g: 'g', gram: 'g', gramy: 'g', gramow: 'g', grams: 'g',
  kg: 'kg', dag: 'dag', dkg: 'dag',
  ml: 'ml', l: 'l', litr: 'l', litry: 'l', litrow: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  szt: 'szt', sztuk: 'szt', sztuki: 'szt', sztuka: 'szt',
  op: 'op', opak: 'opak', opakowanie: 'opak', opakowania: 'opak',
  pcs: 'pcs', pc: 'pcs', pack: 'pack', packs: 'pack',
  x: null,
};
// A bare "x" after a number is too common a letter to veto a date or a time.
const isUnitWord = (norm) => norm !== 'x' && Object.prototype.hasOwnProperty.call(UNIT_ALIASES, norm);

/** "18", "18:30", "6pm" -> { h, m, sep, suffix } (h not yet converted). */
function parseClock(str, suffixOverride = null) {
  const m = CLOCK_RE.exec(str);
  if (!m) return null;
  return {
    h: Number(m[1]),
    m: m[3] != null ? Number(m[3]) : 0,
    sep: m[2] || null,
    suffix: (m[4] || suffixOverride || '').replace(/\./g, '') || null,
  };
}

/** Converted 'HH:MM' or null when out of range. */
function clockValue(c) {
  if (!c || c.m > 59) return null;
  let h = c.h;
  if (c.suffix === 'am' || c.suffix === 'pm') {
    if (h < 1 || h > 12) return null;
    h = c.suffix === 'pm' ? (h % 12) + 12 : h % 12;
  } else if (h > 23) {
    return null;
  }
  return `${pad2(h)}:${pad2(c.m)}`;
}

/** One clock at token i, with an am/pm word that may follow it. */
function readClock(tokens, i) {
  const t = tokens[i];
  if (!t || t.used) return null;
  const c = parseClock(t.norm);
  if (!c) return null;
  let len = 1;
  const next = tokens[i + 1];
  if (!c.suffix && next && !next.used && MERIDIEM_RE.test(next.norm)) {
    c.suffix = next.norm.replace(/\./g, '');
    len = 2;
  }
  return { c, len };
}

/**
 * A time expression starting at token i: markers, a clock or a range.
 * `clear` says whether it reads as a time without a neighbouring date word.
 */
function readTimeExpr(tokens, i) {
  let j = i;
  let markers = 0;
  while (j < tokens.length && !tokens[j].used && TIME_MARKERS.has(tokens[j].norm) && markers < 3) {
    j += 1;
    markers += 1;
  }
  const t = tokens[j];
  if (!t || t.used) return null;

  const r = RANGE_RE.exec(t.norm);
  if (r) {
    const b = parseClock(r[2], r[3] || null);
    const a = parseClock(r[1], b?.suffix || null);
    const time = clockValue(a);
    const endTime = clockValue(b);
    if (!time || !endTime) return null;
    const clear = markers > 0 || Boolean(a.sep === ':' || b.sep === ':' || b.suffix);
    return { start: i, end: j + 1, time, endTime, clear };
  }

  const first = readClock(tokens, j);
  if (!first) return null;
  let end = j + first.len;
  let endClock = null;
  let rangeWord = null;
  const sepTok = tokens[end];
  if (sepTok && !sepTok.used && RANGE_WORDS.has(sepTok.norm)) {
    const second = readClock(tokens, end + 1);
    if (second) {
      endClock = second.c;
      rangeWord = sepTok.norm;
      end = end + 1 + second.len;
      if (!first.c.suffix && endClock.suffix && first.c.h <= endClock.h) first.c.suffix = endClock.suffix;
    }
  }
  const time = clockValue(first.c);
  if (!time) return null;
  const endTime = endClock ? clockValue(endClock) : null;
  if (endClock && !endTime) return null;
  const clear = markers > 0
    || first.c.sep === ':'
    || Boolean(first.c.suffix)
    || Boolean(endClock && (endClock.sep === ':' || endClock.suffix))
    || (rangeWord != null && rangeWord !== '-');
  return { start: i, end, time, endTime, clear };
}

// ── Meals, groceries, dishes ────────────────────────────────────────────────

const MEAL_WORDS = {
  sniadanie: 'breakfast', sniadania: 'breakfast', sniadaniu: 'breakfast', breakfast: 'breakfast',
  obiad: 'lunch', obiadu: 'lunch', obiadem: 'lunch', lunch: 'lunch', lunchu: 'lunch',
  kolacja: 'dinner', kolacje: 'dinner', kolacji: 'dinner', dinner: 'dinner', supper: 'dinner',
  przekaska: 'snack', przekaske: 'snack', przekaski: 'snack', podwieczorek: 'snack', podwieczorku: 'snack',
  snack: 'snack',
};
const MEAL_CONNECTORS = new Set(['na', 'for', 'do', 'to']);

const GROCERY_EXACT = new Set([
  'ser', 'sera', 'serek', 'serki', 'ryz', 'ryzu', 'maka', 'maki', 'cukier', 'cukru',
  'kawa', 'kawy', 'kawe', 'woda', 'wody', 'wode', 'sok', 'soki', 'soku', 'mieso', 'miesa',
  'sol', 'pieprz', 'piwo', 'piwa', 'wino', 'wina', 'platki', 'musli', 'olej', 'oleju',
  'milk', 'egg', 'eggs', 'bread', 'butter', 'cheese', 'yogurt', 'yoghurt', 'rice', 'flour',
  'sugar', 'coffee', 'tea', 'water', 'juice', 'chicken', 'meat', 'ham', 'pasta', 'cereal',
  'oil', 'salt', 'diapers', 'tissues', 'beer', 'wine',
]);
const GROCERY_PREFIXES = [
  'mlek', 'jaj', 'chleb', 'bulk', 'masl', 'jogurt', 'banan', 'jabl', 'pomidor', 'ziemniak',
  'cebul', 'makaron', 'herbat', 'kurczak', 'szynk', 'kielbas', 'parowk', 'smietan', 'twarog',
  'twaroz', 'margaryn', 'oliw', 'marchew', 'ogork', 'papryk', 'cytryn', 'pomarancz', 'winogron',
  'truskaw', 'pieczark', 'czosn', 'brokul', 'kapust', 'pieluch', 'chusteczk', 'mydl', 'szampon',
  'gabk', 'proszk', 'proszek', 'banana', 'apple', 'tomato', 'potato', 'onion', 'carrot', 'lemon',
];
const GROCERY_PHRASES = [
  'papier toaletowy', 'plyn do naczyn', 'pasta do zebow', 'reczniki papierowe', 'worki na smieci',
  'toilet paper', 'dish soap', 'paper towels', 'trash bags',
];
const DISH_PREFIXES = [
  'pizz', 'spaghetti', 'spagetti', 'pierog', 'zup', 'rosol', 'schabow', 'nalesnik', 'gulasz',
  'kotlet', 'burger', 'lasagn', 'curry', 'taco', 'risotto', 'bigos', 'golabk', 'plack', 'salatk',
  'omlet', 'jajecznic', 'kanapk', 'tortill', 'sushi', 'kebab', 'frytk', 'chili', 'ramen',
  'soup', 'stew', 'salad', 'steak', 'sandwich', 'omelet', 'pancake', 'roast',
];

function isGroceryPhrase(phrase) {
  const f = fold(phrase).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!f) return false;
  if (GROCERY_PHRASES.some((p) => f === p || f.startsWith(`${p} `))) return true;
  const word = f.split(' ')[0];
  return GROCERY_EXACT.has(word) || GROCERY_PREFIXES.some((p) => word.startsWith(p));
}

const isDishWord = (norm) => DISH_PREFIXES.some((p) => norm.startsWith(p));

// ── Members ─────────────────────────────────────────────────────────────────

/** Polish case endings a first name takes ("Wojtka", "Oli", "Tomaszem"). */
const NAME_ENDINGS = new Set(['a', 'i', 'y', 'e', 'o', 'u', 'ie', 'em', 'iem', 'om', 'owi']);

/** Whole-word name match with the common Polish case endings. */
function matchesName(token, name) {
  if (!token || !name) return false;
  if (token === name) return true;
  const endsWith = (stem) => token.startsWith(stem) && NAME_ENDINGS.has(token.slice(stem.length));
  // Adam -> Adama, Tomasz -> Tomaszem
  if (name.length >= 3 && endsWith(name)) return true;
  // Wojtek -> Wojtka, Wojtkowi, Wojtkiem (the mobile e)
  if (name.length >= 4 && name.endsWith('ek') && endsWith(`${name.slice(0, -2)}k`)) return true;
  // Mariola -> Marioli, Anna -> Annie, Ola -> Oli / Olą / Olę
  if (name.length >= 3 && /[aeiouy]$/.test(name) && endsWith(name.slice(0, -1))) return true;
  return false;
}

const PERSON_CONNECTORS = new Set(['dla', 'for', 'z', 'ze', 'with']);

/**
 * Everyday Polish forms of a first name, so "Ola" finds a member called
 * "Mariola" and "Wojtek" one called "Wojciech". Keys and values are folded
 * (lower case, no diacritics). Small on purpose: the household's own names
 * first, then the most common ones.
 */
const NICKNAMES = {
  mariola: ['ola'],
  aleksandra: ['ola', 'ala'],
  alicja: ['ala'],
  wojciech: ['wojtek'],
  katarzyna: ['kasia'],
  malgorzata: ['gosia', 'malgosia'],
  agnieszka: ['aga'],
  magdalena: ['magda'],
  joanna: ['asia'],
  barbara: ['basia'],
  elzbieta: ['ela'],
  krzysztof: ['krzys'],
  tomasz: ['tomek'],
  piotr: ['piotrek'],
  pawel: ['pawelek'],
  jakub: ['kuba'],
  aleksander: ['olek'],
  zofia: ['zosia'],
  jan: ['janek'],
};

/** A member's first name plus its everyday forms. */
function namesOf(first) {
  return [first, ...(NICKNAMES[first] ?? [])];
}

// ── Amounts ─────────────────────────────────────────────────────────────────

const NUM = '(\\d+(?:[.,]\\d+)?)';
const UNIT = '(g|kg|dag|dkg|ml|l|litry|litrow|litr|szt\\.?|sztuk[ia]?|op\\.?|opak\\.?|opakowani[ea]|pcs|pc|packs?|x|×)';
const LEAD_UNIT_RE = new RegExp(`^${NUM}\\s*${UNIT}(?=\\s|$)\\s*(.*)$`, 'iu');
const LEAD_X_RE = new RegExp(`^${NUM}\\s*(x|×)\\s*(.+)$`, 'iu');
const LEAD_NUM_RE = new RegExp(`^${NUM}\\s+(.+)$`, 'u');
const TRAIL_UNIT_RE = new RegExp(`^(.+?)\\s+${NUM}\\s*${UNIT}$`, 'iu');
const TRAIL_X_RE = new RegExp(`^(.+?)\\s+(?:(x|×)\\s*${NUM}|${NUM}\\s*(x|×))$`, 'iu');

function toNumber(s) {
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function unitOf(raw) {
  const key = fold(raw).replace(/\.$/, '').replace('×', 'x');
  return Object.prototype.hasOwnProperty.call(UNIT_ALIASES, key) ? UNIT_ALIASES[key] : null;
}

/**
 * "500 g mąki" -> { name: 'Mąki', quantity: 500, unit: 'g', amountText: '500 g', hasUnit: true }.
 * 'x' is a multiplier, so "2x chleb" has quantity 2 and unit null.
 */
function parseItem(segment) {
  const s = segment.trim();
  let m;
  if ((m = LEAD_X_RE.exec(s))) {
    return { name: m[3], quantity: toNumber(m[1]), unit: null, amountText: s.slice(0, s.length - m[3].length).trim(), hasUnit: true };
  }
  if ((m = LEAD_UNIT_RE.exec(s)) && m[3]) {
    return { name: m[3], quantity: toNumber(m[1]), unit: unitOf(m[2]), amountText: s.slice(0, s.length - m[3].length).trim(), hasUnit: true };
  }
  if ((m = TRAIL_UNIT_RE.exec(s))) {
    return { name: m[1], quantity: toNumber(m[2]), unit: unitOf(m[3]), amountText: s.slice(m[1].length).trim(), hasUnit: true };
  }
  if ((m = TRAIL_X_RE.exec(s))) {
    return { name: m[1], quantity: toNumber(m[3] ?? m[4]), unit: null, amountText: s.slice(m[1].length).trim(), hasUnit: true };
  }
  if ((m = LEAD_NUM_RE.exec(s))) {
    return { name: m[2], quantity: toNumber(m[1]), unit: null, amountText: m[1], hasUnit: false };
  }
  return { name: s, quantity: null, unit: null, amountText: null, hasUnit: false };
}

// ── Assembly ────────────────────────────────────────────────────────────────

function emptyResult(type) {
  return {
    type: type === 'auto' ? 'task' : type,
    inferred: type === 'auto',
    title: '',
    date: null,
    time: null,
    endTime: null,
    assignee: null,
    items: [],
    mealType: null,
    tokens: [],
    leftover: '',
  };
}

/** Source text with the used tokens cut out, tidied into a title. */
function remainder(text, tokens, from = 0, to = text.length) {
  let out = '';
  let pos = from;
  for (const t of tokens) {
    if (!t.used || t.end <= from || t.start >= to) continue;
    out += text.slice(pos, t.start);
    pos = t.end;
  }
  out += text.slice(pos, to);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.!?])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/^[\s,;:.\-–—]+|[\s,;:\-–—]+$/g, '')
    .trim();
}

function segmentsOf(text, splitAnd) {
  const out = [];
  const re = new RegExp(SEPARATOR.source, 'g');
  let pos = 0;
  let m;
  const push = (start, end) => {
    if (!splitAnd) { out.push([start, end]); return; }
    const part = text.slice(start, end);
    const andRe = /\s+(?:i|and|oraz)\s+/giu;
    let p = 0;
    let a;
    while ((a = andRe.exec(part))) {
      out.push([start + p, start + a.index]);
      p = a.index + a[0].length;
    }
    out.push([start + p, end]);
  };
  while ((m = re.exec(text))) {
    push(pos, m.index);
    pos = m.index + m[0].length;
  }
  push(pos, text.length);
  return out.filter(([s, e]) => text.slice(s, e).trim());
}

/**
 * @param {string} text
 * @param {{ now?: Date, members?: Array<{id:number, display_name:string}>,
 *           type?: 'auto'|'task'|'event'|'shopping'|'meal'|'note', weekStart?: number }} [opts]
 */
export function parseCapture(text, opts = {}) {
  const requested = CAPTURE_TYPES.includes(opts.type) ? opts.type : 'auto';
  try {
    return parse(String(text ?? ''), { ...opts, type: requested });
  } catch {
    return emptyResult(requested);
  }
}

function parse(text, { now = new Date(), members = [], type, weekStart = 1 }) {
  if (!text.trim()) return emptyResult(type);

  if (type === 'note') {
    const title = upperFirst(text.trim());
    return { ...emptyResult('note'), title, leftover: title };
  }

  const tokens = tokenize(text);
  const found = [];
  const use = (start, end, kind, value) => {
    for (let k = start; k < end; k++) tokens[k].used = true;
    found.push({ kind, value, startTok: start, endTok: end });
  };
  const free = (k) => tokens[k] && !tokens[k].used;
  const readsShopping = type === 'shopping';

  // 1. Times that read as times on their own.
  let timeMatch = null;
  if (!readsShopping) {
    for (let i = 0; i < tokens.length && !timeMatch; i++) {
      if (!free(i)) continue;
      const e = readTimeExpr(tokens, i);
      if (e?.clear && !(free(e.end) && isUnitWord(tokens[e.end].norm))) {
        timeMatch = e;
        use(e.start, e.end, 'time', { time: e.time, endTime: e.endTime });
      }
    }
  }

  // 2. Dates.
  let dateMatch = null;
  let weekday = null;
  const extendBack = (start, words, max = 3) => {
    let s = start;
    let next = false;
    let prefixed = false;
    while (s > 0 && free(s - 1) && start - s < max && words.has(tokens[s - 1].norm)) {
      s -= 1;
      prefixed = true;
      if (NEXT_WORDS.has(tokens[s].norm)) next = true;
    }
    return { s, next, prefixed };
  };
  const tryDate = (i) => {
    const t = tokens[i];
    const n = t.norm;
    const today = dayStart(now);
    if (n in RELATIVE_DAYS) return { end: i + 1, date: addDays(today, RELATIVE_DAYS[n]) };
    // "(the) day after tomorrow"
    if (n === 'day' || n === 'the') {
      const off = n === 'the' ? 1 : 0;
      if (tokens[i + off]?.norm === 'day' && tokens[i + off + 1]?.norm === 'after' && tokens[i + off + 2]?.norm === 'tomorrow'
        && free(i + off) && free(i + off + 1) && free(i + off + 2)) {
        return { end: i + off + 3, date: addDays(today, 2) };
      }
    }
    // "za 3 dni", "za tydzień", "in a week"
    if ((n === 'za' || n === 'in') && free(i + 1)) {
      const a = tokens[i + 1].norm;
      if (WEEK_UNITS.has(a)) return { end: i + 2, date: addDays(today, 7) };
      if (DAY_UNITS.has(a) && n === 'za') return { end: i + 2, date: addDays(today, 1) };
      const count = /^\d{1,3}$/.test(a) ? Number(a) : NUMBER_WORDS[a];
      const unit = free(i + 2) ? tokens[i + 2].norm : null;
      if (count != null && unit && DAY_UNITS.has(unit)) return { end: i + 3, date: addDays(today, count) };
      if (count != null && unit && WEEK_UNITS.has(unit)) return { end: i + 3, date: addDays(today, count * 7) };
    }
    // weekdays
    if (n in WEEKDAYS) {
      const back = extendBack(i, new Set([...DATE_CONNECTORS, ...NEXT_WORDS, ...THIS_WORDS]));
      const nextClock = free(i + 1) && CLOCK_RE.test(tokens[i + 1].norm);
      if (AMBIGUOUS_WEEKDAYS.has(n) && !back.prefixed && !nextClock) return null;
      return { start: back.s, end: i + 1, weekday: WEEKDAYS[n], next: back.next };
    }
    // 15.11, 15.11.2026, 15/11
    const nd = NUM_DATE_RE.exec(n);
    if (nd && !(free(i + 1) && isUnitWord(tokens[i + 1].norm))) {
      const y = nd[3] ? (nd[3].length === 2 ? 2000 + Number(nd[3]) : Number(nd[3])) : null;
      const date = upcoming(now, Number(nd[2]), Number(nd[1]), y);
      if (date) return { end: i + 1, date };
    }
    // 15 listopada (2026), 15th nov
    const dn = DAY_NUM_RE.exec(n);
    if (dn && free(i + 1) && tokens[i + 1].norm in MONTHS) {
      const yearTok = free(i + 2) && /^\d{4}$/.test(tokens[i + 2].norm) ? Number(tokens[i + 2].norm) : null;
      const date = upcoming(now, MONTHS[tokens[i + 1].norm], Number(dn[1]), yearTok);
      if (date) return { end: i + (yearTok ? 3 : 2), date };
    }
    // nov 15, november 15th
    if (n in MONTHS && free(i + 1)) {
      const d2 = DAY_NUM_RE.exec(tokens[i + 1].norm);
      if (d2) {
        const yearTok = free(i + 2) && /^\d{4}$/.test(tokens[i + 2].norm) ? Number(tokens[i + 2].norm) : null;
        const date = upcoming(now, MONTHS[n], Number(d2[1]), yearTok);
        if (date) return { end: i + (yearTok ? 3 : 2), date };
      }
    }
    return null;
  };
  if (!readsShopping) {
    for (let i = 0; i < tokens.length && !dateMatch; i++) {
      if (!free(i)) continue;
      const d = tryDate(i);
      if (!d) continue;
      let start = d.start ?? i;
      if (d.start == null) start = extendBack(i, DATE_CONNECTORS, 1).s;
      dateMatch = { start, end: d.end };
      if (d.weekday != null) {
        weekday = { dow: d.weekday, next: d.next };
        use(start, d.end, 'date', null);
      } else {
        use(start, d.end, 'date', dateKey(d.date));
      }
      // "wtorek 20.10", "15.11 sobota": a weekday next to an explicit date is
      // one date - the explicit one wins, and "20.10" is not read as a time.
      const more = free(d.end) ? tryDate(d.end) : null;
      if (more && (more.weekday != null) !== (d.weekday != null)) {
        const entry = found[found.length - 1];
        for (let k = d.end; k < more.end; k++) tokens[k].used = true;
        entry.endTok = more.end;
        dateMatch.end = more.end;
        if (more.weekday == null) {
          weekday = null;
          entry.value = dateKey(more.date);
        }
      }
    }
  }

  // 3. A bare clock right next to the date ("jutro 18", "pt 18:00").
  if (dateMatch && !timeMatch) {
    const after = readTimeExpr(tokens, dateMatch.end);
    // Not before a unit or a grocery: "jutro 2 kg", "jutro 2 mleka" are amounts.
    const blocked = (e) => free(e.end) && (isUnitWord(tokens[e.end].norm) || isGroceryPhrase(tokens[e.end].raw));
    if (after && !blocked(after)) {
      timeMatch = after;
    } else {
      for (const back of [1, 2]) {
        const before = dateMatch.start - back >= 0 ? readTimeExpr(tokens, dateMatch.start - back) : null;
        if (before && before.end === dateMatch.start) { timeMatch = before; break; }
      }
    }
    if (timeMatch) use(timeMatch.start, timeMatch.end, 'time', { time: timeMatch.time, endTime: timeMatch.endTime });
  }

  // 4. Members.
  let assignee = null;
  const people = (members || [])
    .map((m) => ({ id: m.id, name: m.display_name, first: fold(String(m.display_name || '').trim().split(/\s+/)[0] || '') }))
    .filter((m) => m.first);
  for (let i = 0; i < tokens.length && !assignee; i++) {
    if (!free(i)) continue;
    const hit = people.find((p) => namesOf(p.first).some((name) => matchesName(tokens[i].norm, name)));
    if (!hit) continue;
    assignee = { id: hit.id, name: hit.name };
    const start = tokens[i].at ? i : extendBack(i, PERSON_CONNECTORS, 1).s;
    use(start, i + 1, 'person', assignee);
  }

  // 5. Meal words.
  let mealType = null;
  if (!readsShopping) {
    for (let i = 0; i < tokens.length && !mealType; i++) {
      if (!free(i)) continue;
      const n = tokens[i].norm;
      let end = i + 1;
      if (n === 'drugie' && free(i + 1) && MEAL_WORDS[tokens[i + 1].norm] === 'breakfast') {
        mealType = 'snack';
        end = i + 2;
      } else if (MEAL_WORDS[n]) {
        mealType = MEAL_WORDS[n];
      } else {
        continue;
      }
      use(extendBack(i, MEAL_CONNECTORS, 1).s, end, 'meal', mealType);
    }
  }

  // Weekday needs the time: the same weekday is today only for a later time.
  let date = found.find((f) => f.kind === 'date')?.value ?? null;
  const time = timeMatch?.time ?? null;
  if (weekday) {
    const today = dayStart(now);
    const nowDow = today.getDay();
    let diff = (weekday.dow - nowDow + 7) % 7;
    if (diff === 0) {
      const nowHM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      diff = time && time > nowHM ? 0 : 7;
    }
    if (weekday.next) {
      const endOfWeek = (weekStart + 6) % 7;
      const daysToEnd = (endOfWeek - nowDow + 7) % 7;
      if (diff <= daysToEnd) diff += 7;
    }
    date = dateKey(addDays(today, diff));
    found.find((f) => f.kind === 'date').value = date;
  }

  // Type.
  const listSegments = segmentsOf(text, false);
  let resolved = type;
  let inferred = false;
  if (type === 'auto') {
    inferred = true;
    const free1 = remainder(text, tokens);
    const dish = tokens.some((t) => !t.used && isDishWord(t.norm));
    const single = parseItem(free1);
    if (mealType) resolved = 'meal';
    else if (listSegments.length >= 2 && !date && !time) resolved = 'shopping';
    else if (time) resolved = 'event';
    else if (date && dish) resolved = 'meal';
    else if (date) resolved = 'task';
    // One grocery ("mleko", "2 mleka") or an amount with a unit ("500 g mąki").
    else if (listSegments.length === 1 && (isGroceryPhrase(single.name) || (single.hasUnit && single.quantity != null))) resolved = 'shopping';
    else resolved = 'task';
  }
  if (resolved === 'meal' && !mealType) mealType = 'dinner';

  // Items (shopping) or title (everything else).
  const items = [];
  const amountTokens = [];
  let title = '';
  if (resolved === 'shopping') {
    for (const [s, e] of segmentsOf(text, type === 'shopping')) {
      const clean = remainder(text, tokens, s, e);
      if (!clean) continue;
      const item = parseItem(clean);
      const name = upperFirst(item.name.trim());
      if (!name) continue;
      items.push({ name, quantity: item.quantity, unit: item.unit });
      if (item.amountText) {
        const at = text.indexOf(item.amountText, s);
        amountTokens.push({
          kind: 'amount',
          text: item.amountText,
          value: { quantity: item.quantity, unit: item.unit },
          start: at >= 0 ? at : s,
        });
      }
    }
    title = items.map((it) => it.name).join(', ');
  } else {
    title = upperFirst(remainder(text, tokens));
  }

  const tokenList = [
    ...found.map((f) => ({
      kind: f.kind,
      text: text.slice(tokens[f.startTok].start, tokens[f.endTok - 1].end).replace(/[,;:.!?]+$/, ''),
      value: f.value,
      start: tokens[f.startTok].start,
    })),
    ...amountTokens,
  ]
    .sort((a, b) => a.start - b.start)
    .map(({ kind, text: t, value }) => ({ kind, text: t, value }));

  return {
    type: resolved,
    inferred,
    title,
    date: resolved === 'shopping' ? null : date,
    time: resolved === 'shopping' ? null : time,
    endTime: resolved === 'shopping' ? null : (timeMatch?.endTime ?? null),
    assignee,
    items,
    mealType: resolved === 'meal' ? mealType : null,
    tokens: tokenList,
    leftover: title,
  };
}
