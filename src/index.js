// core.js
// Renderer-agnostic microframework core
// - Sync Ride.mount (host boots async; updates are buffered)
// - Async-friendly diff() with transactional commits via DIFF.DEFER
// - Pay-as-you-go priorities (only prioritized ops are sorted; others are FIFO)
// - Coalescing by custom key; optional payload squash per target
// - getChildParent(child): parent controls where children attach

export const PRIORITY = Object.freeze({ remove: 0, insert: 1, patch: 2, layout: 3, paint: 4 });
export const DIFF = Object.freeze({ DEFER: 0, COMMIT: 1 });

class CommandBuffer {
  constructor() {
    this.generation = 0;
    this.ops = [];           // FIFO lane (stable insertion order)
    this.index = new Map();  // coalesceKey -> index in ops[]
    this.size = 0;
    this.sequence = 0;       // stable tie-breaker
  }
  nextGen() { this.generation++; }

  // Expects: { type, key, payload, priority?, squash? }
  push({ type, key, payload, priority = null, squash = null }) {
    if (!type) throw new Error('op.type is required');
    if (!key) throw new Error('op.key is required (use Component.queue to compute it)');

    const i = this.index.get(key);
    const next = { type, key, payload, priority, generation: this.generation, sequence: ++this.sequence };

    if (i == null) {
      this.index.set(key, this.ops.length);
      this.ops.push(next);
      this.size++;
      return;
    }

    // Coalesce in place (last-write-wins); keep original position & sequence
    const prev = this.ops[i];
    const combined = squash ? squash(prev.payload, payload, prev, next) : payload;
    this.ops[i] = { ...next, payload: combined, sequence: prev.sequence };
  }

  async drain(effect) {
    const g = this.generation;
    const pri = [];
    const fifo = [];

    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i];
      //if (!op || op.generation !== g) continue; // drop stale generations
      if (!op) continue; // process everything; newer ops have already coalesced keys

      (op.priority == null ? fifo : pri).push(op);
    }

    // Sort only prioritized ops (cheap); FIFO is already stable
    pri.sort((a, b) => (a.priority - b.priority) || (a.sequence - b.sequence));

    // Reset buffer
    this.ops.length = 0;
    this.index.clear();
    this.size = 0;

    for (const op of pri)  await effect(op);
    for (const op of fifo) await effect(op);
  }
}

class Scheduler {
  constructor() { this.dirty = new Set(); this.scheduled = false; }
  markDirty(c) {
    this.dirty.add(c);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  async flush() {
    this.scheduled = false;
    if (!this.dirty.size) return;

    // parents first for deterministic layout → children
    const batch = [...this.dirty].sort((a, b) => (a._depth | 0) - (b._depth | 0));
    this.dirty.clear();

    // If host not ready, keep items dirty and retry later
    const anyNotReady = batch.some(c => !c.runtime.isReady);
    if (anyNotReady) {
      for (const c of batch) if (!c.runtime.isReady) this.dirty.add(c);
      return;
    }

    const hosts = new Set();
    for (const c of batch) {
      const isInitialFlush = !c._hasInitialized;
      await c.ready;

      // Only drain if this is NOT the initial flush
      // (ops from init() should wait for next frame)
      if (!isInitialFlush && c._cmds.size > 0) {
        await c._cmds.drain(c.effect.bind(c));
      }

      if (c.runtime?.host) hosts.add(c.runtime.host);
    }
    for (const h of hosts) h.requestRender?.();
  }
}

class Runtime {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.host = null;
    this.isReady = false;
    let resolve;
    this.whenReady = new Promise(r => (resolve = r));
    this._resolveReady = (host) => { this.host = host; this.isReady = true; resolve(host); };
  }
}

export class Component {
  constructor(props, runtime, parent = null) {
    this.runtime = runtime;               // { scheduler, host?, isReady, whenReady }
    this.parent = parent;
    this._depth = parent ? (parent._depth + 1) : 0;

    this.props = props || {};             // committed props (advance only when diff !== DEFER)
    this._stagedProps = null;             // accumulated next-props pending commit
    this.prevProps = undefined;

    this._children = new Set();
    this._cmds = new CommandBuffer();
    this._destroyed = false;

    this.node = null;
    this._needsInitialDiff = true;
    this._diffTicket = 0;                 // fence for async diff()
    this._initialFlushDone = false;
    this._hasInitialized = false;

    const deps = [this.runtime.whenReady];
    if (parent) deps.push(parent.ready);

    this.ready = Promise.all(deps).then(async () => {
      // Create & attach node once host is available
      this.node = this.createNode();

      // Parent can choose the attach point for children via getChildParent(child)
      const parentAttachNode = this.parent
        ? (this.parent.getChildParent?.(this) ?? this.parent.node)
        : this.runtime.host.rootNode;

      this.runtime.host.attachNode(parentAttachNode, this.node);

      await this.init();

      // First diff from committed props → staged/current props (if any)
      if (this._needsInitialDiff) {
        const prev = this.props;
        const next = this._stagedProps ?? this.props;
        const res = await this._runDiff(prev, next);
        if (res !== DIFF.DEFER) this.props = next;  // commit unless deferred
        this._stagedProps = null;
        this._needsInitialDiff = false;
        this._hasInitialized = true;
        if (this._cmds.size) this.runtime.scheduler.markDirty(this);
      }
    });

    // Accept immediate updates (buffered if host not ready)
    this.update(this.props);
  }

  // ----- override points -----
  createNode() { return this.runtime.host.createNode?.(this) ?? null; }
  async init() {}

  // Choose where this component's children attach. Default: under this.node.
  // Receives the child component instance for routing decisions.
  getChildParent(_child) { return this.node; }

  // Can be sync or async; may return DIFF.DEFER to avoid committing props this update.
  diff(_prev, _next) {}

  // Apply queued ops (switch on op.type)
  async effect(_op) {}

  // ----- child mgmt -----
  mount(ChildClass, props) { const ch = new ChildClass(props, this.runtime, this); this._children.add(ch); return ch; }
  async unmount(child) { if (this._children.delete(child)) await child.destroy(); }

  // ----- queue helper (type + coalesce key + optional priority/squash) -----
  // opts: { key?: string, priority?: number|null, coalesceBy?: (type, payload) => string, squash?: (prevPayload, nextPayload, prevOp, nextOp) => any }
  queue(type, payload, opts = {}) {
    const { key, priority = null, coalesceBy = null, squash = null } = opts;
    const coalesceKey = coalesceBy ? coalesceBy(type, payload) : (key ?? type);
    this._cmds.push({ type, key: coalesceKey, payload, priority, squash });
    this.runtime.scheduler.markDirty(this);
  }

  async _runDiff(prev, next) {
    const ticket = ++this._diffTicket;
    let out = this.diff(prev, next);
    if (out && typeof out.then === 'function') out = await out;
    if (ticket !== this._diffTicket) return DIFF.DEFER;       // stale result → don't commit
    return out === DIFF.DEFER ? DIFF.DEFER : DIFF.COMMIT;     // default commit
  }

  update(patch) {
    if (this._destroyed) return;
    this._cmds.nextGen();

    const prev = this.props;
    // Accumulate on top of currently staged props to avoid losing quick successive updates
    const base = this._stagedProps ?? prev;
    const next = Object.assign({}, base, patch);
    this._stagedProps = next;
    this.prevProps = { ...prev };

    if (this.runtime.isReady) {
      this._needsInitialDiff = false;
      this._runDiff(prev, next).then((res) => {
        if (this._destroyed) return;
        if (res !== DIFF.DEFER) {
          this.props = next;  // commit unless deferred
          this._stagedProps = null;
        } else {
          // Keep _stagedProps when deferring so next update can accumulate
        }

        if (this._cmds.size) this.runtime.scheduler.markDirty(this);
      });
    } else {
      // Host not ready yet → defer first diff to attach time
      this._needsInitialDiff = true;
      this.runtime.scheduler.markDirty(this);
    }
  }

  async destroy() {
    this._destroyed = true;
    for (const ch of this._children) await ch.destroy();
    this._children.clear();

    if (this.node && this.runtime.host) {
      const parentNode = this.node.parent ?? this.runtime.host.rootNode;
      if (parentNode) this.runtime.host.detachNode(parentNode, this.node);
      this.runtime.host.destroyNode?.(this.node);
    }
  }
}

export class Ride {
  // Synchronous mount: returns the app immediately.
  // Host creation runs in the background; updates are buffered until ready.
  static mount(AppClass, props) {
    const scheduler = new Scheduler();
    const runtime = new Runtime(scheduler);

    // Root App is just a Component; it will defer node/init until runtime.whenReady
    const app = new AppClass(props, runtime, null);

    // Boot host asynchronously, then flip ready and trigger a flush
    (async () => {
      const host = await AppClass.createHost?.(props);
      if (host) host.isReady = true;
      runtime._resolveReady(host);
      scheduler.markDirty(app); // kick initial drain
    })().catch(err => console.error('Ride host init failed:', err));

    return app;
  }

  static async unmount(app) {
    await app.destroy();
    app.runtime.host?.teardown?.();
  }
}
