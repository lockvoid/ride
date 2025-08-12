// packages/ride-regl/components/Sprite.js
import { Component } from '@lockvoid/ride';

const sameAnchor = (a, b) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a[0] === b[0] && a[1] === b[1];
};
const sameFns = (a, b, keys) => keys.every(k => a[k] === b[k]);

class Sprite extends Component {
  createNode() { return this.runtime.host.createNode(this, 'sprite'); }

  diff(prev = {}, next = {}) {
    const geomChanged =
      prev.x !== next.x || prev.y !== next.y ||
      prev.width !== next.width || prev.height !== next.height ||
      prev.alpha !== next.alpha ||
      prev.rotation !== next.rotation ||
      !sameAnchor(prev.anchor, next.anchor) ||
      prev.scissor !== next.scissor;

    if (geomChanged) {
      this.queue('SET_PROPS', {
        x: next.x | 0,
        y: next.y | 0,
        width: next.width,
        height: next.height,
        alpha: next.alpha == null ? 1 : next.alpha,
        rotation: next.rotation || 0,        // radians
        anchor: Array.isArray(next.anchor) ? next.anchor : [0, 0],
        scissor: next.scissor || null,
      }, { key: `${this._createdAt}:props` });
    }

    const texChanged = prev.source !== next.source || prev.contentHash !== next.contentHash;
    if (texChanged && next.source) {
      this.queue(
        'SET_TEXTURE',
        { source: next.source, contentHash: !!next.contentHash },
        { key: `${this._createdAt}:tex` }
      );
    }

    // EVENTS
    const evKeys = [
      'onPointerDown','onPointerUp','onPointerMove','onPointerIn','onPointerOut',
      'onClick','onWheel','onTouchDown','pointerEvents'
    ];
    const eventsChanged = !sameFns(prev, next, evKeys);
    if (eventsChanged) {
      const payload = {};
      for (const k of evKeys) if (k in next) payload[k] = next[k];
      this.queue('SET_EVENTS', payload, { key: `${this._createdAt}:events` });
    }
  }

  async effect(op) {
    const host = this.runtime.host;
    if (op.type === 'SET_PROPS') return host.setProps(this.node, op.payload);
    if (op.type === 'SET_TEXTURE') return host.setTexture(this.node, op.payload.source, { contentHash: !!op.payload.contentHash });
    if (op.type === 'SET_EVENTS') return host.setEvents(this.node, op.payload);
  }
}

export default Sprite;
