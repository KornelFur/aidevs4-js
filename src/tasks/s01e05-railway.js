import { agent, MODELS } from '../utils/openrouter.js'
import { sendAnswer } from '../utils/api.js';

const route = 'X-01';

// -----------------------------------------------------------------------
// STEP 1: checking API documentation - sending action: 'help'
// -----------------------------------------------------------------------

async function retryRequest(fn, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`Attempt ${attempt}/${maxRetries}`);
        try {
            return await fn();
        } catch (err) {
            const status = err.response?.status;
            console.log('Error status:', err.response?.status);
            console.log('Error data:', JSON.stringify(err.response?.data));
            const retryAfter = err.response?.data?.retry_after;
            console.log('Retry after:', retryAfter);

            if (status === 503 || status === 429) {
                const waitMs = ((retryAfter ?? 10) + 1) * 1000; 
                  console.log(`Error ${status}, waiting ${(retryAfter ?? 10) + 1}s...`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            } else {
                throw err;
            }
        }
    }
    throw new Error('Max retries exceeded');
}

const help = await retryRequest(() => sendAnswer('railway', { action: 'help' }));
console.log(JSON.stringify(help, null, 2));

// -----------------------------------------------------------------------
// STEP 2: define tools and create toolHandler for LLM
// -----------------------------------------------------------------------

const tools = [
    {
    type: 'function',
    function: {
      name: 'reconfigure',
      description: 'Enable reconfigure mode for a route.',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route code e.g. X-01' }
        },
        required: ['route']
      }
    }
    },
    {
    type: 'function',
    function: {
      name: 'getstatus',
      description: 'Get current status for the given route.',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route code e.g. X-01' }
        },
        required: ['route']
      }
    }
    },
    {
    type: 'function',
    function: {
      name: 'setstatus',
      description: 'Set route status while in reconfigure mode.',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route code e.g. X-01' },
          value: { type: 'string', description: 'Status value', enum: ['RTOPEN', 'RTCLOSE']}
        },
        required: ['route', 'value']
      }
    }
    },
    {
    type: 'function',
    function: {
      name: 'save',
      description: 'Exit reconfigure mode for the given route.',
      parameters: {
        type: 'object',
        properties: {
          route: { type: 'string', description: 'Route code e.g. X-01' }
        },
        required: ['route']
      }
    }
    }
]

const toolHandlers = {
    reconfigure: (args) => retryRequest(() => sendAnswer('railway', {
        action: 'reconfigure',
        route: args.route
    })),
    getstatus: (args) => retryRequest(() => sendAnswer('railway', {
        action: 'getstatus',
        route: args.route
    })),
    setstatus: (args) => retryRequest(() => sendAnswer('railway', {
        action: 'setstatus',
        route: args.route,
        value: args.value,
    })),
    save: (args) => retryRequest(() => sendAnswer('railway', {
        action: 'save',
        route: args.route
    })),
}

const SYSTEM_PROMPT = `You're a railway system operator. Your goal is to activate route ${route} (change its status to RTOPEN).
                        Use the available tools to complete this task step by step. Always check the current status before making changes.`;

const result = await agent(
    SYSTEM_PROMPT,
    tools,
    toolHandlers,
    MODELS.GPT4O_MINI
);

console.log(result);