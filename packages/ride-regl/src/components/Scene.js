import { Component } from '@lockvoid/ride';

class Scene extends Component {
  createNode() { return this.runtime.host.createNode(this, 'scene'); }

  diff(prev = {}, next = {}) {
    if (
      prev.x !== next.x || prev.y !== next.y ||
      prev.alpha !== next.alpha ||
      prev.width !== next.width || prev.height !== next.height ||
      prev.scissor !== next.scissor
    ) {
      // key must not rely on this.node; use _createdAt
      this.queue('SET_PROPS', {
        x: next.x | 0,
        y: next.y | 0,
        width: next.width,
        height: next.height,
        alpha: next.alpha == null ? 1 : next.alpha,
        scissor: next.scissor || null,
      }, { key: `${this._createdAt}:props` });
    }
  }

  async effect(op) {
    if (op.type === 'SET_PROPS') this.runtime.host.setProps(this.node, op.payload);
  }
}

export default Scene;
