// core.js
// Renderer-agnostic microframework core
// - Sync Ride.mount (host boots async; updates are buffered)
// - Async-friendly diff() with transactional commits via DIFF.DEFER
// - Pay-as-you-go priorities (only prioritized ops are sorted; others are FIFO)
// - Coalescing by custom key; optional payload squash per target
// - getChildParent(child): parent controls where children attach
// - Progressive frame budget: root static progressive = { budget: ms }
// - Per-component default priority: static progressive = { priority: number }
// - Pre-ready diff buffering: queue ops before host-ready; drain after init
// - Internals swallowed: @ride/init never hits user effect()

// ============================================================================
// Constants
// ============================================================================

export const PRIORITY = Object.freeze({
  // Lower number runs earlier. 0 = highest.
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

// ============================================================================
// CommandBuffer - Manages operation queue with coalescing and priorities
// ============================================================================

class CommandBuffer {
  constructor() {
    this.generation = 0;
    this.ops = [];              // FIFO lane (stable insertion order)
    this.index = new Map();     // coalesceKey -> index in ops[]
    this.size = 0;
    this.sequence = 0;          // stable tie-breaker for same priority
  }

  get length() {
    return this.size;
  }

  nextGen() {
    this.generation++;
  }

  push({ type, key, payload, priority = null, squash = null }) {
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

    // New operation - add to buffer
    if (existingIndex == null) {
      this.index.set(key, this.ops.length);
      this.ops.push(newOp);
      this.size++;
      return;
    }

    // Coalesce with existing operation
    const existingOp = this.ops[existingIndex];
    const mergedPayload = squash
      ? squash(existingOp.payload, payload, existingOp, newOp)
      : payload;

    // Keep original position & sequence for stable ordering
    this.ops[existingIndex] = {
      ...newOp,
      payload: mergedPayload,
      sequence: existingOp.sequence,
    };
  }

  /**
   * Budget-aware drain: calls effect(op) until shouldYield() is true.
   * Returns true if fully drained, false if it yielded with leftovers re-queued.
   */
  async drain(effect, shouldYield) {
    const prioritized = [];
    const unprioritized = [];

    // Separate prioritized and unprioritized operations
    for (const op of this.ops) {
      if (!op) continue;
      (op.priority == null ? unprioritized : prioritized).push(op);
    }

    // Sort only prioritized ops (cheap); FIFO is already stable
    // LOWER priority numbers run first. 0 = highest, larger = lower.
    prioritized.sort((a, b) =>
      (a.priority - b.priority) || (a.sequence - b.sequence),
    );

    // We'll rebuild ops if we yield. For now, clear and process in order.
    this.ops.length = 0;
    this.index.clear();

    const queues = [prioritized, unprioritized];

    for (let qi = 0; qi < queues.length; qi++) {
      const queue = queues[qi];
      for (let i = 0; i < queue.length; i++) {
        const op = queue[i];
        if (shouldYield()) {
          // Re-queue remaining ops: current op + rest of this queue + all remaining queues
          const remaining = queue.slice(i);
          const tailQueues = queues.slice(qi + 1);
          const leftover = remaining.concat(...tailQueues);
          for (const lf of leftover) {
            this.index.set(lf.key, this.ops.length);
            this.ops.push(lf);
          }
          this.size = this.ops.length;
          return false; // NOT fully drained
        }
        await effect(op);
      }
    }

    this.size = 0;
    return true; // fully drained
  }
}

// ============================================================================
// Scheduler - Manages dirty components and RAF-based flushing with budget
// ============================================================================

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

    // Sort by depth for parent-first processing
    const batch = [...this.dirty].sort((a, b) =>
      (a._depth | 0) - (b._depth | 0),
    );
    this.dirty.clear();

    // If host not ready, keep items dirty and retry later
    const anyNotReady = batch.some(c => !c.runtime.isReady);
    if (anyNotReady) {
      batch.forEach(c => {
        if (!c.runtime.isReady) this.dirty.add(c);
      });
      if (this.dirty.size) this._scheduleNext();
      return;
    }

    // Process each component
    const hosts = new Set();

    for (const component of batch) {
      // 1) Ensure node is attached (cheap, idempotent)
      await component._ensureAttached();

      // // 2) Ensure init runs first (as an internal op) and is swallowed
      // if (!component._initDone) {
      //   component._queueInitOp();
      // }

      // 3) Drain whatever is in the buffer (may include pre-ready ops and/or @ride/init)
      if (component._cmds.size > 0) {
        const fullyDrained = await component._cmds.drain(
          component._effect.bind(component),
          shouldYield,
        );
        if (!fullyDrained) this.dirty.add(component);
      }

      // 4) If @ is done and initial props not committed yet, commit NOW (no re-diff)
      if (component._initDone && !component._hasInitialized) {
        if (shouldYield()) {
          this.dirty.add(component);
          break;
        }
        await component._runInitialDiff(); // this commits props and may enqueue ops

        // 5) Try draining those new ops in the SAME frame (budget permitting)
        if (component._cmds.size > 0 && !shouldYield()) {
          const fullyDrained2 = await component._cmds.drain(
            component._effect.bind(component),
            shouldYield,
          );
          if (!fullyDrained2) this.dirty.add(component);
        }
      }

      if (component.runtime?.host) {
        hosts.add(component.runtime.host);
      }

      if (shouldYield()) break; // hard stop for this frame
    }

    // Request render from all affected hosts
    for (const host of hosts) {
      host.requestRender?.();
    }

    // If there is leftover dirty work, schedule the next frame
    if (this.dirty.size) this._scheduleNext();
  }

  _scheduleNext() {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }
}

// ============================================================================
// Runtime - Manages host connection and readiness state
// ============================================================================

class Runtime {
  constructor(scheduler) {
    this.scheduler = scheduler;
    this.host = null;
    this.isReady = false;

    let resolveReady;
    this.whenReady = new Promise(resolve => {
      resolveReady = resolve;
    });

    this._resolveReady = (host) => {
      this.host = host;
      this.isReady = true;
      resolveReady(host);
    };
  }
}

// ============================================================================
// Component - Base class for all components
// ============================================================================

export class Component {
  constructor(props, runtime, parent = null) {
    // Core references
    this.runtime = runtime;
    this.parent = parent;
    this._depth = parent ? (parent._depth + 1) : 0;

    // Props management
    this.props = props || {};           // Committed props
    this._stagedProps = null;           // Pending props (accumulates updates)
    this.prevProps = undefined;

    // Internal state
    this._children = new Set();
    this._cmds = new CommandBuffer();
    this._destroyed = false;

    this._hasInitialized = false;       // initial props committed
    this._needsInitialDiff = true;
    this._preReadyDiffRan = false;      // diff() already ran before host-ready
    this._initDone = false;
    this._diffTicket = 0;               // Prevents stale async diff results
    this._defaultPriority = this.constructor?.progressive?.priority ?? null;

    // Node management
    this.node = null;

    // Setup ready promise (host + parent ready)
    this._setupReadyPromise();

    // Queue init immediately; it will run only after host is ready & node attached.
    this._queueInitOp();

    // Accept immediate updates (buffered if host not ready)
    this.update(this.props);
  }

  getCommandBuffer() {
    return this._cmds;
  }

  _setupReadyPromise() {
    const dependencies = [this.runtime.whenReady];
    if (this.parent) {
      dependencies.push(this.parent.ready);
    }
    // Do not run init/diff here; those are budgeted inside Scheduler.
    this.ready = Promise.all(dependencies).then(() => {});
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
      // We already ran diff pre-ready to buffer ops. Don’t run it again now.
      // Just COMMIT the latest staged props.
      this.props = next;
      this._stagedProps = null;
    } else {
      // Normal path: run the initial diff now (may queue ops).
      const result = await this._runDiff(prev, next);
      if (result !== DIFF.DEFER) {
        this.props = next;
        this._stagedProps = null;
      }
    }

    this._needsInitialDiff = false;
    this._hasInitialized = true;

    // Schedule flush if operations were queued by diff()
    if (this._cmds.size) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  async _runDiff(prev, next) {
    const ticket = ++this._diffTicket;

    let result = this.diff(prev, next);
    if (result && typeof result.then === 'function') {
      result = await result;
    }

    // Discard stale results from concurrent diffs
    if (ticket !== this._diffTicket) {
      return DIFF.DEFER;
    }

    return result === DIFF.DEFER ? DIFF.DEFER : DIFF.COMMIT;
  }

  // Swallows internal ops, forwards only user ops.
  async _effect(op) {
    if (op.type === '@ride/init') {
      if (!this._initDone) {
        const maybe = this.init();
        if (maybe && typeof maybe.then === 'function') await maybe;
        this._initDone = true;
      }
      return; // swallow
    }
    if (op.type === '@ride/initial_diff') {
      // currently not used in this flow; kept for compatibility
      await this._runInitialDiff();
      return; // swallow
    }
    if (typeof this.effect === 'function') {
      return this.effect(op); // user-visible op
    }
  }

  // ===== Public API =====

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
      // Host not ready — run diff now to BUFFER ops, but force DEFER (no commit).
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
    // Keep _stagedProps when deferring for accumulation

    if (this._cmds.size) {
      this.runtime.scheduler.markDirty(this);
    }
  }

  async _processUpdatePreReady(prev, next) {
    await this._runDiff(prev, next);   // queue ops; treat as DEFER regardless
    this._preReadyDiffRan = true;      // so we won't re-run initial diff
    // Do NOT commit props; initial commit will happen after host is ready.
    this.runtime.scheduler.markDirty(this);
  }

  queue(type, payload, opts = {}) {
    const { key, coalesceBy = null, squash = null } = opts;
    const priority = (opts.priority ?? this._defaultPriority);
    const coalesceKey = coalesceBy ? coalesceBy(type, payload) : (key ?? type);

    this._cmds.push({
      type,
      key: coalesceKey,
      payload,
      priority,
      squash,
    });

    this.runtime.scheduler.markDirty(this);
  }

  mount(ChildClass, props) {
    const child = new ChildClass(props, this.runtime, this);
    this._children.add(child);
    return child;
  }

  async unmount(child) {
    if (this._children.delete(child)) {
      await child.destroy();
    }
  }

  async destroy() {
    this._destroyed = true;

    // Destroy all children
    for (const child of this._children) {
      await child.destroy();
    }
    this._children.clear();

    // Detach and destroy node
    if (this.node && this.runtime.host) {
      const parentNode = this.node.parent ?? this.runtime.host.rootNode;
      if (parentNode) {
        this.runtime.host.detachNode(parentNode, this.node);
      }
      this.runtime.host.destroyNode?.(this.node);
    }
  }

  // === Progressive boot as ops ===

  _queueInitOp() {
    // Coalesce by a fixed key so repeated scheduling doesn't duplicate
    const key = `@ride/init:${this._depth}:${this.constructor.name}`;
    this._cmds.push({
      type: '@ride/init',
      key,
      payload: null,
      priority: this._defaultPriority ?? PRIORITY.HIGHEST,
      squash: (prev) => prev,
    });
    this.runtime.scheduler.markDirty(this);
  }

  // ===== Override points =====

  createNode() {
    return this.runtime.host.createNode?.(this) ?? null;
  }

  async init() {
    // Override in subclasses
  }

  getChildParent(_child) {
    return this.node;
  }

  diff(_prev, _next) {
    // Override in subclasses
  }

  async effect(_op) {
    // Override in subclasses for user ops (internals are swallowed in _effect)
  }
}

// ============================================================================
// Ride - Main framework API
// ============================================================================

export class Ride {
  static mount(AppClass, props) {
    const frameBudgetMs = AppClass?.progressive?.budget ?? 8; // per-RAF budget
    const scheduler = new Scheduler({ frameBudgetMs });
    const runtime = new Runtime(scheduler);

    // Create root component immediately
    const app = new AppClass(props, runtime, null);

    // Boot host asynchronously
    this._bootHost(AppClass, props, runtime, scheduler, app);

    return app;
  }

  static async _bootHost(AppClass, props, runtime, scheduler, app) {
    try {
      const host = await AppClass.createHost?.(props);
      if (host) {
        host.isReady = true;
        runtime._resolveReady(host);
        scheduler.markDirty(app); // Trigger first flush after ready
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
