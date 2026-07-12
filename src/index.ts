// === Skytron Index (ENTRY POINT) ===
// This is the Cloudflare Worker entry. DO NOT modify this file unless changing how fetch/scheduled are dispatched.
// - fetch() delegates to routes.ts (handleFetch) for ALL HTTP traffic
// - scheduled() delegates to scheduler.ts (handleScheduled) for cron ticks
// chat.html is imported and passed through to routes.ts for the UI
import CHAT_HTML from '../chat.html';
import { handleFetch } from './routes';
import { handleScheduled } from './scheduler';

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx, CHAT_HTML);
  },

  async scheduled(controller, env) {
    return handleScheduled(controller, env, controller.cron);
  },
};
