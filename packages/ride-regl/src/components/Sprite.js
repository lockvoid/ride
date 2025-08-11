import { Component } from '@lockvoid/ride';

class Sprite extends Component {
  createNode() { return this.runtime.host.createNode(this, 'sprite'); }

  diff(prev = {}, next = {}) {

    // geometry/alpha/scissor
    if (
      prev.x !== next.x || prev.y !== next.y ||
      prev.width !== next.width || prev.height !== next.height ||
      prev.alpha !== next.alpha || prev.scissor !== next.scissor
    ) {
      this.queue('SET_PROPS', {
        x: next.x | 0,
        y: next.y | 0,
        width: next.width,
        height: next.height,
        alpha: next.alpha == null ? 1 : next.alpha,
        scissor: next.scissor || null,
      }, { key: `${this._createdAt}:props` });
    }

    // texture upload
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
