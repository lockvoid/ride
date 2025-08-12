// packages/ride-regl/components/Typography.js
import { Component } from '@lockvoid/ride';

const sameAnchor = (a, b) => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a[0] === b[0] && a[1] === b[1];
};
const sameShadow = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (a.dx|0) === (b.dx|0) &&
         (a.dy|0) === (b.dy|0) &&
         ((a.softness ?? 0)|0) === ((b.softness ?? 0)|0) &&
         a.color === b.color;
};

class Typography extends Component {
  createNode() { return this.runtime.host.createTextNode(this); }

  diff(prev = {}, next = {}) {
    // 1) Text-related props (host.setTextProps)
    const textChanged =
      prev.text !== next.text ||
      prev.fontName !== next.fontName ||
      prev.fontSize !== next.fontSize ||
      prev.truncateWidth !== next.truncateWidth ||
      prev.color !== next.color ||
      !sameShadow(prev.shadow, next.shadow);

    if (textChanged) {
      this.queue(
        'SET_TEXT_PROPS',
        {
          fontName: next.fontName,
          text: next.text ?? '',
          fontSize: next.fontSize == null ? 16 : next.fontSize,
          color: next.color ?? '#ffffff',
          shadow: next.shadow ? {
            dx: next.shadow.dx ?? 1,
            dy: next.shadow.dy ?? 1,
            color: next.shadow.color ?? '#000000',
            softness: next.shadow.softness ?? 0,
          } : null,                               // { dx, dy, color, softness } or null
          truncateWidth: Number.isFinite(next.truncateWidth) ? next.truncateWidth : Infinity,
        },
        { key: `${this._createdAt}:textprops` }
      );
    }

    // 2) Transform/visibility (host.setProps) — same pattern as Sprite
    const geomChanged =
      (prev.x|0) !== (next.x|0) ||
      (prev.y|0) !== (next.y|0) ||
      prev.alpha !== next.alpha ||
      prev.rotation !== next.rotation ||   // radians
      !sameAnchor(prev.anchor, next.anchor) ||
      prev.scissor !== next.scissor;

    if (geomChanged) {
      this.queue(
        'SET_PROPS',
        {
          x: next.x | 0,
          y: next.y | 0,
          alpha: next.alpha == null ? 1 : next.alpha,
          rotation: next.rotation || 0,        // radians
          anchor: Array.isArray(next.anchor) ? next.anchor : [0, 0],
          scissor: next.scissor || null,       // [x,y,w,h] in CSS px, like Sprite
        },
        { key: `${this._createdAt}:props` }
      );
    }
  }

  async effect(op) {
    const host = this.runtime.host;
    if (op.type === 'SET_TEXT_PROPS') {
      return host.setTextProps(this.node, op.payload);
    }
    if (op.type === 'SET_PROPS') {
      return host.setProps(this.node, op.payload);
    }
  }
}

export default Typography;
