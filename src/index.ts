// Skytron entry point. Exports fetch handler (routes all requests) and scheduled handler (cron: 1 action + 1 agent per tick).
import CHAT_HTML from '../chat.html';
import { handleFetch } from './routes';
import { handleScheduled } from './scheduler';

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx, CHAT_HTML);
  },

  async scheduled(controller, env) {
    return handleScheduled(controller, env);
  },
};
