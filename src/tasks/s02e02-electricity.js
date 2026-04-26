import axios from 'axios';
import { API_KEY, BASE_URL, sendAnswer, fetchData } from '../utils/api.js';
import { agent, MODELS } from '../utils/openrouter.js';

// Solved board — manually verified: top=1, right=2, bottom=4, left=8
const SOLVED_BOARD = {
  '1x1': 6,  // right+bottom
  '1x2': 14, // right+bottom+left
  '1x3': 10, // left+right
  '2x1': 5,  // top+bottom
  '2x2': 7,  // top+right+bottom
  '2x3': 14, // right+bottom+left
  '3x1': 11, // top+right+left
  '3x2': 9,  // top+left
  '3x3': 3,  // top+right
};

function formatBoard(board) {
  return [
    `1x1=${board['1x1']} 1x2=${board['1x2']} 1x3=${board['1x3']}`,
    `2x1=${board['2x1']} 2x2=${board['2x2']} 2x3=${board['2x3']}`,
    `3x1=${board['3x1']} 3x2=${board['3x2']} 3x3=${board['3x3']}`,
  ].join('\n');
}

async function getBoardState() {
  const data = await fetchData('electricity.json');
  const board = {
    '1x1': data[0][0], '1x2': data[0][1], '1x3': data[0][2],
    '2x1': data[1][0], '2x2': data[1][1], '2x3': data[1][2],
    '3x1': data[2][0], '3x2': data[2][1], '3x3': data[2][2],
  };
  return { board, formatted: formatBoard(board) };
}

async function rotateCell({ cell }) {
  console.log(`  >> Rotating ${cell}`);
  const result = await sendAnswer('electricity', { rotate: cell });
  console.log(`  << Response:`, result);
  return result;
}

async function resetBoard() {
  await axios.get(`${BASE_URL}/data/${API_KEY}/electricity.png?reset=1`);
  console.log('  Board reset.');
  return { reset: true };
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_board_state',
      description: 'Get the current board state as bitmask values per cell. Use this to verify progress.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rotate_cell',
      description: 'Rotate one cell 90 degrees clockwise. Returns a flag {FLG:...} when puzzle is solved.',
      parameters: {
        type: 'object',
        properties: {
          cell: { type: 'string', description: 'Cell address like "2x3" (row 1-3 top-to-bottom, col 1-3 left-to-right)' },
        },
        required: ['cell'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reset_board',
      description: 'Reset board to initial state. Use only if you need to start over.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const toolHandlers = { get_board_state: getBoardState, rotate_cell: rotateCell, reset_board: resetBoard };

// Pre-compute current state before starting the agent
console.log('Fetching current board state...');
const currentData = await fetchData('electricity.json');
const currentBoard = {
  '1x1': currentData[0][0], '1x2': currentData[0][1], '1x3': currentData[0][2],
  '2x1': currentData[1][0], '2x2': currentData[1][1], '2x3': currentData[1][2],
  '3x1': currentData[2][0], '3x2': currentData[2][1], '3x3': currentData[2][2],
};

console.log('\nCurrent board:'); console.log(formatBoard(currentBoard));
console.log('\nSolved board:');  console.log(formatBoard(SOLVED_BOARD));

const systemPrompt = `You are an agent solving an electrical cable puzzle on a 3x3 grid.

GRID COORDINATES (RowxCol, row 1=top, col 1=left):
1x1 | 1x2 | 1x3
2x1 | 2x2 | 2x3
3x1 | 3x2 | 3x3

BITMASK ENCODING — each cell value = sum of its active connections:
  top=1, right=2, bottom=4, left=8
  Examples: 3=top+right, 5=top+bottom, 6=right+bottom, 9=top+left, 10=left+right, 7=top+right+bottom, 11=top+right+left, 14=right+bottom+left

ROTATION MECHANICS — each rotate_cell call rotates 90 degrees clockwise:
  top→right, right→bottom, bottom→left, left→top
  Formula: new_value = ((val & 8) >> 3) | ((val & 7) << 1)
  Full cycles: 1→2→4→8→1, 3→6→12→9→3, 5→10→5, 7→14→13→11→7, 15→15

YOUR TASK:
1. For each cell, compare current value to target value
2. Apply the rotation formula to find how many clockwise rotations (0, 1, 2, or 3) reach the target
3. Call rotate_cell that many times for each cell that needs rotating
4. When rotate_cell response contains "FLG" — report the flag, you are done!
5. Use get_board_state to verify progress if needed. Use reset_board if you need to start over.`;

const initialMessages = [
  {
    role: 'user',
    content: `CURRENT board state (bitmask per cell):
${formatBoard(currentBoard)}

TARGET board state (bitmask per cell):
${formatBoard(SOLVED_BOARD)}

Calculate rotations needed for each cell and execute them now.`,
  },
];

console.log('\nStarting agent...');
const result = await agent(systemPrompt, tools, toolHandlers, MODELS.GPT4O, 50, initialMessages);
console.log('\nAgent result:', result);
