import { getProvider, providerReadyCode, providerPrepareCode, providerPreflightCode, providerSendCode, providerResponseCode } from '../providers.js';

const chatgpt = getProvider('chatgpt');
export const readyCode = providerReadyCode(chatgpt);
export const sendCode = providerSendCode(chatgpt);
export const prepareChatGPT = (prompt, files) => providerPrepareCode(chatgpt, prompt, files);
export const preflightCode = prompt => providerPreflightCode(chatgpt, prompt);
export const responseCode = previousReplies => providerResponseCode(chatgpt, { previousReplies });

export const existingConversationCode = `async (page) => {
  const url = new URL(page.url());
  if (url.hostname !== 'chatgpt.com' || !url.pathname.startsWith('/c/')) {
    throw new Error('Select the existing ChatGPT conversation tab in the Playwright Extension dialog. Current tab: ' + page.url());
  }
  return { url: page.url() };
}`;
