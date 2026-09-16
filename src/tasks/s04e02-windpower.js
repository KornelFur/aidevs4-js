import { sendAnswer } from '../utils/api.js';
import { chat, MODELS } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// Hard 40-second session window. Weather/turbinecheck/powerplantcheck and
// unlockCodeGenerator are all queued asynchronously with unpredictable
// delays and arrive out of order via getResult (matched by
// sourceFunction), so everything is fired off in parallel and polled —
// sequential awaiting of each call would blow the budget on its own.
//
// The actual scheduling decision (which forecast points are dangerous
// storms, which single point can cover the plant's power deficit, and
// what pitch/mode each needs) is made by an LLM reading the turbine
// documentation and the forecast — that's the part requiring judgment.
// Everything else (signing, queuing, submitting) is mechanical and must
// be fast and deterministic, so it stays in plain code. A structural
// validation pass double-checks the LLM's plan against the documented
// safety threshold before anything is submitted, since a malformed
// single-shot answer inside a 40s window can't be retried cheaply.
// -----------------------------------------------------------------------

const POLL_INTERVAL_MS = 150;

async function call(answer) {
  return sendAnswer('windpower', answer);
}

// `expectedCount` results are pending on the queue; several calls (e.g.
// multiple unlockCodeGenerator requests) share the same sourceFunction
// name, so results are counted rather than deduplicated by name.
async function collectResults(expectedCount, deadlineMs) {
  const results = [];

  while (results.length < expectedCount && Date.now() < deadlineMs) {
    const res = await call({ action: 'getResult' });
    if (res.sourceFunction) {
      results.push(res);
    } else {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  return results;
}

function toApiTimestamp(timestamp) {
  // "2026-09-17 18:00:00" -> { startDate: "2026-09-17", startHour: "18:00:00" }
  const [startDate, startHour] = timestamp.split(' ');
  return { startDate, startHour };
}

// -----------------------------------------------------------------------
// Ask the LLM to turn documentation + forecast + power deficit into a
// concrete schedule. It has to (a) flag every forecast point above the
// documented cutoff wind speed for shutdown, and (b) pick one point with
// enough wind to cover the plant's power deficit at maximum blade
// efficiency (pitch 0).
// -----------------------------------------------------------------------

async function planSchedule(documentation, forecast, powerDeficitKw) {
  const compactForecast = forecast.map((p) => ({ timestamp: p.timestamp, windMs: p.windMs }));

  const prompt = `Jesteś systemem planowania pracy turbiny wiatrowej. Oto dokumentacja techniczna turbiny (JSON):
${JSON.stringify(documentation)}

Oto prognoza pogody na najbliższe dni, lista punktów {timestamp, windMs}:
${JSON.stringify(compactForecast)}

Elektrownia ma deficyt mocy: ${powerDeficitKw} kW (moc znamionowa turbiny: ${documentation.ratedPowerKw} kW).

Zadania:
1. Znajdź WSZYSTKIE punkty prognozy, w których prędkość wiatru przekracza próg bezpieczeństwa turbiny (patrz safety.cutoffWindMs w dokumentacji) — wichura, która może zniszczyć łopaty. Dla każdego takiego punktu turbina musi zostać zabezpieczona: pitchAngle 90, turbineMode "idle".
2. Znajdź DOKŁADNIE JEDEN punkt (poza wichurą), w którym wiatr jest wystarczający, by przy pitchAngle 0 (maksymalna wydajność) wygenerować moc pokrywającą deficyt elektrowni — użyj tabel windPowerYieldPercent i pitchAngleYieldPercent z dokumentacji do oszacowania mocy (ratedPowerKw * wydajność wiatru% * wydajność kąta%). Dla tego punktu ustaw pitchAngle 0, turbineMode "production".

Zwróć WYŁĄCZNIE tablicę JSON (bez żadnego innego tekstu, bez markdown) w formacie:
[{"timestamp":"YYYY-MM-DD HH:MM:SS","windMs":<liczba>,"pitchAngle":0|45|90,"turbineMode":"idle"|"production"}]`;

  const response = await chat([{ role: 'user', content: prompt }], MODELS.GPT4O_MINI);
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`Could not parse a JSON plan from the LLM response: ${response}`);
  return JSON.parse(jsonMatch[0]);
}

// Safety net: a single-shot 40-second window can't afford to discover a
// malformed LLM plan after the fact, so the plan is checked against the
// documented cutoff and patched deterministically if anything is missing.
function validatePlan(plan, forecast, cutoffWindMs) {
  const byTimestamp = new Map(plan.map((p) => [p.timestamp, p]));

  for (const point of forecast) {
    if (point.windMs < cutoffWindMs) continue;
    const planned = byTimestamp.get(point.timestamp);
    if (!planned || planned.pitchAngle !== 90 || planned.turbineMode !== 'idle') {
      console.warn(`LLM plan missing/incorrect storm protection for ${point.timestamp} (${point.windMs} m/s) — patching.`);
      byTimestamp.set(point.timestamp, { timestamp: point.timestamp, windMs: point.windMs, pitchAngle: 90, turbineMode: 'idle' });
    }
  }

  const hasProduction = [...byTimestamp.values()].some((p) => p.turbineMode === 'production');
  if (!hasProduction) {
    const fallback = forecast.find((p) => p.windMs >= 4 && p.windMs < cutoffWindMs);
    if (!fallback) throw new Error('No viable production window found in forecast.');
    console.warn(`LLM plan had no production point — patching with fallback ${fallback.timestamp}.`);
    byTimestamp.set(fallback.timestamp, { timestamp: fallback.timestamp, windMs: fallback.windMs, pitchAngle: 0, turbineMode: 'production' });
  }

  return [...byTimestamp.values()];
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

const t0 = Date.now();
const deadline = () => t0 + 39000; // leave 1s margin inside the 40s window

console.log('Starting session...');
console.log(await call({ action: 'start' }));

console.log('Fetching documentation and requesting weather/turbinecheck/powerplantcheck in parallel...');
const [documentation] = await Promise.all([
  call({ action: 'get', param: 'documentation' }),
  call({ action: 'get', param: 'weather' }),
  call({ action: 'get', param: 'turbinecheck' }),
  call({ action: 'get', param: 'powerplantcheck' }),
]);

const initialResults = await collectResults(3, deadline());
const byFn = Object.fromEntries(initialResults.map((r) => [r.sourceFunction, r]));
console.log(`Collected weather/turbinecheck/powerplantcheck at t=${Date.now() - t0}ms`);
console.log('turbinecheck:', byFn.turbinecheck);
console.log('powerplantcheck:', byFn.powerplantcheck);

const forecast = byFn.weather.forecast;

console.log('Asking LLM to plan the schedule...');
const rawPlan = await planSchedule(documentation, forecast, byFn.powerplantcheck.powerDeficitKw);
const plan = validatePlan(rawPlan, forecast, documentation.safety.cutoffWindMs);
console.log(`Plan ready at t=${Date.now() - t0}ms:`, plan);

const configPoints = plan.map((p) => ({ ...toApiTimestamp(p.timestamp), windMs: p.windMs, pitchAngle: p.pitchAngle, turbineMode: p.turbineMode }));

console.log('Requesting unlockCodeGenerator for all config points in parallel...');
await Promise.all(
  configPoints.map((p) => call({ action: 'unlockCodeGenerator', startDate: p.startDate, startHour: p.startHour, windMs: p.windMs, pitchAngle: p.pitchAngle }))
);

const signatureResults = await collectResults(configPoints.length, deadline());
console.log(`Collected ${signatureResults.length} signatures at t=${Date.now() - t0}ms`);

// Match each signature back to its config point via the echoed signedParams.
for (const sig of signatureResults) {
  const { startDate, startHour, pitchAngle } = sig.signedParams;
  const point = configPoints.find((p) => p.startDate === startDate && p.startHour === startHour && Number(pitchAngle) === p.pitchAngle);
  if (!point) throw new Error(`Could not match signature to a config point: ${JSON.stringify(sig)}`);
  point.unlockCode = sig.unlockCode;
}

if (configPoints.some((p) => !p.unlockCode)) throw new Error('Missing unlockCode for some config point.');

const configs = {};
for (const p of configPoints) {
  configs[`${p.startDate} ${p.startHour}`] = { pitchAngle: p.pitchAngle, turbineMode: p.turbineMode, unlockCode: p.unlockCode };
}

console.log('Submitting config...');
console.log(await call({ action: 'config', configs }));

console.log(`Calling done at t=${Date.now() - t0}ms`);
const result = await call({ action: 'done' });
console.log(result);
