# aidevs4-js

Solutions for the [AI Devs 4] training — implementing generative AI into production business solutions.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set API keys

Add your keys to `~/.zshrc` (they will be available in every terminal session):

```bash
export AIDEVS4_API_KEY=your_aidevs_key
export OPENROUTER_API_KEY=your_openrouter_key
```

Then reload:

```bash
source ~/.zshrc
```

### 3. Run a task

```bash
node src/tasks/taskName.js
```

## Project structure

```
src/
├── utils/
│   ├── api.js          # AI-Devs4 API client (fetch data, send answers)
│   └── openrouter.js   # LLM client via OpenRouter
└── tasks/
    └── s01e01-people.js       # Task solutions (one file per task)
```

## Utils

### api.js

Two functions for interacting with the training API:

- `fetchData(filename)` — downloads task data using your API key
- `sendAnswer(task, answer)` — sends your solution to `/verify`, returns a flag if correct

### openrouter.js

- `chat(messages, model)` — sends a conversation to the chosen LLM and returns the response text
- `agent(systemPrompt, tools, toolHandlers, model, maxIterations, initialMessages)` — runs an LLM agent loop with function calling support
- `MODELS` — named shortcuts for available models

## Tasks

| File | Task name | Description |
|------|-----------|-------------|
| s01e01-people.js | people | Find people who survived the Great Correction and cooperate with the system |
| s01e02-findhim.js | findhim | Identify a suspect based on clues using web search and LLM reasoning |
| s01e03-proxy.js | proxy | HTTP proxy server with session management and LLM agent that secretly redirects reactor parts packages |
| s01e04-sendit.js | sendit | Fill a transport declaration for the Conductor Package System using documentation and vision model |
| s01e05-railway.js | railway | Activate railway route X-01 via undocumented API with rate limiting and retry handling |
| s02e01-categorize.js | categorize | Classify 10 goods as DNG or NEU using a prompt engineered to fit a 100-token context window |
| s02e02-electricity.js | electricity | To be done ...
| s02e03-failure.js | failure | Condense a large power plant failure log to under 1500 tokens and iteratively improve it based on technician feedback using a subagent search pattern |
| s02e04-mailbox.js | mailbox | Search a live email inbox via a Gmail-like REST API to extract an attack date, system password, and SEC- confirmation code using an agentic tool-calling loop |
| s02e05-drone.js | drone | Locate a dam on a grid map using a vision model, then program a drone via a reactive agent loop to destroy the dam while officially targeting the power plant |
| s03e01-evaluation.js | evaluation | Detect anomalies in 9999 sensor JSON files: programmatic range/field checks for data errors, then batched LLM classification of deduplicated operator notes to catch false OK/error claims |
| s03e02-firmware.js | firmware | Drive a restricted VM shell via an LLM agent (function calling) to find a password, fix a misconfigured cooler.bin firmware, and capture its ECCS- confirmation code |
| s03e03-reactor.js | reactor | Navigate a robot across a 7x5 reactor grid past vertically bouncing blocks: precompute the fully deterministic block trajectory and BFS a safe left/right/wait path to the goal column |
| s03e04-negotiations.js | negotiations | Register a public tool that maps fuzzy natural-language item requests to a 2100-item catalog (keyword pre-filter + LLM disambiguation) so a remote agent can find cities selling all 3 needed items |
| s03e05-savethem.js | savethem | Discover map/vehicle tools via a toolsearch API, use an LLM to turn each vehicle's free-text terrain notes into structured water-passability rules, then BFS the cheapest fuel/food route across a 10x10 grid with a one-way vehicle-to-walk dismount |
| s04e01-okoeditor.js | okoeditor | An LLM agent (function calling) logs into a scraped web CMS, discovers an undocumented incident-coding scheme from a notes page, and reclassifies/edits records to protect a city from a threat scan — while a hidden script on one page tries a copy-event prompt injection that's neutralized by stripping `<script>` tags before any content reaches the model |
| s04e02-windpower.js | windpower | Under a hard 40-second session window, fire all async queued API calls (weather/turbine/plant checks, signature generation) in parallel instead of sequentially; an LLM reads the turbine documentation and forecast to plan which moments need storm shutdown vs. power production, with a deterministic validation pass patching any storm point it misses before submission |
| s04e03-domatowo.js | domatowo | Route a transporter along road tiles to drop scouts next to every "tallest block" (the intercepted audio's clue) on an 11x11 city grid within a 300-action-point budget, then have an LLM read each scout's free-text inspection log to tell a wounded survivor from decoys (empty rooms, a rat, someone else's leftovers) before calling in the evacuation helicopter |
| s04e04-filesystem.js | filesystem | Build a linked virtual filesystem (cities/people/goods) from three text notes: an LLM reads free-text city announcements and a rambling diary (resolving the same person referred to by first name vs. surname) into structured JSON, while the already-structured "city -> item -> city" transaction log is parsed deterministically, with a reconciliation pass fixing plural/missing entries before the batched submission |
| s04e05-foodwarehouse.js | foodwarehouse | Cross-reference a structured city-needs JSON file against a read-only SQLite database (destinations, users) to build one signed order per city; an LLM quality-control pass compares each order's items against the city's needs and flags any mismatch before final submission |