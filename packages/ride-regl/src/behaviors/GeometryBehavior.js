import { same } from '@lockvoid/ride/utils';

const GeometryBehavior = ({ includeSize = false } = {}) => ({
  types: ['SET_PROPS'],

  diff(prev = {}, next = {}) {
    const spec = same.map({
      x: same.int(),                // (a|0) === (b|0)
      y: same.int(),
      alpha: 'strict',
      rotation: 'strict',
      anchor: same.tuple(2),
      scissor: 'strict',
      ...(includeSize ? { width: 'strict', height: 'strict' } : null),
    });

    if (same(prev, next, spec)) return;

    const payload = {
      x: next.x | 0,
      y: next.y | 0,
      alpha: next.alpha == null ? 1 : next.alpha,
      rotation: next.rotation || 0,
      anchor: Array.isArray(next.anchor) ? next.anchor : [0, 0],
      scissor: next.scissor || null,
    };

    if (includeSize) {
      payload.width = next.width;
      payload.height = next.height;
    }

    this.queue('SET_PROPS', payload, { key: `${this._createdAt}:props` });
  },

  effect(op) {
    if (op.type !== 'SET_PROPS') return;
    return this.runtime.host.setProps(this.node, op.payload);
  },
});

export default GeometryBehavior;
