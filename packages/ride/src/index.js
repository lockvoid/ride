// core.js
// Renderer-agnostic microframework core
// - Pre-ready diff buffering (diff() can queue ops before host-ready; no commit)
// - Progressive frame budget: App.progressive = { budget: ms }
// - Per-component priority: Component.progressive = { priority: number } (0 = highest)
// - Effective op priority = componentPriority + opPriority
// - @ride/init priority = componentPriority - 1 (runs first within component)
// - Single-queue snapshot drain; ops queued during drain run next RAF
// - Scheduler batch order: depth -> componentPriority -> creationOrder
// - No RAF scheduled while not ready (keeps buffers inspectable in tests)

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
    this.ops = [];          // public (tests may inspect)
    this.index = new Map(); // coalesceKey -> index in ops[]
    this.size = 0;
    this.sequence = 0;      // stable tie-breaker within same priority
  }

  get length() { return this.size; }
  nextGen() { this.generation++; }

  push({ type, key, payload, priority = null, squashWith = null }) {
    if (!type) throw new Error('op.type is required');
    if (!key) throw new Error('op.key is required (use Component.queue to compute it)');

    const existingIndex = this.index.get(key);
    const newOp = {
      type,
      key,
      payload,
      priority,
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
    const mergedPayload = squashWith
      ? squashWith(existingOp.payload, payload, existingOp, newOp)
      : payload;

    this.ops[existingIndex] = {
      ...newOp,
      payload: mergedPayload,
      sequence: existingOp.sequence, // keep original order
    };
  }

  /**
   * Single-queue, budget-aware drain.
   * - Snapshot current ops and sort by (priority asc, sequence asc)
   * - Anything queued during effect() lands in the live buffer for NEXT RAF
   * - If yielding, leftovers from the snapshot are requeued via push() to preserve coalescing
   */
  async drain(effect, shouldYield) {
    const snapshot = this.ops.slice().sort((a, b) => {
      const pa = (a.priority ?? 0);
      const pb = (b.priority ?? 0);
      return (pa - pb) || (a.sequence - b.sequence);
    });

    // Clear live buffer; new ops (from effect) accumulate here
    this.ops.length = 0;
    this.index.clear();
    this.size = 0;

    for (let i = 0; i < snapshot.length; i++) {
      if (shouldYield()) {
        // Requeue remaining snapshot ops using push() to keep coalescing behavior
        for (let j = i; j < snapshot.length; j++) {
          const lf = snapshot[j];
          this.push({
            type: lf.type,
            key: lf.key,
            payload: lf.payload,
            priority: lf.priority ?? 0,
            squashWith: null,
          });
        }
        return false;
      }

      await effect(snapshot[i]);
    }

    // Done with snapshot; any newly queued ops remain for next RAF
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
    const shouldYield = () => {
      if (noBudget) {
        return false;
      }

      const exceededBudget = (performance.now() - this._frameStart) >= this.frameBudgetMs;

      if (exceededBudget) {
        console.log('!!!!!!!!!!!!!');
        console.log('!!!!!!!!!!!!!');
        console.log('!!!!!!!!!!!!!');
        console.log('!!!!!!!!!!!!!');
      }

      return exceededBudget;
    };
    // Component batch: depth -> componentPriority -> creationOrder
    const batch = [...this.dirty].sort((a, b) =>
      ((a._depth | 0) - (b._depth | 0)) ||
      ((a._componentPriority | 0) - (b._componentPriority | 0)) ||
      ((a._createdAt | 0) - (b._createdAt | 0)),
    );
    this.dirty.clear();

    // If any not ready, keep them dirty and do nothing this frame
    const anyNotReady = batch.some(c => !c.runtime.isReady);
    if (anyNotReady) {
      for (const c of batch) if (!c.runtime.isReady) this.dirty.add(c);
      if (this.dirty.size) this._scheduleNext();
      return;
    }

    const hosts = new Set();

    for (let i = 0; i < batch.length; i++) {
      const component = batch[i];

      // Ensure node attached (idempotent)
      await component._ensureAttached();

      // Drain this component once per frame

      if (component._cmds.size > 0) {
        const drained = await component._cmds.drain(
          component._effect.bind(component),
          shouldYield,
        );
        if (!drained) this.dirty.add(component);
      }

      // Initial commit (after possible pre-ready diffs)
      if (!component._hasInitialized) {
        if (shouldYield()) {
          this.dirty.add(component);
          // Requeue remaining components in this batch for next RAF
          for (let j = i + 1; j < batch.length; j++) this.dirty.add(batch[j]);
          break;
        }

        await component._runInitialDiff();

        // Anything queued during init/commit runs next RAF
        if (component._cmds.size > 0) this.dirty.add(component);
      }

      if (component.runtime?.host) hosts.add(component.runtime.host);

      if (shouldYield()) {
        // Requeue remaining components in this batch for next RAF
        for (let j = i + 1; j < batch.length; j++) this.dirty.add(batch[j]);
        break;
      }
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
  constructor(props, context, runtime, parent = null) {
    // Refs
    this.runtime = runtime;
    this.parent = parent;
    this._depth = parent ? (parent._depth + 1) : 0;

    // Props
    this.props = {};
    this._stagedProps = null;
    this.prevProps = undefined;

    // Context
    this.context = context || {};

    // Internals
    this._children = new Set();
    this._cmds = new CommandBuffer();
    this._destroyed = false;

    this._hasInitialized = false;   // initial props committed
    this._needsInitialDiff = true;
    this._preReadyDiffRan = false;  // diff() already ran pre-ready
    this._initDone = false;
    this._diffTicket = 0;

    this._defaultPriority = this.constructor?.progressive?.priority ?? 0; // 0 = highest
    this._componentPriority = this._defaultPriority | 0;
    this._createdAt = Ride._nextSeq();

    // Node
    this.node = null;

    // Ready promise (host + parent)
    this._setupReadyPromise();

    // Enqueue @ride/init immediately (runs after host is ready)
    this._queueInitOp();

    // Accept immediate updates (pre-ready diff buffers ops)
    this.update(props || {});
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
    if (this.parent) return this.parent.getChildParent?.(this) ?? this.parent.node;
    return this.runtime.host.rootNode;
  }

  async _runInitialDiff() {
    if (!this._needsInitialDiff) return;

    const prev = this.props;
    const next = this._stagedProps ?? this.props;

    if (this._preReadyDiffRan) {
      // Already ran diff pre-ready to buffer ops; just commit props now.
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

  // Swallow internals; forward user ops to effect()
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
      // Host not ready — run diff now to buffer ops (always treated as DEFER)
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
    await this._runDiff(prev, next);   // queue ops; do not commit
    this._preReadyDiffRan = true;
    // IMPORTANT: do NOT schedule RAF while not ready — keep buffers stable.
    // First RAF will be scheduled when the host becomes ready.
  }

  queue(type, payload, opts = {}) {
    const { key, coalesceBy = null, squashWith = null } = opts;
    const opPriority = (opts.priority ?? 0);
    const priority = (this._componentPriority | 0) + (opPriority | 0); // component + op
    const coalesceKey = coalesceBy ? coalesceBy(type, payload) : (key ?? type);

    this._cmds.push({ type, key: coalesceKey, payload, priority, squashWith });

    // Do not schedule RAF before ready; buffer stays inspectable for tests
    if (this.runtime.isReady) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  mount(ChildClass, props) {
    const child = new ChildClass(props, this.context, this.runtime, this);
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

  /* === Internal boot === */

  _queueInitOp() {
    const key = `@ride/init:${this._depth}:${this.constructor.name}`;
    this._cmds.push({
      type: '@ride/init',
      key,
      payload: null,
      priority: (this._componentPriority | 0) - 1, // runs before any user op of this component
      squashWith: (prev) => prev,
    });
    if (this.runtime.isReady) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  /* ===== Override points ===== */

  createNode() { return this.runtime.host.createNode?.(this) ?? null; }
  async init() {}
  getChildParent(_child) { return this.node; }
  diff(_prev, _next) {}
  async effect(_op) {}
}

/* ============================================================================
 * Ride
 * ==========================================================================*/

export class Ride {
  static _seq = 0;
  static _nextSeq() { return ++this._seq; }

  static mount(AppClass, props = {}, context = {}) {
    const frameBudgetMs = AppClass?.progressive?.budget ?? 8;
    const scheduler = new Scheduler({ frameBudgetMs });
    const runtime = new Runtime(scheduler);

    const app = new AppClass(props, context, runtime, null); // immediate

    // Boot host asynchronously
    this._bootHost(AppClass, props, context, runtime, scheduler, app);

    return app;
  }

  static async _bootHost(AppClass, props, context, runtime, scheduler, app) {
    try {
      const host = await AppClass.createHost?.(props, context); // may be deferred
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
