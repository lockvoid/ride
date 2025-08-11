// packages/ride-regl/components/Sprite.js
import { Component } from '@lockvoid/ride';

const sameAnchor = (a, b) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a[0] === b[0] && a[1] === b[1];
};

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
    if (prev.source !== next.source && next.source) {
      this.queue('SET_TEXTURE', { source: next.source }, { key: `${this._createdAt}:tex` });
    }
  }

  async effect(op) {
    const host = this.runtime.host;
    if (op.type === 'SET_PROPS') host.setProps(this.node, op.payload);
    if (op.type === 'SET_TEXTURE') host.setTexture(this.node, op.payload.source);
  }
}

export default Sprite;
