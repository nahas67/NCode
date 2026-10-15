const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'extension', 'background.js');
let content = fs.readFileSync(target, 'utf8');

const replacements = [
  ['isChatGptUrl', 'isGeminiUrl'],
  ['CHATGPT_TAB_URLS', 'GEMINI_TAB_URLS'],
  ['chatgpt-dom.js', 'gemini-dom.js'],
  ['chatGptSignedIn', 'geminiSignedIn'],
  ['chatGptSignedInState', 'geminiSignedInState'],
  ['askChatGptSignedIn', 'askGeminiSignedIn'],
  ['chatgptId', 'geminiId'],
  ['chatgpt_tab_required', 'gemini_tab_required'],
  ['restoreOpenChatgptTabs', 'restoreOpenGeminiTabs'],
  ['restoreChatgptTab', 'restoreGeminiTab'],
  ['leftChatGpt', 'leftGemini'],
  ['https://chatgpt.com', 'https://gemini.google.com'],
  ['https://chat.openai.com', 'https://gemini.google.com'],
  ['chatgpt', 'gemini'],
  ['ChatGPT', 'Gemini'],
  ['NCode', 'NCode'],
  ['ncode', 'ncode-gemini-host']
];

for (const [from, to] of replacements) {
  content = content.split(from).join(to);
}

fs.writeFileSync(target, content, 'utf8');
console.log('Successfully completed full rebrand on background.js');
