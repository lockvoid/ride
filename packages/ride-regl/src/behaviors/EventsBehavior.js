import { same } from '@lockvoid/ride/utils';

const EventsBehavior = () => {
  const evKeys = [
    'onPointerDown','onPointerUp','onPointerMove','onPointerIn','onPointerOut',
    'onClick','onWheel','onTouchDown','pointerEvents'
  ];

  return {
    types: ['SET_EVENTS'],

    diff(prev = {}, next = {}) {
      // no-op if all event handlers are shallow-equal by these keys
      if (same(prev, next, same.byKeys(evKeys))) return;

      const payload = {};
      for (const k of evKeys) if (k in next) payload[k] = next[k];

      this.queue('SET_EVENTS', payload, { key: `${this._createdAt}:events` });
    },

    effect(op) {
      if (op.type !== 'SET_EVENTS') return;
      return this.runtime.host.setEvents(this.node, op.payload);
    },
  };
};

export default EventsBehavior;
