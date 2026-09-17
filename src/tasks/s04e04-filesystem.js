import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import axios from 'axios';
import { sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

const NOTES_URL = 'https://hub.ag3nts.org/dane/natan_notes.zip';

async function call(answer) {
  return sendAnswer('filesystem', answer);
}

// -----------------------------------------------------------------------
// Download and unzip Natan's notes.
// -----------------------------------------------------------------------

async function downloadNotes() {
  const dir = mkdtempSync(path.join(tmpdir(), 'natan-notes-'));
  const zipPath = path.join(dir, 'notes.zip');
  const response = await axios.get(NOTES_URL, { responseType: 'arraybuffer' });
  writeFileSync(zipPath, response.data);
  execSync(`unzip -o -q "${zipPath}" -d "${dir}"`);

  const files = readdirSync(dir);
  const read = (prefix) => {
    const file = files.find((f) => f.toLowerCase().startsWith(prefix));
    if (!file) throw new Error(`Could not find a file starting with "${prefix}" in the notes archive.`);
    return readFileSync(path.join(dir, file), 'utf8');
  };

  return { ogloszenia: read('og'), rozmowy: read('rozm'), transakcje: read('trans') };
}

// -----------------------------------------------------------------------
// Filenames must match ^[a-z0-9_]+$ (lowercase, digits, underscore only)
// per the API's help output, and the notes may contain Polish diacritics
// even though they mostly don't — normalize defensively either way.
// -----------------------------------------------------------------------

function slugify(text) {
  const map = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => map[ch])
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// -----------------------------------------------------------------------
// transakcje.txt is already a strict "City -> item -> City" format with
// no ambiguity, so it's parsed deterministically rather than through an
// LLM — a regex is more reliable than a model for fixed-format data.
// -----------------------------------------------------------------------

function parseTransactions(text) {
  const itemSellers = new Map(); // item (singular, slug) -> Set of seller city names (as written)

  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\S+)\s*->\s*(\S+)\s*->\s*(\S+)\s*$/);
    if (!match) continue;
    const [, seller, item] = match;
    const itemSlug = slugify(item);
    if (!itemSellers.has(itemSlug)) itemSellers.set(itemSlug, new Set());
    itemSellers.get(itemSlug).add(seller);
  }

  return itemSellers;
}

// -----------------------------------------------------------------------
// ogloszenia.txt (free-text announcements of what each city needs) and
// rozmowy.txt (a diary narrating phone calls, where the same person is
// sometimes referred to by first name in one line and surname in
// another) both require reading comprehension, not pattern matching —
// that's handed to an LLM.
// -----------------------------------------------------------------------

async function extractCityNeeds(ogloszeniaText) {
  const prompt = `Ponizszy tekst to ogloszenia o zapotrzebowaniu roznych miast na towary:

${ogloszeniaText}

Dla kazdego wspomnianego miasta wypisz, jakich towarow potrzebuje i w jakiej ilosci (sama liczba, bez jednostek typu "workow", "butelek", "kg", "porcji" — tylko ilosc towaru).
Nazwy miast podaj w mianowniku (np. "Domatowa" -> "Domatowo", "Darzlubiu" -> "Darzlubie").
Nazwy towarow podaj w mianowniku liczby pojedynczej i BEZ polskich znakow diakrytycznych (np. "chlebow" -> "chleb", "lopaty" -> "lopata", "wolowiny" -> "wolowina", "ryzu" -> "ryz", "mlotkow" -> "mlotek", "wiertarek" -> "wiertarka", "kilofow" -> "kilof", "ziemniakow" -> "ziemniak", "kurczaka" -> "kurczak").

Zwroc WYLACZNIE obiekt JSON w formacie: {"NazwaMiasta": {"towar": ilosc, ...}, ...}`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O);
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse city needs from LLM response: ${response}`);
  return JSON.parse(match[0]);
}

async function extractCityManagers(rozmowyText) {
  const prompt = `Ponizszy tekst to dziennik Natana Ramsa, opisujacy rozmowy telefoniczne o handlu w roznych miastach. Ta sama osoba bywa wspomniana raz po imieniu, raz po nazwisku, w roznych zdaniach — polacz te wzmianki w jedna osobe.

${rozmowyText}

Dla kazdego miasta ustal, KTO odpowiada za handel w tym miescie (imie i nazwisko). Domatowem zajmuje sie sam Natan Rams.
Zwroc WYLACZNIE obiekt JSON w formacie: {"NazwaMiasta": "Imie Nazwisko", ...}`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O);
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Could not parse city managers from LLM response: ${response}`);
  return JSON.parse(match[0]);
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

console.log('Downloading and extracting notes...');
const notes = await downloadNotes();

console.log('Parsing transactions (deterministic)...');
const itemSellers = parseTransactions(notes.transakcje);
console.log(`Found ${itemSellers.size} distinct items.`);

console.log('Extracting city needs with LLM...');
const cityNeeds = await extractCityNeeds(notes.ogloszenia);
console.log(cityNeeds);

console.log('Extracting city managers with LLM...');
const cityManagers = await extractCityManagers(notes.rozmowy);

// Safety net: the notes state explicitly that Natan handles Domatowo
// himself, but that fact tends to get dropped since it's phrased as
// self-reference ("ja to spinam") rather than a named third party.
if (!Object.keys(cityManagers).some((city) => slugify(city) === 'domatowo')) {
  console.warn('LLM omitted Domatowo/Natan Rams — patching.');
  cityManagers.Domatowo = 'Natan Rams';
}
console.log(cityManagers);

// Safety net: transakcje.txt uses whatever grammatical form appears in
// that line (e.g. "ziemniaki"), while /miasta needs alreaby uses the
// singular nominative (e.g. "ziemniak") — reconcile transaction item
// names against the canonical singular forms the city-needs extraction
// already produced, rather than re-deriving Polish plural rules.
const canonicalItems = new Set(Object.values(cityNeeds).flatMap((needs) => Object.keys(needs).map(slugify)));
function canonicalizeItem(slug) {
  if (canonicalItems.has(slug)) return slug;
  // Only bridge an exact "plural = singular + i/y" relationship (e.g.
  // ziemniaki -> ziemniak) — a loose prefix match would also wrongly
  // merge unrelated items that happen to share a prefix (maka/makaron).
  const match = [...canonicalItems].find((canonical) => slug === `${canonical}i` || slug === `${canonical}y`);
  if (match) {
    console.warn(`Reconciling transaction item "${slug}" -> "${match}".`);
    return match;
  }
  return slug;
}

// -----------------------------------------------------------------------
// Build the filesystem batch. /miasta files must exist before /osoby and
// /towary files, since their markdown links must point to existing files.
// -----------------------------------------------------------------------

const actions = [{ action: 'reset' }, { action: 'createDirectory', path: '/miasta' }, { action: 'createDirectory', path: '/osoby' }, { action: 'createDirectory', path: '/towary' }];

const citySlugs = {};
for (const [city, needs] of Object.entries(cityNeeds)) {
  const slug = slugify(city);
  citySlugs[city] = slug;
  const normalizedNeeds = Object.fromEntries(Object.entries(needs).map(([item, qty]) => [slugify(item), qty]));
  actions.push({ action: 'createFile', path: `/miasta/${slug}`, content: JSON.stringify(normalizedNeeds) });
}

for (const [city, personName] of Object.entries(cityManagers)) {
  const slug = citySlugs[city] ?? slugify(city);
  const personSlug = slugify(personName);
  actions.push({
    action: 'createFile',
    path: `/osoby/${personSlug}`,
    content: `${personName} odpowiada za handel w miescie [${city}](/miasta/${slug}).`,
  });
}

for (const [item, sellers] of itemSellers) {
  const links = [...sellers].map((city) => {
    const slug = citySlugs[city] ?? slugify(city);
    return `[${city}](/miasta/${slug})`;
  });
  const canonicalItem = canonicalizeItem(item);
  actions.push({ action: 'createFile', path: `/towary/${canonicalItem}`, content: `Towar dostepny w miastach: ${links.join(', ')}.` });
}

console.log(`Submitting ${actions.length} filesystem actions in one batch...`);
console.log(await call(actions));

console.log('Calling done...');
console.log(await call({ action: 'done' }));
