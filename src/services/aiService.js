const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { env } = require('../config');
const logger = require('../utils/logger');

let openai;
let geminiClients = [];
let currentKeyIndex = 0;

if (env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
  });
}

if (env.GEMINI_API_KEYS) {
  // Support comma-separated keys for RPM rotation load balancing
  const keys = env.GEMINI_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  for (const key of keys) {
    geminiClients.push(new GoogleGenerativeAI(key));
  }
}

/**
 * Privacy Guard: Scrubs highly sensitive patterns before sending to external LLM servers.
 */
function sanitizeForAI(text) {
  let safeText = text;
  safeText = safeText.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL]');
  safeText = safeText.replace(/\b\d{6,16}\b/g, '[NUMBER]');
  return safeText;
}

/**
 * Generates an AI smart reply wrapping the LLM response in a strict Timeout boundary.
 * Natively supports swapping between Google Gemini arrays and OpenAI based on ENV bindings.
 */
async function generateSmartReply(lastMessage) {
  if (!env.FEATURE_AI_ENABLED || (!openai && !geminiClients.length)) {
    return [];
  }

  const safeMessage = sanitizeForAI(lastMessage);
  const strictSystemPrompt = "You are generating short, helpful 3-6 word smart replies for a chat system. Provide exactly three options separated by a pipe '|'. Example: Yes, I can|No sorry|Maybe later";

  const fetchAI = async () => {
    let replyStr = "";

    if (geminiClients.length > 0) {
      // Free-Tier Load Balancing Rotation
      const gemini = geminiClients[currentKeyIndex];
      currentKeyIndex = (currentKeyIndex + 1) % geminiClients.length; // Round-Robin pointer shift

      const model = gemini.getGenerativeModel({ model: "gemini-2.5-flash" });
      const prompt = `${strictSystemPrompt}\nUser Message: ${safeMessage}\nAI Smart Reply Options:`;
      const result = await model.generateContent(prompt);
      replyStr = result.response.text();
    } else if (openai) {
      // Fallback to OpenAI if Gemini is not mapped
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: strictSystemPrompt },
          { role: "user", content: safeMessage }
        ],
        max_tokens: 30,
      });
      replyStr = response.choices[0].message.content;
    }

    return replyStr.split('|').map(s => s.trim()).filter(Boolean).slice(0, 3);
  };

  const timeoutFetch = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('LLM Engine Timeout')), env.AI_TIMEOUT_MS);
  });

  try {
    const replies = await Promise.race([fetchAI(), timeoutFetch]);
    return replies;
  } catch (error) {
    logger.error({ err: error.message }, 'AI Generate failed or timed out (Graceful degradation active)');
    return []; // Fail silently, chat must go on natively
  }
}

module.exports = {
  generateSmartReply,
  sanitizeForAI
};
