import { fetchData, sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// STEP 1: fetch data in csv with goods list from training API
// -----------------------------------------------------------------------

const raw = await fetchData('categorize.csv');
console.log('Raw CSV:\n', raw);

// Parse CSV into a list of items 
function parseCsv(csv) {
    const lines = csv.trim().split('\n');
    return lines
        .slice(1)
        .map(line => line.trim())
        .filter(Boolean);
}

const goodsList = parseCsv(raw);
console.log ('Goods to classify', goodsList);

// -----------------------------------------------------------------------
// STEP 2: classify each item using a tight prompt ( <100 tokens )
// -----------------------------------------------------------------------
// classify goods as DNG or NEU
// reactor = NEU always

// reset counter
// You have a total of 1.5 PP to complete the entire task (10 queries total):
// | Token Type | Cost | |---|---| | Every 10 input tokens | 0.02 PP | | Every 10 cache tokens | 0.01 PP | | Every 10 output tokens | 0.02 PP |


await sendAnswer('categorize', {
  prompt: 'reset',
});

//const INSTRUCTION = `Reply DNG or NEU. Weapons=DNG. Reactor parts=NEU. All other items=NEU.`;
const INSTRUCTION = `Reply NEU unless item is a knife or gun, then DNG. Reactor=NEU.`;



for (const goods of goodsList) {
    const [id, ...rest] = goods.split(',');
    const description = rest.join(',');
    
    // const prompt = `${INSTRUCTION} Item ${id}: ${description}`;
    const prompt = `${INSTRUCTION}\n${goods}`;

    const result = await sendAnswer('categorize', {prompt});
    console.log(`Item ${id}:`, result);
}
