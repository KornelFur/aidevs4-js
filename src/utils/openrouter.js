import axios from 'axios';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const MODELS = {
  GPT4O: 'openai/gpt-4o',
  GPT4O_MINI: 'openai/gpt-4o-mini',
  GPT5_MINI: 'openai/gpt-5-mini',
  GPT5: 'openai/gpt-5',
  GEMINI3_1: 'google/gemini-3.1-flash-lite-preview',
  GEMINI3_FLASH: 'google/gemini-3-flash-preview',
};

export async function chat(messages, model) {
  const response = await axios.post(
    BASE_URL,
    {
      model: model,
      messages: messages,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.choices[0].message.content;
}

// Agent with Function Calling support
// toolHandlers is an object mapping tool names to their JS functions:
export async function agent(systemPrompt, tools, toolHandlers, model, maxIterations = 20, initialMessages = []) {
  const messages = [{ role: 'system', content: systemPrompt }, ...initialMessages];

  for (let i = 0; i < maxIterations; i++) {
    const response = await axios.post(
      BASE_URL,
      { model, messages, tools },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const message = response.data.choices[0].message;
    // add the assistant's response to the conversation history
    messages.push(message);

    // if no tool calls — LLM is done, return final text answer
    if (!message.tool_calls) {
      return message.content;
    }

    // execute each tool the LLM requested
    for (const toolCall of message.tool_calls) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      console.log(`Agent calling tool: ${toolName}`, args);

      const handler = toolHandlers[toolName];
      if (!handler) throw new Error(`Unknown tool: ${toolName}`);

      const result = await handler(args);

      // return the tool result back to the LLM
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
  throw new Error('Agent exceeded maximum iterations');
}
