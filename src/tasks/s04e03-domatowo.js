import { sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// Intercepted audio gives the key clue: the survivor is hiding in "one of
// the tallest blocks" (block3 = 3-story buildings, symbol "B3" on the
// map). Everything else (routing transporters/scouts, spending action
// points) is a logistics/pathfinding problem, best solved deterministically
// to stay well inside the 300-point budget. The one place that genuinely
// needs an LLM is reading each scout's free-text inspection log and
// judging whether it describes the wounded, armed survivor from the
// transcript, as opposed to a decoy (an empty room, a rat, etc.).
// -----------------------------------------------------------------------

const TRANSCRIPT = 'Przeżyłem. Bomby zniszczyły miasto. Żołnierze tu byli, szukali surowców, zabrali ropę. Teraz jest pusto. Mam broń, jestem ranny. Ukryłem się w jednym z najwyższych bloków. Nie mam jedzenia. Pomocy.';

async function call(answer) {
  return sendAnswer('domatowo', answer);
}

// -----------------------------------------------------------------------
// Coordinate helpers ("F1" <-> {row, col}, 0-indexed)
// -----------------------------------------------------------------------

function parseCoord(coord) {
  const col = coord.charCodeAt(0) - 'A'.charCodeAt(0);
  const row = parseInt(coord.slice(1), 10) - 1;
  return { row, col };
}

function formatCoord({ row, col }) {
  return `${String.fromCharCode('A'.charCodeAt(0) + col)}${row + 1}`;
}

function neighbors({ row, col }) {
  return [
    { row: row - 1, col },
    { row: row + 1, col },
    { row, col: col - 1 },
    { row, col: col + 1 },
  ];
}

function manhattan(a, b) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

// -----------------------------------------------------------------------
// Group the found block3 tiles into connected clusters (buildings), and
// for each cluster find one adjacent road tile a transporter can reach.
// -----------------------------------------------------------------------

function clusterTiles(coords) {
  const points = coords.map(parseCoord);
  const key = (p) => `${p.row},${p.col}`;
  const pointSet = new Set(points.map(key));
  const visited = new Set();
  const clusters = [];

  for (const start of points) {
    if (visited.has(key(start))) continue;
    const cluster = [];
    const queue = [start];
    visited.add(key(start));

    while (queue.length > 0) {
      const p = queue.shift();
      cluster.push(p);
      for (const n of neighbors(p)) {
        if (pointSet.has(key(n)) && !visited.has(key(n))) {
          visited.add(key(n));
          queue.push(n);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function findRoadEntry(cluster, grid) {
  for (const tile of cluster) {
    for (const n of neighbors(tile)) {
      if (n.row < 0 || n.row >= grid.length || n.col < 0 || n.col >= grid[0].length) continue;
      if (grid[n.row][n.col] === 'road') return { entry: n, firstTile: tile };
    }
  }
  throw new Error(`No road-adjacent entry found for cluster: ${cluster.map(formatCoord).join(', ')}`);
}

// Small clusters (4-6 tiles) — a greedy nearest-neighbor walk from the
// entry point is good enough, no need for exact TSP.
function tourOrder(cluster, startTile) {
  const remaining = [...cluster];
  const order = [];
  let current = startTile;
  while (remaining.length > 0) {
    remaining.sort((a, b) => manhattan(current, a) - manhattan(current, b));
    current = remaining.shift();
    order.push(current);
  }
  return order;
}

// -----------------------------------------------------------------------
// Ask the LLM whether a scout's inspection log describes the survivor
// from the transcript, as opposed to a decoy.
// -----------------------------------------------------------------------

async function isSurvivorFound(logMessage) {
  const prompt = `Przechwycony sygnał audio od ocalałego: "${TRANSCRIPT}"

Zwiadowca właśnie przeszukał pomieszczenie i zgłosił: "${logMessage}"

Czy ten raport opisuje odnalezienie RANNEGO, UZBROJONEGO ocalałego pasującego do powyższego sygnału (a nie np. pustego pokoju, zwierzęcia, śladów po kimś innym, itp.)? Odpowiedz WYŁĄCZNIE "YES" albo "NO".`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O_MINI);
  return response.trim().toUpperCase().startsWith('YES');
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

console.log('Resetting board...');
console.log(await call({ action: 'reset' }));

console.log('Loading map and block3 (tallest building) locations...');
const mapData = await call({ action: 'getMap' });
const grid = mapData.map.grid;
const symbolSearch = await call({ action: 'searchSymbol', symbol: 'B3' });
const blockCoords = symbolSearch.found.map((f) => f.position);
console.log('Block3 tiles:', blockCoords);

const clusters = clusterTiles(blockCoords).map((cluster) => {
  const { entry, firstTile } = findRoadEntry(cluster, grid);
  const order = tourOrder(cluster, firstTile);
  return { entry, order };
});
console.log(`Found ${clusters.length} building clusters to search.`);

// Order stops to minimize backtracking: nearest entry point first.
const spawn = { row: 5, col: 0 }; // spawn slots are A6..D6
clusters.sort((a, b) => manhattan(spawn, a.entry) - manhattan(spawn, b.entry));

console.log('Creating transporter with one scout per cluster...');
const transporter = await call({ action: 'create', type: 'transporter', passengers: clusters.length });
const transporterId = transporter.object;

let survivorField = null;
const knownScoutIds = new Set();

for (const cluster of clusters) {
  if (survivorField) break;

  const entryCoord = formatCoord(cluster.entry);
  console.log(`Moving transporter to ${entryCoord}...`);
  await call({ action: 'move', object: transporterId, where: entryCoord });

  console.log('Dismounting one scout...');
  await call({ action: 'dismount', object: transporterId, passengers: 1 });

  const objects = await call({ action: 'getObjects' });
  const scout = objects.objects.find((o) => o.typ === 'scout' && !knownScoutIds.has(o.id));
  const scoutId = scout.id;
  knownScoutIds.add(scoutId);

  let currentPos = parseCoord(scout.position);

  for (const target of cluster.order) {
    const targetCoord = formatCoord(target);
    if (formatCoord(currentPos) !== targetCoord) {
      console.log(`Scout moving to ${targetCoord}...`);
      await call({ action: 'move', object: scoutId, where: targetCoord });
      currentPos = target;
    }

    console.log(`Inspecting ${targetCoord}...`);
    await call({ action: 'inspect', object: scoutId });
    const logs = await call({ action: 'getLogs' });
    const entry = logs.logs.filter((l) => l.scout === scoutId).pop();
    console.log(`  -> ${entry.msg}`);

    if (await isSurvivorFound(entry.msg)) {
      console.log(`Survivor found at ${targetCoord}!`);
      survivorField = targetCoord;
      break;
    }
  }
}

if (!survivorField) throw new Error('Searched every block3 tile and did not find the survivor.');

console.log(`Calling helicopter to ${survivorField}...`);
const result = await call({ action: 'callHelicopter', destination: survivorField });
console.log(result);
