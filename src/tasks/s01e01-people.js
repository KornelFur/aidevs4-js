import { fetchData, sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// Step 1: Fetch raw CSV text from the training API
const raw = await fetchData('people.csv');

// Step 2: Parse CSV into array of objects
// CSV columns: name, surname, gender, birthDate, city, country, job description
// Some fields are wrapped in quotes (e.g. descriptions contain commas)
// so we can't just split by comma — we need to handle quoted fields
function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (const char of row) {
    if (char === '"') {
      // toggle quote mode — inside quotes, commas are part of the value
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      // comma outside quotes = field separator
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  // push the last field (no trailing comma)
  fields.push(current.trim());

  return {
    name: fields[0],
    surname: fields[1],
    gender: fields[2],
    born: parseInt(fields[3].split('-')[0]), // "1992-02-06" → 1992
    city: fields[4],
    description: fields[6],
  };
}

const people = raw.trim().split('\n').map(parseCSVRow);
console.log(`Total people in file: ${people.length}`);

// Step 3: Filter by hard criteria — no LLM needed, just plain logic
// We want males, born in Grudziądz, aged 20-40 in 2026 (born 1986-2006)
const filtered = people.filter(p =>
  p.gender === 'M' &&
  p.city === 'Grudziądz' &&
  p.born >= 1986 &&
  p.born <= 2006
);
console.log(`After filtering (gender + city + age): ${filtered.length} people`);

// Step 4: Use LLM to tag each remaining person and check if they work in transport
const AVAILABLE_TAGS = ['IT', 'transport', 'edukacja', 'medycyna', 'praca z ludźmi', 'praca z pojazdami', 'praca fizyczna'];

async function classifyPerson(person) {
  const response = await chat([
    {
      role: 'system',
      // we tell the LLM exactly what we need and force JSON output
      content: `Analyze the job description (in Polish) and respond with JSON only.
Available tags: ${AVAILABLE_TAGS.join(', ')}.
Format: { "tags": ["tag1", "tag2"], "worksInTransport": true or false }
No extra text, just the JSON.`,
    },
    {
      role: 'user',
      content: person.description,
    },
  ], MODELS.GPT4O_MINI);

  // LLM returns a string — we parse it into a JavaScript object
  return JSON.parse(response);
}

// Step 5: Loop through filtered people, classify each one
const results = [];

for (const person of filtered) {
  const classification = await classifyPerson(person);
  console.log(`${person.name} ${person.surname} (${person.born}): ${JSON.stringify(classification)}`);

  // Only keep people who work in transport
  if (classification.worksInTransport) {
    results.push({
      name: person.name,
      surname: person.surname,
      gender: person.gender,
      born: person.born,
      city: person.city,
      tags: classification.tags,
    });
  }
}

console.log(`\nFinal candidates: ${results.length}`);
console.log(JSON.stringify(results, null, 2));

// Step 6: Send the answer to the training API
const response = await sendAnswer('people', results);
console.log('\nAPI response:', response);
