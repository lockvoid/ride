// packages/ride-regl/components/Scene.js
import { Component } from '@lockvoid/ride';
import { GeometryBehavior, EventsBehavior } from '../behaviors';

class Scene extends Component {
  static behaviors = Object.freeze([
    GeometryBehavior({ includeSize: true }),
    EventsBehavior(),
  ]);

  createNode() {
    return this.runtime.host.createNode(this, 'container');
  }
}

export default Scene;
