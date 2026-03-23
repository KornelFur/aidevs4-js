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
