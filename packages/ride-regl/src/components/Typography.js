// packages/ride-regl/components/Typography.js
import { Component } from '@lockvoid/ride';
import { same } from '@lockvoid/ride/utils';
import { GeometryBehavior, EventsBehavior } from '../behaviors';

// local normalizer for shadow
const normShadow = (s) => !s ? null : ({
  dx: (s.dx ?? 1) | 0,
  dy: (s.dy ?? 1) | 0,
  softness: (s.softness ?? 0) | 0,
  color: s.color ?? '#000000',
});

const TypographyBehavior = () => ({
  types: ['SET_TEXT_PROPS'],

  diff(prev = {}, next = {}) {
    const spec = same.map({
      text: 'strict',
      fontName: 'strict',
      fontSize: 'strict',
      truncateWidth: 'strict',
      color: 'strict',
      shadow: same.with(normShadow, same.byKeys(['dx', 'dy', 'softness', 'color'])),
    });

    if (same(prev, next, spec)) return;

    this.queue(
      'SET_TEXT_PROPS',
      {
        fontName: next.fontName,
        text: next.text ?? '',
        fontSize: next.fontSize == null ? 16 : next.fontSize,
        color: next.color ?? '#ffffff',
        shadow: normShadow(next.shadow),
        truncateWidth: Number.isFinite(next.truncateWidth) ? next.truncateWidth : Infinity,
      },
      { key: `${this._createdAt}:textprops` }
    );
  },

  effect(op) {
    if (op.type !== 'SET_TEXT_PROPS') return;
    return this.runtime.host.setTextProps(this.node, op.payload);
  },
});

class Typography extends Component {
  static behaviors = Object.freeze([
    TypographyBehavior(),               // local
    GeometryBehavior({ includeSize: false }),
    EventsBehavior(),
  ]);

  createNode() {
    return this.runtime.host.createTextNode(this);
  }
}

export default Typography;
