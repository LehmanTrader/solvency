export function createStore() {
  const events = [];
  return { append: (e) => events.push(e), all: () => [...events] };
}
