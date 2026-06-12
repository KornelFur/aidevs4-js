import axios from 'axios';
import { API_KEY, sendAnswer } from '../utils/api.js';
import { agent, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// STEP 1: Connect to the zmail API
// -----------------------------------------------------------------------
// The zmail API is a custom email search API, similar to Gmail.
// Every request needs our API key. We'll first call "help" to discover
// all available actions and their parameters before starting the agent.

const ZMAIL_URL = 'https://hub.ag3nts.org/api/zmail';

async function callZmail(action, params = {}) {
  const response = await axios.post(ZMAIL_URL, {
    apikey: API_KEY,
    action,
    ...params,
  });
  return response.data;
}

// Discover the API capabilities before giving the agent any tools.
// We'll pass this help text into the agent's initial context.
console.log('=== Fetching zmail API help ===');
const helpResponse = await callZmail('help', { page: 1 });
console.log(JSON.stringify(helpResponse, null, 2));

// -----------------------------------------------------------------------
// STEP 2: Define tools for the agent
// -----------------------------------------------------------------------
// Tools are described in a JSON schema that the LLM understands.
// Think of them as "function signatures" — the LLM reads the description
// and decides when and how to call each one.
//
// We use TWO tools here instead of many specific ones:
//   - call_zmail: flexible tool for any zmail action (search, get, browse)
//   - submit_answer: dedicated tool to submit findings to the hub
//
// Why a single generic zmail tool?
// The API actions are only known after calling "help". A generic tool lets
// the agent self-discover the API from the help response instead of being
// limited to hardcoded action names.

const tools = [
  {
    type: 'function',
    function: {
      name: 'call_zmail',
      description: `Call the zmail mailbox API. Use this to search emails, browse the inbox,
and retrieve full email content. Available actions were returned by the help call.
Common patterns:
- Search: use the search action with a "query" parameter supporting Gmail-like operators (from:, to:, subject:, OR, AND)
- Browse: use getInbox with "page" parameter to paginate through all emails
- Read full email: use the appropriate action with an email "id" parameter`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The API action name exactly as returned by the help endpoint',
          },
          params: {
            type: 'object',
            description: 'Additional parameters for this action (e.g. { query: "from:proton.me" } or { id: "123" } or { page: 2 })',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description: `Submit the three collected values to the hub for verification.
Only call this when you are confident you have all three values.
The hub will tell you if any value is wrong — in that case, keep searching.
When all values are correct, the hub returns a flag like {FLG:...}.`,
      parameters: {
        type: 'object',
        properties: {
          password: {
            type: 'string',
            description: 'The employee system password found in the inbox',
          },
          date: {
            type: 'string',
            description: 'The planned attack date in YYYY-MM-DD format',
          },
          confirmation_code: {
            type: 'string',
            description: 'The ticket confirmation code starting with SEC- (36 chars total: SEC- + 32 chars)',
          },
        },
        required: ['password', 'date', 'confirmation_code'],
      },
    },
  },
];

// -----------------------------------------------------------------------
// STEP 3: Define tool handlers
// -----------------------------------------------------------------------
// These are the ACTUAL JS functions that run when the LLM requests a tool.
// The agent() loop will call these with the arguments the LLM provided.

const toolHandlers = {
  call_zmail: async ({ action, params = {} }) => {
    console.log(`  [zmail] ${action}`, params);
    const result = await callZmail(action, params);
    console.log(`  [zmail result preview]`, JSON.stringify(result).slice(0, 200));
    return result;
  },

  submit_answer: async ({ password, date, confirmation_code }) => {
    console.log(`  [submit] password=${password}, date=${date}, code=${confirmation_code}`);
    const result = await sendAnswer('mailbox', { password, date, confirmation_code });
    console.log(`  [hub response]`, JSON.stringify(result));
    return result;
  },
};

// -----------------------------------------------------------------------
// STEP 4: Write the system prompt
// -----------------------------------------------------------------------
// The system prompt is the agent's "briefing". It must tell the agent:
//   - What it's looking for and what format values must be in
//   - What it knows about the domain (Wiktor, proton.me, SEC- format)
//   - The search strategy to follow
//   - How to handle edge cases (active mailbox, wrong answers)

const systemPrompt = `You are a security researcher who has gained access to an email inbox belonging
to an operator of a power plant. Your mission is to extract three specific pieces of information
from this inbox.

## What you need to find

1. **date** — The date (format: YYYY-MM-DD) when the security department plans to attack our power plant
2. **password** — The password to the employee system, which is likely still somewhere in this inbox
3. **confirmation_code** — A ticket confirmation code in format: SEC- followed by exactly 32 characters (36 chars total)

## What you know

- A man named Wiktor sent an email FROM a @proton.me domain — he reported on us
- The API supports Gmail-like search operators: from:, to:, subject:, OR, AND
- The inbox is ACTIVE — new emails may arrive while you work. If you can't find something, retry later.

## Search strategy

1. First, read the help response already provided to understand all available API actions and parameters
2. Search for emails from proton.me to find Wiktor's email (likely contains clues)
3. Search for "password" or "hasło" (Polish word for password) to find the password
4. Search for "SEC-" or "confirmation" or "ticket" to find the confirmation code
5. Search for "attack" or "atak" or date patterns to find the attack date
6. Always retrieve the FULL email content (using the get/read action with the email ID) before drawing conclusions
7. Paginate through results if there are multiple pages
8. If a search returns nothing, try broader or different search terms

## Important rules

- Never guess content from email subject/metadata alone — always read the full email first
- If submit_answer returns an error saying a value is wrong, continue searching and resubmit
- The task is complete only when you receive a response containing {FLG:...}
- The mailbox is active — if something is missing, wait and retry the search

## API help from the server
${JSON.stringify(helpResponse, null, 2)}`;

// -----------------------------------------------------------------------
// STEP 5: Run the agent
// -----------------------------------------------------------------------
// We give the agent up to 40 iterations (LLM calls) to complete the task.
// Each iteration = one LLM response + zero or more tool calls.
// The agent loop in openrouter.js handles everything automatically.

console.log('\n=== Starting agent ===\n');
const result = await agent(systemPrompt, tools, toolHandlers, MODELS.GEMINI3_1, 40);
console.log('\n=== Agent finished ===');
console.log(result);
