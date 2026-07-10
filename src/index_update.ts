// === Skytron Index Update ===
// This file is used to update the Skytron Index entry point.
// It reflects changes to the fetch/scheduled dispatch mechanism.
import { handleFetch } from './routes';
import { handleScheduled } from './scheduler';

export async function updateIndex(dispatch) {
  if (dispatch === 'fetch') {
    return handleFetch;
  } else if (dispatch === 'scheduled') {
    return handleScheduled;
  }
}