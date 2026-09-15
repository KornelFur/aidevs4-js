import axios from 'axios';
import { API_KEY, sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

const HUB = 'https://hub.ag3nts.org';
const GOAL_CITY = 'Skolwin';
const FUEL_BUDGET = 10;
const FOOD_BUDGET = 10;
const VEHICLE_NAMES = ['rocket', 'horse', 'walk', 'car'];

// -----------------------------------------------------------------------
// Tool discovery — we're only given the toolsearch endpoint and have to
// find the "maps" and "wehicles" tools ourselves, the way the mission
// agent is meant to.
// -----------------------------------------------------------------------

async function searchTool(query) {
  const { data } = await axios.post(`${HUB}/api/toolsearch`, { apikey: API_KEY, query });
  if (!data.tools || data.tools.length === 0) throw new Error(`No tool found for query: "${query}"`);
  return data.tools[0].url;
}

async function callTool(url, query) {
  const { data } = await axios.post(`${HUB}${url}`, { apikey: API_KEY, query });
  return data;
}

async function loadVehicles(wehiclesUrl) {
  const vehicles = {};
  for (const name of VEHICLE_NAMES) {
    vehicles[name] = await callTool(wehiclesUrl, name);
  }
  return vehicles;
}

// -----------------------------------------------------------------------
// The only place each vehicle's terrain restrictions exist is in a
// free-text "note" field (e.g. "cannot drive on water, entering a water
// tile means the vehicle is lost immediately"). Turning that prose into a
// structured rule is a genuine NLU task, so we hand it to an LLM instead
// of writing brittle keyword matching.
// -----------------------------------------------------------------------

async function extractWaterRules(vehicles) {
  const notes = VEHICLE_NAMES.map((name) => `${name}: ${vehicles[name].note}`).join('\n\n');

  const prompt = `Below are descriptions of travel modes in a route-planning game. For each one, decide what happens when it enters a WATER tile:
- "passable": it can safely move through water
- "fatal": entering water ends the mission in failure

Descriptions:
${notes}

Reply with ONLY a JSON object like {"rocket": "fatal", "horse": "passable", "walk": "passable", "car": "fatal"}, no other text.`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O_MINI);
  const json = response.match(/\{[\s\S]*\}/);
  if (!json) throw new Error(`Could not parse water rules from LLM response: ${response}`);
  return JSON.parse(json[0]);
}

// -----------------------------------------------------------------------
// Pathfinding. Rock/tree tiles are physical obstacles that block every
// travel mode (confirmed empirically: attempting to step on one aborts
// the whole route with "hits a rock/tree at step N"). Water is only
// crossable by modes the LLM marked as "passable" above.
//
// The mission rules only allow ONE transition: leave your starting
// vehicle and continue on foot — you can never remount or swap to a
// different vehicle afterwards. So the optimal route is: ride the
// cheapest capable vehicle as far as possible, dismount once (right
// before wherever it can't go further), then walk the rest.
//
// We compute this by taking, for every vehicle, a forward BFS distance
// map from the start (using that vehicle's passability) and a backward
// BFS distance map from the goal (using walk's passability, since the
// remainder is always on foot), then pick the dismount point and
// vehicle that reaches the goal within the fuel/food budget in the
// fewest total moves.
// -----------------------------------------------------------------------

const DIRECTIONS = [
  ['up', -1, 0],
  ['down', 1, 0],
  ['left', 0, -1],
  ['right', 0, 1],
];

function findChar(map, char) {
  for (let row = 0; row < map.length; row++) {
    const col = map[row].indexOf(char);
    if (col !== -1) return { row, col };
  }
  throw new Error(`Character "${char}" not found on map`);
}

function isPassable(map, row, col, vehicle, waterRules) {
  if (row < 0 || row >= map.length || col < 0 || col >= map[row].length) return false;
  const cell = map[row][col];
  if (cell === 'R' || cell === 'T') return false;
  if (cell === 'W') return waterRules[vehicle] === 'passable';
  return true;
}

// BFS from `from`, returns { distance: Map<"row,col", number>, prev: Map<"row,col", ["row,col", direction]> }
function bfs(map, from, vehicle, waterRules) {
  const key = (r, c) => `${r},${c}`;
  const distance = new Map([[key(from.row, from.col), 0]]);
  const prev = new Map();
  const queue = [from];

  while (queue.length > 0) {
    const { row, col } = queue.shift();
    const d = distance.get(key(row, col));

    for (const [dirName, dRow, dCol] of DIRECTIONS) {
      const nRow = row + dRow;
      const nCol = col + dCol;
      if (!isPassable(map, nRow, nCol, vehicle, waterRules)) continue;
      const nKey = key(nRow, nCol);
      if (distance.has(nKey)) continue;
      distance.set(nKey, d + 1);
      prev.set(nKey, [key(row, col), dirName]);
      queue.push({ row: nRow, col: nCol });
    }
  }

  return { distance, prev };
}

function reconstructDirections(prev, from, to) {
  const key = (r, c) => `${r},${c}`;
  const directions = [];
  let cur = key(to.row, to.col);
  const start = key(from.row, from.col);

  while (cur !== start) {
    const [prevKey, dirName] = prev.get(cur);
    directions.push(dirName);
    cur = prevKey;
  }

  return directions.reverse();
}

function planRoute(map, vehicles, waterRules) {
  const start = findChar(map, 'S');
  const goal = findChar(map, 'G');

  // Walked backward from the goal, using walk's own passability, since
  // every route ends on foot.
  const walkFromGoal = bfs(map, goal, 'walk', waterRules);

  let best = null;

  for (const vehicleName of VEHICLE_NAMES) {
    const consumption = vehicles[vehicleName].consumption;
    const fromStart = bfs(map, start, vehicleName, waterRules);

    for (const [posKey, vehicleMoves] of fromStart.distance) {
      const walkMoves = walkFromGoal.distance.get(posKey);
      if (walkMoves === undefined) continue; // not connected to goal on foot

      const fuelUsed = vehicleMoves * consumption.fuel;
      const foodUsed = vehicleMoves * consumption.food + walkMoves * vehicles.walk.consumption.food;
      const totalMoves = vehicleMoves + walkMoves;

      if (fuelUsed > FUEL_BUDGET || foodUsed > FOOD_BUDGET) continue;

      const [row, col] = posKey.split(',').map(Number);

      if (!best || totalMoves < best.totalMoves) {
        best = { vehicleName, dismountPos: { row, col }, vehicleMoves, walkMoves, totalMoves, fuelUsed, foodUsed, fromStart };
      }
    }
  }

  if (!best) throw new Error('No feasible route found within fuel/food budget.');

  const vehicleDirections = reconstructDirections(best.fromStart.prev, start, best.dismountPos);
  const walkDirections = reconstructDirections(walkFromGoal.prev, goal, best.dismountPos).reverse().map((dirName) => {
    // walkFromGoal was built walking from goal outward, so its directions
    // need reversing (up<->down, left<->right) to describe goal-ward travel.
    return { up: 'down', down: 'up', left: 'right', right: 'left' }[dirName];
  });

  const answer = [best.vehicleName, ...vehicleDirections];
  if (walkDirections.length > 0) {
    if (best.vehicleName !== 'walk') answer.push('dismount');
    answer.push(...walkDirections);
  }

  console.log(`Plan: ${best.vehicleName} for ${best.vehicleMoves} moves, then walk for ${best.walkMoves} moves.`);
  console.log(`Fuel used: ${best.fuelUsed.toFixed(1)}/${FUEL_BUDGET}, food used: ${best.foodUsed.toFixed(1)}/${FOOD_BUDGET}`);

  return answer;
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

const mapsUrl = await searchTool('map of the terrain');
const wehiclesUrl = await searchTool('vehicles available for travel');

const mapData = await callTool(mapsUrl, GOAL_CITY);
const map = mapData.map;

const vehicles = await loadVehicles(wehiclesUrl);
const waterRules = await extractWaterRules(vehicles);
console.log('Water passability (LLM-derived):', waterRules);

const answer = planRoute(map, vehicles, waterRules);
console.log('Submitting route:', answer);

const result = await sendAnswer('savethem', answer);
console.log(result);
