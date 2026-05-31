import { fetchData, sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// STEP 1: Download logs, discover plant components, filter and deduplicate
// -----------------------------------------------------------------------
// LESSON: Don't filter by alarm class (WARN/ERRO/CRIT) — that's the wrong axis.
// A [CRIT] about a network switch is irrelevant; an [INFO] about a water pump
// might matter. Filter by *what* the line is about, not *how severe* it is.
//
// HOW: ask an LLM to extract component IDs from a small sample of the file,
// then use those IDs to filter the full file in plain JS (no LLM cost).
// This way we catch every severity level for plant-relevant components.

const raw = await fetchData('failure.log');
const lines = raw.trim().split('\n');

// Sample every N-th line so we cover the full day, not just the morning.
// 200 lines is enough for the LLM to discover all component IDs.
const sampleSize = 200;
const step = Math.floor(lines.length / sampleSize);
const sample = lines.filter((_, i) => i % step === 0).slice(0, sampleSize).join('\n');

const componentResponse = await chat(
  [
    {
      role: 'system',
      content: `Extract all plant component IDs from these log lines.
Component IDs are short uppercase codes for physical or software systems (e.g. ECCS8, WTRPMP, PWR01, FIRMWARE).
Return only a JSON array of strings. No explanation.`,
    },
    { role: 'user', content: sample },
  ],
  MODELS.GPT4O_MINI
);

// LLM sometimes wraps JSON in markdown code fences — strip them before parsing.
const COMPONENTS = JSON.parse(componentResponse.replace(/```(?:json)?/g, '').trim());
console.log(`Discovered components: ${COMPONENTS.join(', ')}`);

// Keep every line that mentions at least one plant component.
const relevant = lines.filter(l => COMPONENTS.some(c => l.includes(c)));

// Deduplicate: the same message often repeats every 26 seconds.
// Strip the timestamp before comparing — "[06:02] ECCS8 thermal drift" and
// "[06:11] ECCS8 thermal drift" are the same event, keep only the first.
const seen = new Set();
const deduped = relevant.filter(line => {
  const content = line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, '');
  if (seen.has(content)) return false;
  seen.add(content);
  return true;
});

console.log(`Total: ${lines.length} → relevant: ${relevant.length} → deduplicated: ${deduped.length}`);

// -----------------------------------------------------------------------
// STEP 2: Build the initial submission — start small, only CRIT events
// -----------------------------------------------------------------------
// LESSON: Don't try to send everything at once. The API has a 1500-token limit
// and the feedback tells you *exactly* what is missing. Starting with only
// CRIT events leaves plenty of budget for components flagged in feedback.
//
// Token estimate: real tokenizers count ~1 token per 1.5 chars for English prose.
// Dividing by 1.5 gives a conservative estimate that avoids over-limit rejections.

const TOKEN_LIMIT = 1500;
const estimateTokens = text => Math.ceil(text.length / 1.5);
const severityRank = l => l.includes('[CRIT]') ? 0 : l.includes('[ERRO]') ? 1 : 2;

// logSet is a JS Set — duplicates are automatically ignored when adding lines.
// State lives here in JS, never inside an LLM context, so nothing gets lost
// between iterations.
const logSet = new Set();
deduped.filter(l => l.includes('[CRIT]')).forEach(l => logSet.add(l));
console.log(`\nInitial log (CRIT only): ${logSet.size} lines, ~${estimateTokens([...logSet].join('\n'))} tokens`);

// -----------------------------------------------------------------------
// STEP 3: Subagent search — semantic lookup for a missing component
// -----------------------------------------------------------------------
// LESSON: Simple string matching (includes("PWR01")) misses lines where the
// component is described indirectly or named slightly differently.
// A subagent — a separate cheap LLM call — reads batches of log lines and
// semantically decides which are relevant to the requested component.
//
// This is the "subagent for searching" pattern from the task hints:
// keep the full log OUT of the main agent's context, delegate searching
// to a focused LLM call that only sees one batch at a time.

async function findLinesForComponent(componentId) {
  const BATCH_SIZE = 80;
  const results = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE).join('\n');
    const found = await chat(
      [
        {
          role: 'system',
          content: `From these log lines, return only those relevant to component ${componentId} or directly related to its failure.
Keep lines exactly as-is. One line per line. If none match, return empty. No commentary.`,
        },
        { role: 'user', content: batch },
      ],
      MODELS.GPT4O_MINI
    );
    found.trim().split('\n').filter(Boolean).forEach(l => results.push(l));
  }

  // Return only lines not already in logSet, most severe first.
  return results
    .filter(l => !logSet.has(l))
    .sort((a, b) => severityRank(a) - severityRank(b));
}

// -----------------------------------------------------------------------
// STEP 4: Iterative submit + feedback loop
// -----------------------------------------------------------------------
// LESSON: A deterministic JS loop beats an LLM agent for predictable workflows.
// The agent with function calling kept exiting early — LLMs sometimes respond
// with plain text instead of a tool call, terminating the loop.
//
// For a workflow where every step is known in advance (send → parse → search → add → repeat),
// plain JS is simpler, cheaper, and 100% reliable.
//
// The feedback from the API is very precise: it names the exact component ID
// that technicians couldn't analyze. We parse it with a single regex and use
// the subagent to find relevant lines. One feedback message = one targeted fix.

function sortedLog() {
  // The API requires chronological order.
  // ISO-format timestamps sort correctly as strings (year-first).
  return [...logSet]
    .sort((a, b) => {
      const tsA = a.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ?? '';
      const tsB = b.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1] ?? '';
      return tsA.localeCompare(tsB);
    })
    .join('\n');
}

console.log('\n--- Starting feedback loop ---');
for (let round = 1; round <= 10; round++) {
  // Trim WARN lines if over budget — CRIT/ERRO are never removed.
  let tokens = estimateTokens([...logSet].join('\n'));
  if (tokens > TOKEN_LIMIT) {
    for (const line of [...logSet]) {
      if (line.includes('[WARN]')) logSet.delete(line);
      if (estimateTokens([...logSet].join('\n')) <= TOKEN_LIMIT) break;
    }
  }

  tokens = estimateTokens([...logSet].join('\n'));
  console.log(`\n=== Round ${round}: ${logSet.size} lines, ~${tokens} tokens ===`);

  const response = await sendAnswer('failure', { logs: sortedLog() });
  const responseText = JSON.stringify(response);
  console.log(`  API: ${response?.message ?? responseText}`);

  // Flag is wrapped in the response when technicians confirm the analysis is complete.
  if (responseText.includes('FLG:')) {
    console.log('\n✓ Done!');
    break;
  }

  // The feedback always names the missing component: "unable to determine what happened to device X"
  // Regex extracts "X" so we know exactly what to search for next.
  const missing = response?.message?.match(/device\s+([A-Z0-9]+)/i)?.[1];
  if (!missing) {
    console.log('No specific component in feedback — stopping.');
    break;
  }

  console.log(`  Missing: ${missing} — running subagent search...`);
  const candidates = await findLinesForComponent(missing);
  console.log(`  Found ${candidates.length} new lines for ${missing}`);
  candidates.forEach(l => logSet.add(l));
}
