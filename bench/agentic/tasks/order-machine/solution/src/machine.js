const T = {
  draft: { submit: 'placed' },
  placed: { pay: 'paid', cancel: 'cancelled' },
  paid: { ship: 'shipped', refund: 'refunded' },
  shipped: { deliver: 'delivered' },
};
export function createOrder(nowFn) {
  let state = 'draft';
  let paidAt = null;
  const history = [];
  return {
    state: () => state,
    history: () => history.map((h) => ({ ...h })),
    send(event, atMs) {
      const to = T[state]?.[event];
      if (!to) throw new Error(`cannot ${event} from ${state}`);
      if (event === 'refund' && atMs - paidAt > 3_600_000) throw new Error('refund window closed');
      if (event === 'pay') paidAt = atMs;
      history.push({ from: state, to, event, atMs });
      state = to;
    },
  };
}
