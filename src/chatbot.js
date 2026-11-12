'use strict';

function isBotUser(user) {
  if (!user || typeof user !== 'object') return false;

  const username = String(user.username || '').trim().toLowerCase();
  const fullName = String(user.fullName || '').trim().toLowerCase();

  return username.split(/[\s._-]+/).includes('bot') ||
         fullName.split(/\s+/).includes('bot');
}

function buildBotReply(message = '') {
  const text = String(message || '').trim().toLowerCase();

  if (!text) {
    return 'Hello! I am Chimic AI. How can I help you today?';
  }

  if (/\b(hello|hi|hey)\b/.test(text)) {
    return 'Hello! Welcome to Chimic Connect. How can I assist you?';
  }

  if (/\b(help|support)\b/.test(text)) {
    return 'I am Chimic AI. I can help with app features, messaging and general questions.';
  }

  return 'I am Chimic AI. Please send your question so I can assist you.';
}

const chatbotApi = {
  isBotUser,
  buildBotReply
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = chatbotApi;
}

if (typeof window !== 'undefined') {
  window.isBotUser = isBotUser;
  window.buildBotReply = buildBotReply;
  window.ChimikChatbot = chatbotApi;
}
