import { Component } from '@lockvoid/ride';
import { GeometryBehavior, EventsBehavior } from '../behaviors';

// Local to this file
const SpriteBehavior = () => ({
  types: ['SET_TEXTURE'],
  diff(prev = {}, next = {}) {
    const texChanged = prev.source !== next.source || prev.contentHash !== next.contentHash;
    if (texChanged && next.source) {
      this.queue(
        'SET_TEXTURE',
        { source: next.source, contentHash: !!next.contentHash },
        { key: `${this._createdAt}:tex` }
      );
    }
  },
  effect(op) {
    if (op.type !== 'SET_TEXTURE') return;
    const { source, contentHash } = op.payload;
    return this.runtime.host.setTexture(this.node, source, { contentHash: !!contentHash });
  },
});

class Sprite extends Component {
  static behaviors = Object.freeze([
    GeometryBehavior({ includeSize: true }),
    SpriteBehavior(),      // local
    EventsBehavior(),
  ]);

  createNode() {
    return this.runtime.host.createNode(this, 'sprite');
  }
}

export default Sprite;
