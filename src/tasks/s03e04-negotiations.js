import http from 'http';
import axios from 'axios';
import { chat, MODELS } from '../utils/openrouter.js';

const PORT = 58775;
const DATA_BASE = 'https://hub.ag3nts.org/dane/s03e04_csv';

// -----------------------------------------------------------------------
// Knowledge base: cities.csv (name, code), items.csv (name, code),
// connections.csv (itemCode, cityCode). Loaded once at startup and kept
// in memory — small enough (~2100 items, 50 cities, ~5300 links) that we
// don't need a database.
// -----------------------------------------------------------------------

function parseCsv(text) {
  return text
    .trim()
    .split('\n')
    .slice(1) // drop header
    .map((line) => line.trim().split(','));
}

let items = [];          // [{ name, code }]
let cityNameByCode = {}; // code -> name
let citiesByItemCode = {}; // itemCode -> Set(cityCode)

async function loadKnowledgeBase() {
  const [citiesCsv, itemsCsv, connectionsCsv] = await Promise.all([
    axios.get(`${DATA_BASE}/cities.csv`).then((r) => r.data),
    axios.get(`${DATA_BASE}/items.csv`).then((r) => r.data),
    axios.get(`${DATA_BASE}/connections.csv`).then((r) => r.data),
  ]);

  cityNameByCode = {};
  for (const [name, code] of parseCsv(citiesCsv)) {
    cityNameByCode[code] = name;
  }

  items = parseCsv(itemsCsv).map(([name, code]) => ({ name, code }));

  citiesByItemCode = {};
  for (const [itemCode, cityCode] of parseCsv(connectionsCsv)) {
    if (!citiesByItemCode[itemCode]) citiesByItemCode[itemCode] = new Set();
    citiesByItemCode[itemCode].add(cityCode);
  }

  console.log(`Loaded ${items.length} items, ${Object.keys(cityNameByCode).length} cities, ${Object.keys(citiesByItemCode).length} items with city links`);
}

// -----------------------------------------------------------------------
// Matching a natural-language query (e.g. "potrzebuję kabla 10 metrów")
// to the closest item in the catalog.
//
// Step 1: cheap keyword pre-filter to shrink the candidate list (items.csv
// is ~2100 rows, too much to stuff into every LLM call).
// Step 2: ask an LLM to pick the single best-matching item code from the
// shortlist.
// -----------------------------------------------------------------------

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // strip diacritics
}

function shortlistItems(query, limit = 40) {
  const queryWords = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

  const scored = items.map((item) => {
    const itemWords = normalize(item.name).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    let score = 0;
    for (const qw of queryWords) {
      if (itemWords.some((iw) => iw.includes(qw) || qw.includes(iw))) score++;
    }
    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const withScore = scored.filter((s) => s.score > 0).slice(0, limit);
  return (withScore.length > 0 ? withScore : scored.slice(0, limit)).map((s) => s.item);
}

async function findBestItemCode(query) {
  const shortlist = shortlistItems(query);
  const catalogText = shortlist.map((i) => `${i.code}: ${i.name}`).join('\n');

  const prompt = `Poniżej jest lista przedmiotów (kod: nazwa) dostępnych w katalogu.
Znajdź przedmiot, który najlepiej odpowiada zapytaniu użytkownika, nawet jeśli zapytanie jest sformułowane luźno lub opisowo.

Zapytanie: "${query}"

Katalog:
${catalogText}

Odpowiedz TYLKO kodem najlepiej pasującego przedmiotu (np. "BWST28"), bez żadnego innego tekstu.
Jeśli żaden przedmiot sensownie nie pasuje, odpowiedz dokładnie: NONE`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O_MINI);
  const code = response.trim().split(/\s+/)[0].replace(/[^A-Za-z0-9]/g, '');

  if (code === 'NONE' || !citiesByItemCode[code]) return null;
  return code;
}

async function findCitiesForItem(query) {
  const itemCode = await findBestItemCode(query);
  if (!itemCode) return 'Brak dopasowania';

  const cityCodes = citiesByItemCode[itemCode] || new Set();
  const cityNames = [...cityCodes].map((code) => cityNameByCode[code] || code);

  if (cityNames.length === 0) return 'Brak miast';
  return cityNames.join(', ');
}

// -----------------------------------------------------------------------
// HTTP server exposing a single tool endpoint for the negotiations agent.
// -----------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });

  req.on('end', async () => {
    try {
      const { params } = JSON.parse(body);
      console.log('Agent query:', params);

      let output = await findCitiesForItem(String(params ?? ''));

      // Response body must stay within the 4-500 byte contract.
      if (Buffer.byteLength(output, 'utf8') > 500) {
        output = output.slice(0, 480);
      }
      if (Buffer.byteLength(output, 'utf8') < 4) {
        output = output.padEnd(4, '.');
      }

      console.log('Tool output:', output);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output }));
    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request' }));
    }
  });
});

await loadKnowledgeBase();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Test: curl -X POST http://localhost:${PORT} -H "Content-Type: application/json" -d '{"params":"potrzebuję kabla 10 metrów"}'`);
});
