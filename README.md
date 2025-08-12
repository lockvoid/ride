 Ride

# Ride

![Ride](https://pub-464e6b9480014239a02034726cf0073c.r2.dev/ride.jpg)

Tiny, host-agnostic orchestration runtime for **data** → **op** → **effect**.

Ride gives you a `Component` base, a batched `Scheduler`, and a single-entry `Op × Effect` API. It knows nothing about Pixi/DOM/Canvas — you plug in a host adapter (e.g., Pixi v8) and write components that **enqueue ops**, not re-renders.

> ### 🚀 Looking for a WebGL host + components?
> Use Ride with WebGL via **ride-regl** → **[packages/ride-regl/README.md »](./packages/ride-regl/README.md)**

---

## What’s new

- **Sync mount.** `Ride.mount(App, props)` returns the app immediately; you can call `app.update()` right away. The host (e.g., Pixi) is created **async**; updates are **buffered** and flushed when ready.
- **Transactional diffs.** `diff(prev, next)` can be async and may return **`DIFF.DEFER`** to stage props without committing them.
- **Per-component priority.** `static progressive = { priority }` lets you run important components first. Effective op priority = `componentPriority + opPriority`.
- **Type + Key + Payload.** Ops are `{ type, key, payload, priority }`. **Key** scopes coalescing so “last write wins” happens **per item**, not globally.
- **Squashing.** Combine multiple ops for the same key with `squashWith(prev, next, prevOp, nextOp)`.
- **Child slotting.** `getChildParent(child)` lets a parent choose **where** children attach.
- **Progressive scheduling.** `static progressive = { budget }` time-slices work per frame to avoid hitches.
- **Behaviors (traits).** Declare `static behaviors = [...]` on your class to compose capabilities without inheritance gymnastics. Behaviors can hook into `init`, `diff`, and `effect` (with filtering), and they can return cleanups.
- **Effect & init cleanups.** `effect(op)` may return a cleanup that runs **before the next effect for the same key** and again on unmount. `init()` may return a **lifetime cleanup** that runs on unmount.
- **Deterministic flushing.** `Ride.flushUntilIdle(app)` awaits all scheduled/in-flight work. Great for tests.
- **Error surface.** Errors in `attach/init/diff/effect/cleanup/host-init` are routed to `App.onError(err, ctx)` (or static `App.onError`) and won’t wedge a frame.
- **Depth-gated budgeting.** Under a tight frame budget, Ride slices between **depth groups** so siblings at the same depth finish together before yielding.
- **Utils** A micro helper for declarative “did this change?” checks, shared by behaviors.

---

## Core ideas

**`update(next)` → `diff(prev, next)` → `queue(type, payload, opts)` → `effect(op)`**

- Components **don’t render directly**; they enqueue **ops**.
- The **Scheduler** batches dirty components, runs diffs, and asks the host to render **once per frame**.
- **Coalescing:** last write wins **per op key**.
- **Auto-parenting:** parent chooses child attach node via `getChildParent(child)` (defaults to `this.node`).

---

### Strong Performance Features:

- **Operation batching & coalescing** — “last write wins” per key prevents redundant work when many operations are queued per frame.
- **Transactional diffs with DEFER** — Wait for multiple async data sources before committing, avoiding half-rendered states.
- **Pay-as-you-go priorities** — Only sorts operations when you use priorities, keeping FIFO fast.
- **Built-in virtualization patterns** — Efficient windowing for large datasets.
- **Time-sliced mounting** — Progressive rendering to keep frames smooth when adding many items at once.
- **Renderer-agnostic** — Works with Pixi.js, DOM, WebGL, etc.

### Performance Advantages:

- Components queue operations instead of triggering re-renders.
- Single-frame commits batch DOM/Canvas updates instead of incremental thrashing.
- Operation model naturally coalesces redundant updates.

---

## Transactional diffs with `DIFF.DEFER`

Ride stages incoming props and only **commits** them to `this.props` when your `diff()` doesn’t defer.

```js
import { DIFF } from 'ride';

diff(prev = {}, next = {}) {
  if (!next.todosLoaded) {
    this.queue('mode', { mode: 'loading' }, { key: 'mode' });
    return DIFF.DEFER;
  }

  this.queue('mode', { mode: 'ready' }, { key: 'mode' });
}
```

---

## Operation model

### Op shape

```ts
type Op = {
  type: string;
  key: string;
  payload?: any;
  priority?: number | null;
}
```

### `Component.queue(...)`

```js
queue(
  type,
  payload,
  {
    key = type,
    priority = null,
    coalesceBy,
    squashWith
  } = {}
) { … }
```

---

## Component API

```ts
class Component {
  createNode(): any
  getChildParent(child: Component): any
  init(): Promise<void> | void
  diff(prevProps, nextProps): Promise<DIFF|void> | DIFF | void
  effect(op): Promise<void> | void

  update(partialProps): void
  queue(type, payload, opts?): void

  mount(ChildClass, props): Component
  unmount(child): Promise<void>

  static progressive?: { budget?: number }

  destroy(): Promise<void>
}
```

---

## Ride API

```ts
class Ride {
  static mount(AppClass, props): Component
  static unmount(app): Promise<void>
}
```

---

## Host adapter contract

Implement per renderer (Pixi, DOM, WebGL, …):

- `rootNode`
- `createNode(component)`
- `attachNode(parent, child)`
- `detachNode(parent, child)`
- `destroyNode(node)`
- `requestRender()`
- `teardown()`

---

## Minimal Pixi example (TODO list)

```js
// PixiHost.js
import { Application, Container } from 'pixi.js';
export default async function makePixiHost({ container }) {
  const app = new Application();
  await app.init({ resizeTo: container });
  container.appendChild(app.canvas);
  return {
    rootNode: app.stage,
    app,
    createNode: () => new Container(),
    attachNode: (parent, node) => parent.addChild(node),
    detachNode: (parent, node) => parent.removeChild(node),
    destroyNode: (node) => node.destroy({ children: true }),
    requestRender: () => app.render(),
    teardown: () => app.destroy(),
  };
}
```

```js
// App.js
import { Component } from 'ride';
import makePixiHost from './PixiHost';
import { TodoList } from './TodoList';

export class App extends Component {
  static async createHost({ container }) {
    return makePixiHost({ container });
  }
  init() {
    this.list = this.mount(TodoList, { todos: [] });
  }
  diff(_prev, next) {
    this.queue('setTodos', next, { key: 'todos' });
  }
  effect(op) {
    if (op.type === 'setTodos') this.list.update(op.payload);
  }
}
```

```js
// TodoList.js
import { Component } from 'ride';
import { TodoItem } from './TodoItem';

export class TodoList extends Component {
  init() { this.items = new Map(); }
  diff(prev, next) {
    const old = prev.todos || [];
    const curr = next.todos || [];
    old.forEach(t => {
      if (!curr.find(c => c.id === t.id)) {
        this.queue('remove', { id: t.id }, { key: `t|${t.id}` });
      }
    });
    curr.forEach(t => {
      this.queue('upsert', t, { key: `t|${t.id}` });
    });
  }
  async effect(op) {
    if (op.type === 'upsert') {
      let item = this.items.get(op.payload.id);
      if (!item) {
        item = this.mount(TodoItem, op.payload);
        this.items.set(op.payload.id, item);
      } else {
        item.update(op.payload);
      }
    }
    if (op.type === 'remove') {
      const it = this.items.get(op.payload.id);
      if (it) {
        await this.unmount(it);
        this.items.delete(op.payload.id);
      }
    }
  }
}
```

```js
// TodoItem.js
import { Component } from 'ride';
import { Graphics, Text } from 'pixi.js';

export class TodoItem extends Component {
  createNode() { return new Graphics(); }
  init() {
    this.label = new Text('');
    this.node.addChild(this.label);
  }
  diff(prev, next) {
    if (prev.text !== next.text) {
      this.queue('label', { text: next.text }, { key: 'label' });
    }
  }
  effect(op) {
    if (op.type === 'label') {
      this.node.clear().rect(0, 0, 200, 30).fill(0xdddddd);
      this.label.text = op.payload.text;
    }
  }
}
```

**Usage:**
```js
import { Ride } from 'ride';
import { App } from './App';

const container = document.getElementById('pixi-root');
const app = Ride.mount(App, { container });
app.update({ todos: [{ id: 1, text: 'Buy milk' }] });
```

---

## Progressive scheduling (per component)

```js
class MyComponent extends Component {
  static progressive = { budget: 8 }; // max ms/frame
}
```

---

## Virtualization (windowed mounts with overscan)

**When to use:** Large lists/grids. Culling hides off-screen nodes but still creates them; **virtualization doesn’t**. Mount only visible rows ± overscan and unmount the rest.

**Pattern**

1. `patch_item` updates a **cache** (`id -> { asset?, cook? }`) instead of immediately mounting.
2. On `layout_grid` and `scroll`, compute the **visible row window** (± overscan rows).
3. **Mount** items in that window from cache and **unmount** everything else.
4. Position mounted items using the cached layout.

**State**
```js
this._cache = new Map();    // id -> { asset?, cook? }
this.items = new Map();     // id -> mounted AssetCell
this.orderIds = [];
this._layout = null;
this._offsetY = 0;
this._viewportH = 0;
this._overscanRows = this.props.overscanRows ?? 1;
```

**Cache & layout/scroll**
```js
// diff(): cache, then layout + scroll ops
for (const ins of inserts) {
  this.queue('cache_item', { id: ins.id, asset: ins.next }, {
    key: `cache|${ins.id}`,
    squashWith: (a,b)=>({ ...a, ...b })
  });
}
for (const pat of patches) {
  this.queue('cache_item', { id: pat.id, asset: pat.next }, {
    key: `cache|${pat.id}`,
    squashWith: (a,b)=>({ ...a, ...b })
  });
}
this.queue('layout_grid', { ...layout, orderIds }, { key: 'layout' });
this.queue('scroll', { offsetY, viewportH }, {
  key: 'scroll',
  squashWith: (_a,b)=>b
});
```

**Window reconcile**
```js
const computeWindow = (layout, offsetY, viewportH, overscanRows = 1) => {
  const { itemSize, gap, rows } = layout;
  const stride = itemSize + gap;
  const top = Math.floor(Math.max(0, offsetY) / stride);
  const bottom = Math.floor(Math.max(0, offsetY + viewportH) / stride);
  return {
    start: Math.max(0, top - overscanRows),
    end: Math.min(rows - 1, bottom + overscanRows),
  };
};

_reconcileWindow(){
  if (!this._layout) return;
  const { start, end } = computeWindow(
    this._layout,
    this._offsetY,
    this._viewportH || this._layout.H,
    this._overscanRows
  );
  const { cols, gap, itemSize, offsetX } = this._layout;
  const want = new Set();

  for (let row = start; row <= end; row++) {
    const rowStart = row * cols;
    const rowEnd = Math.min(this.orderIds.length - 1, rowStart + cols - 1);
    for (let i = rowStart; i <= rowEnd; i++) {
      const id = this.orderIds[i];
      want.add(id);

      if (!this.items.has(id)) {
        const data = this._cache.get(id);
        if (!data) continue;
        const child = this.mount(AssetCell, data);
        this.items.set(id, child);
      }
      const col = i % cols, r = (i / cols) | 0;
      const x = offsetX + col * (itemSize + gap);
      const y = r * (itemSize + gap);
      this.items.get(id).update({ x, y, size: itemSize, visible: true });
    }
  }

  for (const [id, child] of this.items) {
    if (!want.has(id)) { this.unmount(child); this.items.delete(id); }
  }
}
```


---

## Behaviors (traits)

Behaviors are small objects you compose into components. They run **before** your component’s own `diff/effect`, in **base → derived** order, and can be filtered by op type or a custom predicate.

### Declare

```js
export class Scene extends Component {
  static behaviors = [CameraBehavior, InputBehavior]; // local to Scene
}

export class AssetGrid extends Scene {
  static behaviors = [SelectionBehavior]; // local to AssetGrid only
}
```

You can also do plugin-style composition:

```js
AssetGrid.use(MetricsBehavior); // optional sugar, mostly for plugins/tests
```

### Behavior shape

```ts
type Behavior = {
  name?: string;                   // for debugging
  types?: string[];                // handle only these op types
  matches?: (op) => boolean;       // custom filter

  init?: (ctx) => void | (() => void) | Promise<void | (() => void)>;
  diff?: (prev, next, ctx) => void | DIFF | Promise<void | DIFF>;
  effect?: (op, ctx) => void | (() => void) | Promise<void | (() => void)>;
};
```

### Context passed to hooks

```ts
type Ctx = {
  component: Component;
  addCleanup(fn: () => (void|Promise<void>)): void;  // lifetime (init) or per-key (effect)
  defer(): void;                                      // diff: force DIFF.DEFER
  onError(err: any, phase?: string, extra?: any): void;
};
```

### Ordering & filtering

- **Order:** base class behaviors first, then subclass behaviors, then your component’s own `effect()`.
- **Filter:** set `types: [...]` and/or `matches(op)` to opt behaviors into certain ops only.

### Pre-ready rule

While the host is not ready, Ride buffers ops but **skips behavior diffs** (to avoid first-render side-effects). Legacy `diff()` still runs so you can stage ops.

---

## Cleanups

- **Per-key cleanups** — return a function from `effect(op)`.
  Runs:
  1) **Before** the next `effect()` for the **same key** (awaited), and
  2) Again on **unmount** if still registered.

- **Lifetime cleanups** — return a function from `init()` **or** call `ctx.addCleanup(fn)` inside a behavior’s `init`.
  Runs on **unmount**, after all per-key cleanups.

- **Aggregation & order:** Multiple behaviors can return cleanups for the **same key**. Ride combines them and executes in **reverse order** of registration (LIFO), awaiting async cleanups:

```
effect chain: [A, B, Legacy]  → cleanup order: [Legacy, B, A]
```

---

## Deterministic flushing (tests & tools)

After a `requestAnimationFrame`, work may still be in-flight (async effects/cleanups). For stable tests:

```js
await raf();
await Ride.flushUntilIdle(app); // guarantees all scheduled/in-flight work is finished
```

`flushUntilIdle` drains the scheduler until nothing is dirty, nothing is scheduled, and any in-flight flush is done.

---

## Error handling

All errors from `attach/init/diff/effect/cleanup/host-init` are caught and forwarded:

```js
class App extends Component {
  static onError(err, { phase, component, op }) {
    // Your centralized error hook
    // phase ∈ 'host-init' | 'attach' | 'init' | 'diff' | 'effect' | 'cleanup' | 'initial-diff'
  }
}
```

- Preference order: `App.constructor.onError` → `App.onError` → `Component` handlers (early boot) → `console.error`.
- Errors do **not** stop the frame; Ride continues with remaining work.

---

## Scheduling details (priorities + budgets)

- Batch sort order: **depth → componentPriority → creationOrder**.
- With a small frame budget, Ride will **not split siblings** at the same depth. It yields only when moving into a **new depth group**. This keeps, e.g., all `Item` siblings together, then their `ItemInfo` children, etc.
- Effective op priority = `componentPriority + opPriority`. Use sparingly where order truly matters.

---

## API additions

### Component

```ts
class Component {
  // behaviors
  static behaviors?: Behavior[];
  static use(...behaviors: Behavior[]): void;

  // error hooks (optional on instances too)
  static onError?(err, ctx): void;
  onError?(err, ctx): void;
}
```

### Ride

```ts
class Ride {
  static flushUntilIdle(app, opts?): Promise<void>;
}
```

---

## Tiny behavior example

```js
// selectionBehavior.js
export const SelectionBehavior = {
  name: 'selection',
  types: ['pointer', 'select'],
  effect(op, ctx) {
    const { type, payload } = op;
    if (type === 'pointer') ctx.component._hover = payload.id;
    if (type === 'select')  ctx.component._selected = payload.id;

    // optional teardown for per-key resources
    return () => { /* stop hover timers, etc. */ };
  }
};

// scene.js
export class Scene extends Component {
  static behaviors = [SelectionBehavior];
}
```

---

**Notes**
- `overscanRows`: default 1. Raise to 2–3 if you see pop-in on fast scrolls.
- Virtualization and culling stack fine; virtualization does the heavy lifting.


---

# Locality-driven scheduling (depth vs subtree)

Ride’s scheduler orders components by **depth → componentPriority → creationOrder** and slices work by a frame **budget**. How it *yields* between components is controlled by **locality**:

- **`depth` (default):** The scheduler won’t split **siblings at the same depth**; it yields only when moving into a new depth group. This gives a “wave” feel (all `Item` siblings first, then their `ItemInfo` children, etc.).
- **`subtree`:** The scheduler picks a root, then **drains that component and its descendants** (respecting priority and budget), before moving to the next root. This makes each item feel “fully” rendered (e.g., `Item → ItemInfo → Cover`) before the next sibling.

### Opt in

```ts
class App extends Component {
  static progressive = {
    budget: 6,
    locality: 'subtree',   // or 'depth' (default)
  };
}
```

You can also set `locality` on a subtree root class (e.g., `Item`) to prioritize “locality first” rendering for those instances without changing the whole app.

### Mental model

- **`depth`**: smoother global progress (waves), ideal for balanced pages.
- **`subtree`**: better perceived latency for lists/grids — each card feels complete sooner.

> Only **descendants of the current root** are pulled forward in `subtree` mode; unrelated siblings elsewhere in the tree are not interleaved.

### Putting it together

```ts
export class Scene extends Component {
  static behaviors = [GeometryBehavior({ includeSize: true }), EventsBehavior()];
}

export class Sprite extends Component {
  static behaviors = [GeometryBehavior({ includeSize: true }), EventsBehavior()];
  // add local TextureBehavior() right in this file if needed
}

export class Typography extends Component {
  static behaviors = [TypographyBehavior(), GeometryBehavior(), EventsBehavior()];
}
```

---

# Tiny utility: `same` (generic comparator)

A micro helper for **declarative “did this change?”** checks, shared by behaviors.

```ts
import { same } from '@lockvoid/ride/utils/same';

// Usage patterns
same(a, b)                               // strict ===
same(a, b, same.shallow())               // arrays or plain objects
same(a, b, same.byKeys(['x','y']))       // only selected keys
same(a, b, same.tuple(2))                // 2-tuple arrays
same(a, b, same.map({x:'strict', y:same.int()})) // per-key spec
same(a, b, same.with(normalize, spec))   // normalize then compare
same(a, b, same.eq(norm))                // Object.is after normalize
same(a, b, same.int())                   // (v|0) integer compare
```

### Common recipes

- **Geometry:** `same.map({ x: same.int(), y: same.int(), anchor: same.tuple(2) })`
- **Events:** `same.byKeys(['onClick', 'onPointerDown', ...])`
- **Shadows:** `same.with(normShadow, same.byKeys(['dx','dy','softness','color']))`
- **Shallow props bag:** `same(prev, next, same.shallow())`

> `same` is tiny by design; extend via `same.with()` and `same.map()` rather than adding domain-specific helpers.

---

# Testing helpers: locality & determinism

- Use **`Ride.flushUntilIdle(app)`** after `raf()` when your behavior/effect does async work or when you need stable timing across budgets.
- For locality tests:
  - In **`depth`** mode, expect “waves” (all parents, then children).
  - In **`subtree`** mode, expect **root + descendants** as a block, then the next root; unrelated siblings should not be interleaved into the current subtree.

Example assertion sketch:

```ts
const order = effects.map(e => e.who);
const idxItem0 = order.indexOf('Item 0');
const idxInfo0 = order.indexOf('ItemInfo 0');
const idxSidebar = order.indexOf('Sidebar');
expect(idxInfo0).toBe(idxItem0 + 1);           // child immediately after parent (subtree)
expect(idxSidebar).toBeGreaterThan(idxInfo0);  // unrelated stays after the subtree
```

---

## Tips

- Always key your ops.
- Keep ops tiny — only changed fields.
- Tune `progressive.budget` to smooth big updates.
- Use a **keyed linear diff** for lists; avoid deep diffs on hot paths.
- Keep ops **tiny** (only changed fields).
- Use **`DIFF.DEFER`** for “wait until X & Y are ready” flows; otherwise commit by default.
- Add `priority` only where order truly matters (e.g., remove → insert, layout before paint).
- Prefer `getChildParent(child)` over manual re-parenting to keep layers declarative.
- Progressive knobs: start with `updateBudget: 8–32`, `createBudget: 4–16`. Add `weight` on expensive ops.

---

## License

MIT © LockVoid Labs \~●~
