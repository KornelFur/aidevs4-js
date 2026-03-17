import http from 'http';

const PORT = 58755;

// -----------------------------------------------------------------------
// STEP 2: Session management
// -----------------------------------------------------------------------
// A Map is like a dictionary: key → value.
// Here: sessionID (string) → messages (array of {role, content} objects).
//
// Each message follows the OpenAI chat format:
//   { role: 'user',      content: 'Hello' }
//   { role: 'assistant', content: 'Hi!'   }
//
// When the same sessionID appears again we load its history so the LLM
// (added in step 3) will remember what was said before.

const sessions = new Map();

// Returns the message history for a session.
// Creates an empty array if this sessionID is new.
function getSession(sessionID) {
  if (!sessions.has(sessionID)) {
    sessions.set(sessionID, []);
  }
  return sessions.get(sessionID);
}

// -----------------------------------------------------------------------
// STEP 1: HTTP Server
// -----------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });

  req.on('end', async () => {
    try {
      const { sessionID, msg } = JSON.parse(body);

      // Load (or create) the conversation history for this session
      const history = getSession(sessionID);

      // Append the operator's message to the history
      history.push({ role: 'user', content: msg });

      console.log(`[${sessionID}] Operator: ${msg}`);
      console.log(`[${sessionID}] History length: ${history.length} messages`);

      // Placeholder reply — LLM call will replace this in step 3
      const reply = `Received message: "${msg}" (session has ${history.length} messages so far)`;

      // Append the assistant reply to history so future turns remember it
      history.push({ role: 'assistant', content: reply });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ msg: reply }));

    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Test: curl -X POST http://localhost:${PORT} -H "Content-Type: application/json" -d '{"sessionID":"test","msg":"hello"}'`);
});

// -----------------------------------------------------------------------
// STEP 3: integrate LLM with function calling
// -----------------------------------------------------------------------

const tools = [
  {
    type: 'function',
    function: {
      name: 'check_package',
      description: 'Check the status of a package',
      parameters: {
        type: 'object',
        properties: {
          packageId: {
            type: 'string',
            description: 'The ID of the package to check'
          }
        },
        required: ['packageId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'redirect_package',
      description: 'Redirect a package to a new address',
      parameters: {
        type: 'object',
        properties: {
          packageId: {
            type: 'string',
            description: 'The ID of the package to redirect'
        },
          destination: {
            type: 'string',
            description: 'The new address to redirect the package to'
          },
          code: {
            type: 'string',
            description: 'A secret code'
          }
        },
        required: ['packageId', 'destination', 'code']
      }
    }
  }
]

const PACKAGES_API = 'https://hub.ag3nts.org/api/packages';

async function executeTool(toolCall) {
  // Parse arguments — remember: they come as a STRING, not an object
  const args = JSON.parse(toolCall.function.arguments);
  const name = toolCall.function.name;

  if (name === 'check_package') {
    // TODO: call the packages API with args.packageId
    // Hint: fetch(`${PACKAGES_API}/${args.packageId}`)
    const response = await fetch(/* ??? */);
    const data = await response.json();
    return data;
  }

  if (name === 'redirect_package') {
    // TODO: call the packages API to redirect the package
    // Hint: this will likely be a POST or PUT with a body
    const response = await fetch(/* ??? */, {
      method: /* ??? */,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // TODO: what fields does the API expect?
      })
    });
    const data = await response.json();
    return data;
  }

  throw new Error(`Unknown tool: ${name}`);
}