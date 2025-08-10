// core.js
// Renderer-agnostic microframework core
// - Sync Ride.mount (host boots async; updates can buffer)
// - Pre-ready diff buffering: diff() runs pre-ready, queues ops, no prop commit
// - Progressive frame budget: root static progressive = { budget: ms }
// - Per-component default priority: static progressive = { priority: number } (0 highest)
// - Pay-as-you-go priorities (only prioritized ops sorted; others FIFO)
// - Coalescing by custom key; optional payload squash per target
// - getChildParent(child): parent controls where children attach
// - Internal ops swallowed (@ride/init)

/* ============================================================================
 * Constants
 * ==========================================================================*/

export const PRIORITY = Object.freeze({
  HIGHEST: 0,
  HIGH: 10,
  MEDIUM: 50,
  LOW: 80,
  LOWEST: 100,
});

export const DIFF = Object.freeze({
  DEFER: 0,
  COMMIT: 1,
});

/* ============================================================================
 * CommandBuffer
 * ==========================================================================*/

class CommandBuffer {
  constructor() {
    this.generation = 0;
    this.ops = [];              // public: tests rely on this
    this.index = new Map();     // coalesceKey -> index in ops[]
    this.size = 0;
    this.sequence = 0;          // stable tie-breaker for same priority
  }

  get length() { return this.size; }

  nextGen() { this.generation++; }

  push({ type, key, payload, priority = null, squash = null }) {
    if (!type) throw new Error('op.type is required');
    if (!key) throw new Error('op.key is required (use Component.queue to compute it)');

    const existingIndex = this.index.get(key);
    const newOp = {
      type, key, payload, priority,
      generation: this.generation,
      sequence: ++this.sequence,
    };

    if (existingIndex == null) {
      this.index.set(key, this.ops.length);
      this.ops.push(newOp);
      this.size++;
      return;
    }

    const existingOp = this.ops[existingIndex];
    const mergedPayload = squash ? squash(existingOp.payload, payload, existingOp, newOp) : payload;

    this.ops[existingIndex] = {
      ...newOp,
      payload: mergedPayload,
      sequence: existingOp.sequence, // keep original order
    };
  }

  /**
   * Budget-aware drain: calls effect(op) until shouldYield() is true.
   * Returns true if fully drained, false if yielded with leftovers re-queued.
   */
   async drain(effect, shouldYield) {
     // Snapshot current ops (so anything queued during effect() runs next RAF)
     const snapshot = this.ops.slice();

     // Sort: 0 = highest; ties by insertion sequence for stability
     snapshot.sort((a, b) => {
       const pa = (a.priority ?? 0);
       const pb = (b.priority ?? 0);
       return (pa - pb) || (a.sequence - b.sequence);
     });

     // Clear live buffer; new ops (queued during effect) will land here
     this.ops.length = 0;
     this.index.clear();
     this.size = 0;

     for (let i = 0; i < snapshot.length; i++) {
       // If we must yield, requeue the remaining *snapshot* ops using push()
       if (shouldYield()) {
         for (let j = i; j < snapshot.length; j++) {
           const lf = snapshot[j];
           this.push({
             type: lf.type,
             key: lf.key,
             payload: lf.payload,
             priority: lf.priority ?? 0,
             squash: null,
           });
         }
         // size already updated by push()
         return false; // not fully drained
       }

       await effect(snapshot[i]);
     }

     // Fully drained the snapshot; leave any newly queued ops for next RAF
     this.size = this.ops.length;
     return true;
   }
}

/* ============================================================================
 * Scheduler (RAF + budget)
 * ==========================================================================*/

class Scheduler {
  constructor({ frameBudgetMs = 8 } = {}) {
    this.dirty = new Set();
    this.scheduled = false;
    this.frameBudgetMs = frameBudgetMs;
    this._frameStart = 0;
  }

  markDirty(component) {
    this.dirty.add(component);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  async flush() {
    this.scheduled = false;
    if (!this.dirty.size) return;

    this._frameStart = performance.now();
    const noBudget = this.frameBudgetMs <= 0 || !Number.isFinite(this.frameBudgetMs);
    const shouldYield = () =>
      noBudget ? false : (performance.now() - this._frameStart) >= this.frameBudgetMs;

    // parent-first
    const batch = [...this.dirty].sort((a, b) => (a._depth | 0) - (b._depth | 0));
    this.dirty.clear();

    // if any not ready, do nothing this frame (buffers remain untouched)
    const anyNotReady = batch.some(c => !c.runtime.isReady);
    if (anyNotReady) {
      batch.forEach(c => { if (!c.runtime.isReady) this.dirty.add(c); });
      if (this.dirty.size) this._scheduleNext();
      return;
    }

    const hosts = new Set();

    for (const component of batch) {
      // attach node (idempotent)
      await component._ensureAttached();

      // drain whatever is queued (may include @ride/init and pre-ready ops)
      if (component._cmds.size > 0) {
        const drained = await component._cmds.drain(
          component._effect.bind(component),
          shouldYield,
        );
        if (!drained) this.dirty.add(component);
      }

      // commit initial props if not yet committed (no re-diff if pre-ready diff ran)
      if (!component._hasInitialized) {
        if (shouldYield()) { this.dirty.add(component); break; }
        await component._runInitialDiff();

        if (component._cmds.size > 0) {
          this.dirty.add(component);
        }
      }

      if (component.runtime?.host) hosts.add(component.runtime.host);
      if (shouldYield()) break;
    }

    for (const host of hosts) host.requestRender?.();

    if (this.dirty.size) this._scheduleNext();
  }

  _scheduleNext() {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }
}

/* ============================================================================
 * Runtime
 * ==========================================================================*/

class Runtime {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.host = null;
    this.isReady = false;

    let resolveReady;
    this.whenReady = new Promise(resolve => { resolveReady = resolve; });
    this._resolveReady = (host) => {
      this.host = host;
      this.isReady = true;
      resolveReady(host);
    };
  }
}

/* ============================================================================
 * Component
 * ==========================================================================*/

export class Component {
  constructor(props, runtime, parent = null) {
    // refs
    this.runtime = runtime;
    this.parent = parent;
    this._depth = parent ? (parent._depth + 1) : 0;

    // props
    this.props = props || {};
    this._stagedProps = null;
    this.prevProps = undefined;

    // internals
    this._children = new Set();
    this._cmds = new CommandBuffer();
    this._destroyed = false;

    this._hasInitialized = false;     // initial props committed
    this._needsInitialDiff = true;
    this._preReadyDiffRan = false;    // diff() already ran pre-ready
    this._initDone = false;
    this._diffTicket = 0;
    this._defaultPriority = this.constructor?.progressive?.priority ?? 0;

    // node
    this.node = null;

    // ready promise (host + parent)
    this._setupReadyPromise();

    // enqueue init immediately; will run only after host is ready
    this._queueInitOp();

    // allow immediate updates (pre-ready diff buffers ops)
    this.update(this.props);
  }

  getCommandBuffer() { return this._cmds; } // test helper (live object)

  _setupReadyPromise() {
    const deps = [this.runtime.whenReady];
    if (this.parent) deps.push(this.parent.ready);
    this.ready = Promise.all(deps).then(() => {});
  }

  async _ensureAttached() {
    if (this.node) return;
    this.node = this.createNode();
    const parentNode = this._getParentNode();
    this.runtime.host.attachNode(parentNode, this.node);
  }

  _getParentNode() {
    if (this.parent) {
      return this.parent.getChildParent?.(this) ?? this.parent.node;
    }
    return this.runtime.host.rootNode;
  }

  async _runInitialDiff() {
    if (!this._needsInitialDiff) return;

    const prev = this.props;
    const next = this._stagedProps ?? this.props;

    if (this._preReadyDiffRan) {
      // we already computed and queued ops pre-ready; just commit props now
      this.props = next;
      this._stagedProps = null;
    } else {
      const result = await this._runDiff(prev, next);
      if (result !== DIFF.DEFER) {
        this.props = next;
        this._stagedProps = null;
      }
    }

    this._needsInitialDiff = false;
    this._hasInitialized = true;

    if (this._cmds.size) this.runtime.scheduler.markDirty(this);
  }

  async _runDiff(prev, next) {
    const ticket = ++this._diffTicket;
    let result = this.diff(prev, next);
    if (result && typeof result.then === 'function') result = await result;
    if (ticket !== this._diffTicket) return DIFF.DEFER; // stale
    return result === DIFF.DEFER ? DIFF.DEFER : DIFF.COMMIT;
  }

  // swallow internal ops; forward user ops to effect()
  async _effect(op) {
    if (op.type === '@ride/init') {
      if (!this._initDone) {
        const maybe = this.init();
        if (maybe && typeof maybe.then === 'function') await maybe;
        this._initDone = true;
      }
      return; // swallowed
    }
    if (typeof this.effect === 'function') {
      return this.effect(op);
    }
  }

  /* ===== Public API ===== */

  update(patch) {
    if (this._destroyed) return;

    this._cmds.nextGen();

    const prev = this.props;
    const base = this._stagedProps ?? prev;
    const next = Object.assign({}, base, patch);

    this._stagedProps = next;
    this.prevProps = { ...prev };

    if (this.runtime.isReady) {
      this._needsInitialDiff = false;
      this._processUpdate(prev, next);
    } else {
      // host not ready — run diff now to buffer ops (always treated as DEFER)
      this._needsInitialDiff = true;
      this._processUpdatePreReady(prev, next);
    }
  }

  async _processUpdate(prev, next) {
    const result = await this._runDiff(prev, next);
    if (this._destroyed) return;
    if (result !== DIFF.DEFER) {
      this.props = next;
      this._stagedProps = null;
    }
    if (this.runtime.isReady && this._cmds.size) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  async _processUpdatePreReady(prev, next) {
    await this._runDiff(prev, next);   // queues ops; props not committed
    this._preReadyDiffRan = true;
    // IMPORTANT: do NOT schedule RAF while not ready — keep buffers stable
    // First RAF will be scheduled when host becomes ready.
  }

  queue(type, payload, opts = {}) {
    const { key, coalesceBy = null, squash = null } = opts;
    const priority = this._defaultPriority + (opts.priority ?? 0);
    const coalesceKey = coalesceBy ? coalesceBy(type, payload) : (key ?? type);

    this._cmds.push({ type, key: coalesceKey, payload, priority, squash });

    // Do not schedule RAF before ready; keep buffer inspectable in tests.
    if (this.runtime.isReady) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  mount(ChildClass, props) {
    const child = new ChildClass(props, this.runtime, this);
    this._children.add(child);
    return child;
  }

  async unmount(child) {
    if (this._children.delete(child)) await child.destroy();
  }

  async destroy() {
    this._destroyed = true;
    for (const child of this._children) await child.destroy();
    this._children.clear();

    if (this.node && this.runtime.host) {
      const parentNode = this.node.parent ?? this.runtime.host.rootNode;
      if (parentNode) this.runtime.host.detachNode(parentNode, this.node);
      this.runtime.host.destroyNode?.(this.node);
    }
  }

  /* === internal boot === */

  _queueInitOp() {
    const key = `@ride/init:${this._depth}:${this.constructor.name}`;
    this._cmds.push({
      type: '@ride/init',
      key,
      payload: null,
      priority: this._defaultPriority - 1,
      squash: (prev) => prev,
    });
    // Do NOT schedule RAF before ready.
    if (this.runtime.isReady) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  /* ===== Override points ===== */

  createNode() { return this.runtime.host.createNode?.(this) ?? null; }

  async init() {
    // user hook, may be async, may queue ops
  }

  getChildParent(_child) { return this.node; }

  diff(_prev, _next) {
    // user override; may return DIFF.DEFER
  }

  async effect(_op) {
    // user override for user ops
  }
}

/* ============================================================================
 * Ride
 * ==========================================================================*/

export class Ride {
  static mount(AppClass, props) {
    const frameBudgetMs = AppClass?.progressive?.budget ?? 8;
    const scheduler = new Scheduler({ frameBudgetMs });
    const runtime = new Runtime(scheduler);

    const app = new AppClass(props, runtime, null); // immediate

    // boot host async
    this._bootHost(AppClass, props, runtime, scheduler, app);

    return app;
  }

  static async _bootHost(AppClass, props, runtime, scheduler, app) {
    try {
      const host = await AppClass.createHost?.(props); // may be deferred
      if (host) {
        host.isReady = true;
        runtime._resolveReady(host);
        scheduler.markDirty(app); // first RAF after ready flushes everything
      }
    } catch (err) {
      console.error('Ride host init failed:', err);
    }
  }

  static async unmount(app) {
    await app.destroy();
    app.runtime.host?.teardown?.();
  }
}
