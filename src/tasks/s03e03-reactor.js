import { sendAnswer } from '../utils/api.js';

// -----------------------------------------------------------------------
// OVERVIEW
// -----------------------------------------------------------------------
// 7x5 reactor board. Player always walks along row 5 (bottom row), moving
// left/right one column per command. Reactor blocks occupy exactly 2 rows
// in a column and bounce up/down between row 1 and row 5. The whole
// simulation only advances when we send a command (start/left/right/wait) —
// it's fully deterministic, so instead of reacting turn-by-turn we
// precompute the entire block trajectory and BFS a safe path from
// col 1 to col 7 up front, then just replay the resulting commands.
//
// Collision rule (confirmed by testing against the live API): after a
// command resolves, the player is crushed if the block in its column has
// bottom_row === 5 (i.e. its lower half is sitting on the ground row).

const ROWS = 5;
const COLS = 7;

function stepBlocks(blocks) {
  return blocks.map(b => {
    let top, bottom, direction;
    if (b.direction === 'down') {
      top = b.top_row + 1;
      bottom = b.bottom_row + 1;
      direction = bottom >= ROWS ? 'up' : 'down';
    } else {
      top = b.top_row - 1;
      bottom = b.bottom_row - 1;
      direction = top <= 1 ? 'down' : 'up';
    }
    return { col: b.col, top_row: top, bottom_row: bottom, direction };
  });
}

function isColSafe(blocks, col) {
  return !blocks.some(b => b.col === col && b.bottom_row === ROWS);
}

// BFS over (col, tick) — block positions at any future tick are fully
// known in advance, so we just need the shortest safe column path.
function findPath(initialBlocks, startCol) {
  const blocksAtTick = [initialBlocks];
  const blocksAt = t => {
    while (blocksAtTick.length <= t) blocksAtTick.push(stepBlocks(blocksAtTick[blocksAtTick.length - 1]));
    return blocksAtTick[t];
  };

  const moves = [
    { cmd: 'right', delta: 1 },
    { cmd: 'wait', delta: 0 },
    { cmd: 'left', delta: -1 },
  ];

  const visited = new Set([`${startCol},0`]);
  const queue = [{ col: startCol, t: 0, path: [] }];

  while (queue.length > 0) {
    const { col, t, path } = queue.shift();
    if (col === COLS) return path;

    for (const { cmd, delta } of moves) {
      const newCol = Math.min(COLS, Math.max(1, col + delta));
      const newT = t + 1;
      const key = `${newCol},${newT}`;
      if (visited.has(key)) continue;
      if (!isColSafe(blocksAt(newT), newCol)) continue;
      visited.add(key);
      queue.push({ col: newCol, t: newT, path: [...path, cmd] });
    }
  }
  throw new Error('No safe path found to the goal.');
}

console.log('=== Initializing reactor board ===');
let state = await sendAnswer('reactor', { command: 'start' });
console.log(JSON.stringify(state.board, null, 0));

const path = findPath(state.blocks, state.player.col);
console.log(`\n=== Planned path (${path.length} moves) ===`);
console.log(path.join(', '));

console.log('\n=== Executing ===');
for (const cmd of path) {
  try {
    state = await sendAnswer('reactor', { command: cmd });
  } catch (e) {
    console.log('Move failed:', JSON.stringify(e.response?.data ?? e.message, null, 2));
    break;
  }
  console.log(`${cmd} ->`, JSON.stringify(state));
  if (state.reached_goal || state.player === undefined) break;
}

console.log('\n=== Final state ===');
console.log(JSON.stringify(state, null, 2));
