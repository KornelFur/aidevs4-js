import { API_KEY, sendAnswer } from '../utils/api.js';
import { chat, agent, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// STEP 1: Locate the dam using a vision model (majority voting)
// -----------------------------------------------------------------------
// We run the same query 3 times and pick the most common answer.
// This is called "self-consistency" — useful when a single LLM call is
// unreliable (e.g. counting grid cells in an image).

const mapUrl = `https://hub.ag3nts.org/data/${API_KEY}/drone.png`;
console.log('Map URL:', mapUrl);

const visionPrompt = `You are analyzing an aerial map divided by a visible grid.

Step 1 — Count grid lines:
- Count VERTICAL lines (including both borders). Columns = vertical lines - 1.
- Count HORIZONTAL lines (including both borders). Rows = horizontal lines - 1.

Step 2 — Locate the dam:
- Find the water body. The sector containing the dam has INTENTIONALLY BRIGHTER / more saturated blue water than anywhere else on the map.
- Count its column (left-to-right, starting at 1) and row (top-to-bottom, starting at 1).

Reply ONLY in this exact format, nothing else:
GRID: <columns>x<rows>
DAM: column=<number>, row=<number>`;

const RUNS = 3;
const visionResults = [];

for (let i = 1; i <= RUNS; i++) {
  console.log(`\nVision call ${i}/${RUNS}...`);
  const response = await chat(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt },
          { type: 'image_url', image_url: { url: mapUrl } },
        ],
      },
    ],
    MODELS.GPT54_IMAGE
  );

  console.log(`  Raw: ${response.trim()}`);

  const gridMatch = response.match(/GRID:\s*(\d+)x(\d+)/i);
  const damMatch = response.match(/DAM:\s*column=(\d+),\s*row=(\d+)/i);

  if (gridMatch && damMatch) {
    const parsed = {
      cols: parseInt(gridMatch[1]),
      rows: parseInt(gridMatch[2]),
      damCol: parseInt(damMatch[1]),
      damRow: parseInt(damMatch[2]),
    };
    console.log(`  Parsed:`, parsed);
    visionResults.push(parsed);
  } else {
    console.log(`  Could not parse — skipping`);
  }
}

// Majority vote on dam coordinates
const votes = {};
for (const r of visionResults) {
  const key = `${r.cols}x${r.rows}|${r.damCol},${r.damRow}`;
  votes[key] = (votes[key] ?? 0) + 1;
}
console.log('\nVotes:', votes);

const [winnerKey] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
const [gridPart, damPart] = winnerKey.split('|');
const [cols, rows] = gridPart.split('x').map(Number);
const [damCol, damRow] = damPart.split(',').map(Number);

console.log(`\n=== Dam located: column=${damCol}, row=${damRow} (grid ${cols}x${rows}) ===\n`);

// -----------------------------------------------------------------------
// STEP 2: Build and submit drone instructions using an agent loop
// -----------------------------------------------------------------------
// The drone API uses an overloaded set() function — same name, different
// behavior depending on the argument type:
//   set(2,4)      → sets landing sector (column, row)
//   set(50m)      → sets altitude
//   set(engineON) → enables engines
//   set(destroy)  → mission objective: destroy
//   set(return)   → mission objective: return to base
//
// Key trick: setDestinationObject sets the OFFICIAL target (power plant),
// but set(x,y) sets the ACTUAL landing sector (dam). The bomb drops at
// the landing sector, not at the destination object.
//
// The API gives precise error messages — we use an agent that submits
// instructions and adjusts based on feedback (reactive approach).

const tools = [
  {
    type: 'function',
    function: {
      name: 'submit_instructions',
      description: 'Submit a drone instruction sequence to the hub for execution. Returns hub feedback or a flag if successful.',
      parameters: {
        type: 'object',
        properties: {
          instructions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of drone API instructions to execute',
          },
        },
        required: ['instructions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hard_reset',
      description: 'Resets the drone to factory defaults. Use if accumulated configuration errors make it impossible to proceed.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const toolHandlers = {
  submit_instructions: async ({ instructions }) => {
    console.log('\n[submit]', instructions);
    try {
      const result = await sendAnswer('drone', { instructions });
      console.log('[hub]', JSON.stringify(result));
      // Signal the agent to stop immediately when the flag arrives.
      // Without this, the LLM sometimes makes another tool call after seeing
      // the flag (e.g. a cleanup hardReset), which wipes the server state.
      if (JSON.stringify(result).includes('FLG:')) {
        return { ...result, TASK_COMPLETE: true, instruction: 'FLAG RECEIVED — stop all tool calls now and output the flag.' };
      }
      return result;
    } catch (err) {
      // axios throws on 4xx/5xx — the API error message is in err.response.data
      // We return it instead of crashing so the agent can read and react to it
      const errorData = err.response?.data ?? { error: err.message };
      console.log('[hub error]', JSON.stringify(errorData));
      return errorData;
    }
  },
  hard_reset: async () => {
    console.log('\n[hard_reset]');
    try {
      const result = await sendAnswer('drone', { instructions: ['hardReset'] });
      console.log('[hub]', JSON.stringify(result));
      return result;
    } catch (err) {
      const errorData = err.response?.data ?? { error: err.message };
      console.log('[hub error]', JSON.stringify(errorData));
      return errorData;
    }
  },
};

const systemPrompt = `You are programming a drone (model DRN-BMB7) to destroy a dam near a power plant.

## Your goal
Submit a valid instruction sequence that makes the drone fly to the dam sector and destroy it.

## What you know
- Official destination object (required by the API): PWR6132PL
- The vision model estimates the dam is at column=${damCol}, row=${damRow} — but this may be slightly off
- Grid top-left is column=1, row=1

## CRITICAL: Server state persists between calls
The drone server REMEMBERS all configuration from previous submit_instructions calls.
This means: each new attempt MUST start with hardReset to clear old state.
Every attempt must be a COMPLETE, self-contained sequence:
  hardReset → configure everything → flyToLocation (all in one call)

## Drone API reference
- hardReset — clears all configuration (always first in a new attempt)
- setDestinationObject(PWR6132PL) — required destination
- set(x,y) — sets landing sector (where bomb actually drops); x=column, y=row
- set(50m) — altitude (required, 1m–100m)
- set(engineON) — enables engines (required)
- set(100%) — sets engine power to 100% (required; format is a percentage like 50% or 100%)
- flyToLocation — executes flight (requires destination + altitude + landing sector + engines + power)
- set(destroy) — mission objective: destroy
- set(return) — mission objective: return to base
- set(image) - wykonanie zdjęcia
- set(video) - nagranie filmu

## Error message meanings
- "I don't think you'll hit the dam. You'll drop it somewhere nearby." → landing sector coordinates are wrong, try adjacent cells
- "Hey, you do know we're only pretending to destroy power plants..." → your landing sector = the power plant, not the dam
- "No destination has been selected" → forgot setDestinationObject or state was reset
- Response containing {FLG:...} → SUCCESS, stop immediately

## Strategy
1. First attempt: use set(${damCol},${damRow}) as the landing sector
2. If "nearby" error: the estimated coordinates are close — try adjacent cells (±1 on column or row)
3. Always include hardReset at the start and send the ENTIRE sequence in ONE call
4. Stop as soon as you see {FLG:...} in the response
5. You always have to return to base after mission
6. flyToLocation must be the last instruction;`

console.log('=== Starting drone agent ===\n');
const result = await agent(systemPrompt, tools, toolHandlers, MODELS.GPT4O, 20);
console.log('\n=== Done ===');
console.log(result);
