import axios from 'axios';
import { sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

const CITIES_URL = 'https://hub.ag3nts.org/dane/food4cities.json';

// Creator used for every order: an existing active user with a role fit
// for warehouse/transport work ("Obsluga transportow"), found via the
// read-only database tool.
const CREATOR = { id: 2, login: 'user', birthday: '1991-04-06' };

async function call(answer) {
  return sendAnswer('foodwarehouse', answer);
}

async function dbQuery(query) {
  const res = await call({ tool: 'database', query });
  return res.rows;
}

// -----------------------------------------------------------------------
// This task has no free text to interpret — needs and destinations are
// already structured JSON/SQL — so there's no natural place for an LLM
// in the core logic. As a genuine (if modest) use, an LLM acts as a
// quality-control pass: given the city's required items and what was
// actually appended to its order, it confirms an exact match or flags
// the discrepancy in plain language, rather than us silently trusting
// our own arithmetic.
// -----------------------------------------------------------------------

async function verifyOrderMatchesNeeds(city, needs, orderItems) {
  const actual = Object.fromEntries(orderItems.map((i) => [i.name, i.items]));

  const prompt = `Miasto "${city}" potrzebuje dokladnie tych towarow:
${JSON.stringify(needs)}

Zamowienie zawiera:
${JSON.stringify(actual)}

Czy zamowienie zawiera DOKLADNIE te same towary w tych samych ilosciach — bez brakow i bez nadmiarow? Odpowiedz "OK" jesli tak, albo krotko po polsku opisz roznice jesli nie.`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O_MINI);
  return response.trim();
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

console.log('Resetting order state...');
console.log(await call({ tool: 'reset' }));

console.log('Fetching city needs...');
const { data: cityNeeds } = await axios.get(CITIES_URL);
const cities = Object.keys(cityNeeds);
console.log(`Cities: ${cities.join(', ')}`);

console.log('Looking up destination codes...');
const cityNameList = cities.map((c) => `'${c.charAt(0).toUpperCase()}${c.slice(1)}'`).join(',');
const destinationRows = await dbQuery(`select * from destinations where name in (${cityNameList})`);
const destinationByCity = Object.fromEntries(destinationRows.map((r) => [r.name.toLowerCase(), r.destination_id]));

for (const city of cities) {
  if (!destinationByCity[city]) throw new Error(`No destination code found for city "${city}".`);
}
console.log(destinationByCity);

for (const city of cities) {
  const destination = destinationByCity[city];
  const cityTitle = city.charAt(0).toUpperCase() + city.slice(1);

  console.log(`\n--- ${cityTitle} (destination ${destination}) ---`);
  const sigRes = await call({ tool: 'signatureGenerator', action: 'generate', login: CREATOR.login, birthday: CREATOR.birthday, destination });
  const signature = sigRes.hash;

  const createRes = await call({
    tool: 'orders',
    action: 'create',
    title: `Dostawa dla ${cityTitle}`,
    creatorID: CREATOR.id,
    destination,
    signature,
  });
  console.log('create:', createRes);
  const orderId = createRes.id ?? createRes.order?.id;
  if (!orderId) throw new Error(`Could not find order id in create response: ${JSON.stringify(createRes)}`);

  const appendRes = await call({ tool: 'orders', action: 'append', id: orderId, items: cityNeeds[city] });
  console.log('append:', appendRes);

  const verdict = await verifyOrderMatchesNeeds(cityTitle, cityNeeds[city], appendRes.order.items);
  console.log('LLM quality check:', verdict);
  if (verdict.toUpperCase() !== 'OK') {
    throw new Error(`Order for ${cityTitle} failed LLM quality check: ${verdict}`);
  }
}

console.log('\nCalling done...');
console.log(await call({ tool: 'done' }));
