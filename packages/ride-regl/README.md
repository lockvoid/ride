# ride-regl

Tiny, **regl**-backed view primitives for the [Ride](https://github.com/lockvoid/ride) runtime.

> **Tagline:** Tiny, host-agnostic orchestration runtime for **data → op → effect**.
> **ride-regl** gives you a ready-made **host + components** to use Ride with WebGL via [`regl`](https://github.com/regl-project/regl).

- **Renderer-agnostic core**: Ride.
- **This package**: the **regl host adapter** + a few **ops-driven components**:
  - `Scene` (container)
  - `Sprite` (textured quad)
  - `Typography` (GPU text)
- **Behaviors (traits)** do most of the work: `GeometryBehavior`, `EventsBehavior`, `TextureBehavior`, `TypographyBehavior`.

---

## Install

```bash
npm i @lockvoid/ride @lockvoid/ride-regl regl
# or
pnpm add @lockvoid/ride @lockvoid/ride-regl regl
```

---

## Quick start

```js
// App.js
import { Ride, Component } from '@lockvoid/ride';
import { createReglHost, Scene, Sprite, Typography } from '@lockvoid/ride-regl';

export class App extends Component {
  static async createHost({ canvas, reglOptions }) {
    // ride-regl host factory. You can pass an HTMLCanvasElement and regl options.
    return createReglHost({ canvas, reglOptions });
  }

  init() {
    // Root scene
    this.root = this.mount(Scene, { x: 0, y: 0, width: 1280, height: 720 });

    // A sprite
    this.hero = this.root.mount(Sprite, {
      x: 100, y: 120, width: 256, height: 256,
      source: '/assets/hero.png',       // image/video/canvas/texture
      contentHash: 'v1',                // bump to invalidate texture
      onClick: () => this.blink(),
    });

    // A text label
    this.label = this.root.mount(Typography, {
      x: 100, y: 420,
      text: 'Hello, regl!',
      fontName: 'Inter',
      fontSize: 32,
      color: '#ffffff',
      shadow: { dx: 1, dy: 2, softness: 1, color: '#000000' },
    });
  }

  blink() {
    // queue through diff → effect as usual
    this.hero.update({ alpha: 0.5 });
    setTimeout(() => this.hero.update({ alpha: 1 }), 150);
  }
}

// index.js
const canvas = document.getElementById('gl');
const app = Ride.mount(App, { canvas });
```

---

## What ride-regl provides

### 1) A **host** for Ride

`createReglHost({ canvas, reglOptions?, onError? })` returns a host implementing Ride’s contract:

- `rootNode`
- `createNode(component, type)` — supports `"container"` and `"sprite"`
- `createTextNode(component)` — text node
- `attachNode(parent, child)`, `detachNode(parent, child)`, `destroyNode(node)`
- `setProps(node, { x, y, width?, height?, alpha, rotation, anchor: [x,y], scissor })`
- `setTexture(node, source, { contentHash? })`
- `setTextProps(node, { text, fontName, fontSize, color, shadow?, truncateWidth })`
- `setEvents(node, handlers)`
- `requestRender()`
- `teardown()`

> You don’t call these directly — your components **queue ops**, and the host applies them in `effect()`.

### 2) **Ops-driven components**

Each is a tiny class that composes behaviors and delegates to the host:

- `Scene` — container / grouping node
- `Sprite` — quad with a texture
- `Typography` — GPU text

They rely on **Behaviors** for the heavy lifting.

---

## Components

### Scene

Container for layout and events.

```ts
import { Scene } from '@lockvoid/ride-regl';

new Scene({
  x?: number, y?: number,
  width?: number, height?: number,       // optional
  alpha?: number = 1,
  rotation?: number = 0,                 // radians
  anchor?: [number, number] = [0, 0],    // normalized
  scissor?: { x:number, y:number, w:number, h:number } | null,

  // Events (pointer/click/wheel/touch)
  onPointerDown?, onPointerUp?, onPointerMove?, onPointerIn?, onPointerOut?,
  onClick?, onWheel?, onTouchDown?,
  pointerEvents?: 'auto' | 'none',
})
```

**Ops used**
- `SET_PROPS` via `GeometryBehavior({ includeSize: true })`
- `SET_EVENTS` via `EventsBehavior()`

---

### Sprite

Textured quad with geometry + events.

```ts
import { Sprite } from '@lockvoid/ride-regl';

new Sprite({
  x, y, width, height,
  alpha?, rotation?, anchor?, scissor?,
  source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | WebGLTexture | string,
  contentHash?: string | number, // bump to force re-upload
  // Events…
})
```

**Ops used**
- `SET_PROPS` (`GeometryBehavior({ includeSize: true })`)
- `SET_TEXTURE` (`TextureBehavior()`)
- `SET_EVENTS` (`EventsBehavior()`)

---

### Typography

GPU text + transform + events.

```ts
import { Typography } from '@lockvoid/ride-regl';

new Typography({
  // text style + metrics
  text?: string = '',
  fontName?: string,
  fontSize?: number = 16,
  color?: string = '#ffffff',
  shadow?: { dx?:number, dy?:number, softness?:number, color?:string } | null,
  truncateWidth?: number = Infinity,

  // transform/visibility
  x?, y?, alpha?, rotation?, anchor?, scissor?,

  // Events…
})
```

**Ops used**
- `SET_TEXT_PROPS` (`TypographyBehavior()`; normalizes shadow and batches style)
- `SET_PROPS` (`GeometryBehavior({ includeSize: false })`)
- `SET_EVENTS` (`EventsBehavior()`)

---

## Behaviors (what does the work)

All three components are mostly **behavior composition**:

- `GeometryBehavior({ includeSize?: boolean })`
  - Compares `{ x:int, y:int, alpha, rotation, anchor:[x,y], scissor, width?, height? }`
  - Queues `SET_PROPS` when changed; effect forwards to `host.setProps`
- `EventsBehavior()`
  - Watches handler props and queues `SET_EVENTS`; effect → `host.setEvents`
- `TextureBehavior()` (Sprite only)
  - Watches `{ source, contentHash }`; queues `SET_TEXTURE`; effect → `host.setTexture`
- `TypographyBehavior()` (Typography only)
  - Normalizes `shadow` and batches style; queues `SET_TEXT_PROPS`; effect → `host.setTextProps`

Behaviors run **before** the component’s own `effect`, in **base → derived** order. They can return **per-key cleanups** (run before the next effect of the same key, and again on unmount).

---

## Events

The common set:

```
onPointerDown, onPointerUp, onPointerMove, onPointerIn, onPointerOut,
onClick, onWheel, onTouchDown, pointerEvents
```

These are passed to the host in a single `SET_EVENTS` op and installed per node.

---

## Textures

`Sprite` accepts:

- `source` — image/canvas/video/string/texture. If a **string**, the host may load it; otherwise you can feed a preloaded image/canvas/video.
- `contentHash` — any primitive that, when changed, forces the host to re-upload/re-bake the texture. Handy for “same URL, different content” scenarios.

---

## Scheduling tips (Ride)

- Set budget: `static progressive = { budget: 6 }`
- Choose locality:
  - `locality: 'depth'` (default) — wave rendering (all siblings at depth N, then depth N+1)
  - `locality: 'subtree'` — **drain one item and its descendants** before the next sibling; great for grids/cards where each item has image + text.

```ts
class App extends Component {
  static progressive = { budget: 6, locality: 'subtree' };
}
```

---

## The `same` utility (diff helpers)

ride-regl behaviors use Ride’s tiny comparator to avoid ad-hoc equality checks:

```ts
import { same } from '@lockvoid/ride/utils/same';

// Examples
same(prev, next, same.map({
  x: same.int(),
  y: same.int(),
  anchor: same.tuple(2),
}))
```

Helpers: `same.shallow()`, `same.byKeys([...])`, `same.tuple(n)`, `same.map({...})`, `same.with(normalize, spec)`, `same.eq(normalize)`, `same.int()`.

---

## Testing

Ride exposes deterministic draining:

```js
await raf();
await Ride.flushUntilIdle(app);
```

This awaits scheduled frames **and** any in-flight async effects/cleanups so your tests can assert final state.

---

## Recipes

### Progressive grid (items first, then covers)

```ts
class Item extends Scene {
  static progressive = { priority: 0 };       // top
  init() {
    this.info = this.mount(Typography, { text: 'Loading…', x: 8, y: 8 });
    this.cover = this.mount(Sprite, {
      x: 0, y: 0, width: 196, height: 196,
      alpha: 0.001,                          // fade in later
    });
  }
  diff(_p, n) {
    if (n.title) this.info.update({ text: n.title });
    if (n.image) this.cover.update({ source: n.image, alpha: 1 });
  }
}

class Grid extends Scene {
  static progressive = { budget: 6, locality: 'subtree' }; // drain each item fully
  init() { /* mount a bunch of Items with positions */ }
}
```

---

## Troubleshooting

- **Nothing shows up**
  - Ensure the canvas has size and WebGL context is available.
  - Verify `App.createHost` returns the host (and doesn’t throw).
- **Events don’t fire**
  - Set `pointerEvents: 'auto'` on the node (defaults depend on host).
  - Make sure the node is within the viewport/scissor.
- **Texture not updating**
  - Change `contentHash` when the content at the same URL changes.
- **Performance hiccups**
  - Lower `progressive.budget`, try `locality: 'subtree'`.
  - Avoid thrashing by coalescing ops per key (behaviors already do this).


## License

MIT © LockVoid Labs \~●~
