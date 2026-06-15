import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// OVERVIEW
// -----------------------------------------------------------------------
// 9999 sensor JSON files. Find anomalies:
//   1) Value out of valid range for an active sensor
//   2) Inactive sensor has a non-zero value (sensor returning data it shouldn't)
//   3) Operator note says "OK" but data is wrong
//   4) Operator note says "ERROR" but data is fine
//
// Strategy:
//   - Cases 1, 2, 3: detected programmatically (cheap, instant)
//   - Case 4: detected by LLM — but only on 2032 unique notes, not 9953 files
//     Deduplication gives us ~40 batched LLM calls instead of thousands.

const SENSORS_DIR = 'files/sensors';

const RANGES = {
  temperature_K: [553, 873],
  pressure_bar: [60, 160],
  water_level_meters: [5.0, 15.0],
  voltage_supply_v: [229.0, 231.0],
  humidity_percent: [40.0, 80.0],
};

// Maps sensor_type token → the JSON field it controls
const TYPE_TO_FIELD = {
  temperature: 'temperature_K',
  pressure: 'pressure_bar',
  water: 'water_level_meters',
  voltage: 'voltage_supply_v',
  humidity: 'humidity_percent',
};

// Returns a list of violation strings, or [] if data is clean.
function getDataIssues(data) {
  const activeFields = new Set(
    data.sensor_type.split('/').map(t => TYPE_TO_FIELD[t]).filter(Boolean)
  );
  const issues = [];
  for (const [field, [min, max]] of Object.entries(RANGES)) {
    const val = data[field];
    if (activeFields.has(field)) {
      // Active sensor must be within range
      if (val < min || val > max) {
        issues.push(`${field}=${val} out of [${min}, ${max}]`);
      }
    } else {
      // Inactive sensor must be exactly 0
      if (val !== 0) {
        issues.push(`${field}=${val} should be 0 (sensor not active)`);
      }
    }
  }
  return issues;
}

// -----------------------------------------------------------------------
// STEP 1: Programmatic pass over all files
// -----------------------------------------------------------------------
console.log('=== Step 1: Programmatic data check ===');

const files = readdirSync(SENSORS_DIR).sort();
const anomalyIds = new Set();

// Files where data is clean — need LLM note check
// We group them by note text to deduplicate before calling the LLM.
const noteToIds = new Map(); // note text → [file id, ...]

for (const filename of files) {
  const id = filename.replace('.json', '');
  const data = JSON.parse(readFileSync(join(SENSORS_DIR, filename), 'utf8'));
  const issues = getDataIssues(data);

  if (issues.length > 0) {
    anomalyIds.add(id);
  } else {
    // Group by exact note text — many files share the same note
    const note = data.operator_notes;
    if (!noteToIds.has(note)) noteToIds.set(note, []);
    noteToIds.get(note).push(id);
  }
}

console.log(`Data anomalies found: ${anomalyIds.size}`);
console.log(`Data-OK files: ${files.length - anomalyIds.size}`);
console.log(`Unique notes to classify: ${noteToIds.size}`);

// -----------------------------------------------------------------------
// STEP 2: LLM note classification (batched, deduplicated)
// -----------------------------------------------------------------------
// We only need to classify notes for data-OK files.
// "Problem note on data-OK file" = anomaly type 4.
//
// Why deduplicate?
// 9953 data-OK files but only ~2032 unique notes → 5× cheaper.
// LLMs also have prompt caching, but deduplication on our side is free.
//
// Batch format: send 50 numbered notes per call, ask for indices of "problem" notes.
// Output is just a short JSON array → minimal token cost.

console.log('\n=== Step 2: LLM note classification ===');

const uniqueNotes = [...noteToIds.keys()];
const problemNotes = new Set();
const BATCH_SIZE = 50;

for (let i = 0; i < uniqueNotes.length; i += BATCH_SIZE) {
  const batch = uniqueNotes.slice(i, i + BATCH_SIZE);
  const batchNum = Math.floor(i / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(uniqueNotes.length / BATCH_SIZE);

  process.stdout.write(`Batch ${batchNum}/${totalBatches}... `);

  // Number the notes within this batch (0-indexed so indices stay simple)
  const numbered = batch.map((note, j) => `[${j}] ${note}`).join('\n');

  const response = await chat(
    [
      {
        role: 'system',
        content: `You are reviewing power plant operator notes. The sensor data these notes describe has already been verified as CORRECT and within all valid ranges.

Your task: identify which notes are INCORRECT — meaning the operator CLAIMS there is a problem, error, anomaly, or abnormality, even though the data is actually fine.

Return ONLY a JSON array of indices (0-based) where the operator falsely reports a problem. Example: [2, 7, 15]
If none are problematic, return [].
No explanation, no markdown — just the raw JSON array.`,
      },
      { role: 'user', content: numbered },
    ],
    MODELS.GPT4O_MINI
  );

  // Strip any markdown fences in case the model adds them
  const cleaned = response.replace(/```(?:json)?/g, '').trim();
  const indices = JSON.parse(cleaned);

  console.log(`${indices.length} problem notes`);

  for (const idx of indices) {
    if (batch[idx] !== undefined) {
      problemNotes.add(batch[idx]);
    }
  }
}

// -----------------------------------------------------------------------
// STEP 3: Collect anomaly IDs from problem notes
// -----------------------------------------------------------------------
for (const [note, ids] of noteToIds) {
  if (problemNotes.has(note)) {
    for (const id of ids) anomalyIds.add(id);
  }
}

console.log(`\n=== Total anomalies: ${anomalyIds.size} ===`);
console.log('IDs:', [...anomalyIds].sort());

// -----------------------------------------------------------------------
// STEP 4: Submit answer
// -----------------------------------------------------------------------
const answer = [...anomalyIds].sort();
console.log('\n=== Submitting ===');
const result = await sendAnswer('evaluation', { recheck: answer });
console.log(result);
