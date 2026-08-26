export { createStore } from './store.js';
import { project } from './projector.js';
export function balanceOf(store, account) {
  return project(store.all()).get(account) ?? 0;
}
