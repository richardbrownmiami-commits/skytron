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
