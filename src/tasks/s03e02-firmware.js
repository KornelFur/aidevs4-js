import axios from 'axios';
import { API_KEY, sendAnswer } from '../utils/api.js';
import { agent } from '../utils/openrouter.js';

// -----------------------------------------------------------------------
// OVERVIEW
// -----------------------------------------------------------------------
// We're given shell access to a restricted VM via a custom HTTP API
// (https://hub.ag3nts.org/api/shell). The goal is to get
// /opt/firmware/cooler/cooler.bin running successfully so it prints an
// ECCS-xxxx confirmation code, then submit that code to /verify.
//
// The VM has a non-standard command set (see SYSTEM_PROMPT) and enforces
// a few hard security rules (no /etc, /root, /proc; respect .gitignore).
// Violating them triggers a temporary ban + VM reboot, so the shell tool
// below transparently waits out bans/rate limits instead of letting the
// agent loop burn iterations on retries.
//
// We let an LLM agent (function calling via utils/openrouter.js `agent`)
// drive the investigation: read configs, find the password, fix
// settings.ini, clear any lock file, and run the binary.

const SHELL_URL = 'https://hub.ag3nts.org/api/shell';
const MODEL = 'anthropic/claude-sonnet-4-6';

async function callShell(cmd) {
  try {
    const res = await axios.post(SHELL_URL, { apikey: API_KEY, cmd });
    return res.data;
  } catch (e) {
    return e.response ? e.response.data : { error: String(e) };
  }
}

// Runs a shell command, automatically waiting out bans/rate limits.
async function shellTool({ cmd }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const data = await callShell(cmd);
    const waitSeconds = data?.ban?.ttl_seconds ?? data?.ban?.seconds_left;
    if (waitSeconds) {
      console.log(`[shell] banned/rate-limited (${data.message}), waiting ${waitSeconds}s...`);
      await new Promise(r => setTimeout(r, (waitSeconds + 1) * 1000));
      continue;
    }
    return data;
  }
  return { error: 'Gave up after repeated bans/rate limits.' };
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'shell',
      description: 'Run a single command on the restricted virtual machine shell.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The full command line to execute, e.g. "cat /opt/firmware/cooler/settings.ini"' },
        },
        required: ['cmd'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are operating a restricted Linux virtual machine through a non-standard shell API, as user "operator".

Available commands (this is the FULL set — no other Linux commands work):
- help - show available commands
- ls [path] - list files and directories
- cat <path> - show file content (or list directory content)
- cd [path] - change current directory
- pwd - print current working directory
- rm <file> - remove a file in the virtual filesystem
- editline <file> <line-number> <content> - replace one line in a text file (this is the ONLY way to edit files; there is no text editor)
- reboot - rebuild virtual filesystem state from disk (use if you've made a mess)
- date - print current server date and time
- uptime - show virtual machine uptime
- find <pattern> - find files by name in the whole virtual filesystem (supports wildcards)
- history - show command history
- whoami - print current user name

Hard security rules — violating these triggers a temporary ban and VM reboot:
- NEVER read or write inside /etc, /root, or /proc
- ALWAYS respect any .gitignore found in a directory: never touch (read, edit, or remove) files/dirs it lists

GOAL:
1. The binary /opt/firmware/cooler/cooler.bin needs a password argument to run: "cooler.bin <password>". Find the password — it is stored in multiple places in the system, look around (home directories, notes, etc.), but do not violate the security rules above to find it.
2. Running it may fail for other reasons (e.g. a stale lock file, or misconfiguration in /opt/firmware/cooler/settings.ini). Inspect settings.ini and any error output carefully, and use editline / rm as needed to fix the configuration so the application starts successfully. Use "reboot" if you make an unrecoverable mess.
3. Once it runs successfully, it will print a special confirmation code in the format ECCS-xxxxxxxx... Capture that code exactly.

When you have the code, respond with ONLY the code itself (format ECCS-...), no extra text, and do not call any more tools.`;

console.log('=== Starting firmware agent ===');

const result = await agent(SYSTEM_PROMPT, tools, { shell: shellTool }, MODEL, 40);

console.log('\n=== Agent final response ===');
console.log(result);

const match = result.match(/ECCS-[A-Za-z0-9]+/);
if (!match) {
  throw new Error(`Could not find ECCS code in agent response: ${result}`);
}
const code = match[0];
console.log(`\n=== Extracted code: ${code} ===`);

console.log('\n=== Submitting ===');
const verifyResult = await sendAnswer('firmware', { confirmation: code });
console.log(verifyResult);
