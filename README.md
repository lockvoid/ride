# Ride

Tiny, renderer-agnostic UI runtime for **data → ops → single-frame commits**.

Ride gives you a `Component` base, a batched `Scheduler`, and a single-entry `effect(op)` API. It knows nothing about Pixi/DOM/Canvas — you plug in a host adapter (e.g., Pixi v8) and write components that **enqueue ops**, not re-renders.

---

## What’s new

- **Sync mount.** `Ride.mount(App, props)` returns the app immediately; you can call `app.update()` right away. The host (e.g., Pixi) is created **async**; updates are **buffered** and flushed when ready.
- **Transactional diffs.** `diff(prev, next)` can be async and may return **`DIFF.DEFER`** to stage props without committing them.
- **Per-component priority.** `static progressive = { priority }` lets you run important components first. Effective op priority = `componentPriority + opPriority`.
- **Type + Key + Payload.** Ops are `{ type, key, payload, priority }`. **Key** scopes coalescing so “last write wins” happens **per item**, not globally.
- **Squashing.** Combine multiple ops for the same key with `squashWith(prev, next, prevOp, nextOp)`.
- **Child slotting.** `getChildParent(child)` lets a parent choose **where** children attach.
- **Progressive scheduling.** `static progressive = { budget }` time-slices work per frame to avoid hitches.
- **Host API rename.** `attach`/`detach` → `attachNode`/`detachNode`.

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
  static progressive = { budget: 8 }; // max ops/frame
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

**Notes**
- `overscanRows`: default 1. Raise to 2–3 if you see pop-in on fast scrolls.
- Virtualization and culling stack fine; virtualization does the heavy lifting.

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

MIT.

LockVoid Labs
