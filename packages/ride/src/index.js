// core.js
// Renderer-agnostic microframework core
// - Pre-ready diff buffering (diff() can queue ops before host-ready; no commit)
// - Progressive frame budget: App.progressive = { budget: ms }
// - Per-component priority: Component.progressive = { priority: number } (0 = highest)
// - Effective op priority = componentPriority + opPriority
// - @ride/init priority = componentPriority - 1 (runs first within component)
// - Single-queue snapshot drain; ops queued during effect() land in the live buffer for NEXT RAF
// - Scheduler batch order: depth -> componentPriority -> creationOrder
// - No RAF scheduled while not ready (keeps buffers inspectable in tests)
// - effect(op) may return a cleanup fn; it runs before the next effect of the same key and on unmount.
// - Deterministic testing: Scheduler.whenIdle() + Ride.flushUntilIdle(app)
// - Error surface: route errors to App.onError?.(err, { component, op, phase })
// - Behaviors/traits: classes declare `static behaviors = [...]` (merged base→derived automatically)
// - NEW: progressive.locality = 'depth' | 'subtree' (default 'depth')

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
 * Scheduler (RAF + budget) with in-flight tracking, depth-gated yielding,
 * and locality='subtree' processing.
 * ==========================================================================*/

class Scheduler {
  constructor({ frameBudgetMs = 8, debug = false, onYield = null } = {}) {
    this.dirty = new Set();
    this.scheduled = false;
    this.frameBudgetMs = frameBudgetMs;
    this.debug = debug;
    this.onYield = onYield;
    this._frameStart = 0;

    // In-flight flush tracking (for deterministic tests/tools)
    this._inFlight = null;          // Promise | null
    this._resolveInFlight = null;   // () => void | null

    // Locality (during flush)
    this._duringFlush = false;
    this._localityRoot = null;     // root component when processing locality='subtree'
    this._localityMode = 'depth';  // 'depth' | 'subtree'
    this._localQueue = null;       // Set<Component> of newly dirtied descendants
  }

  setFrameBudget(ms) { this.frameBudgetMs = ms; }
  getFrameBudget() { return this.frameBudgetMs; }

  static _isDescendant(node, root) {
    for (let p = node; p; p = p.parent) if (p === root) return true;
    return false;
  }

  markDirty(component) {
    // If we're currently flushing a locality='subtree' root, pull dirty descendants
    // into the *current* frame via the local queue.
    if (
      this._duringFlush &&
      this._localityMode === 'subtree' &&
      this._localityRoot &&
      Scheduler._isDescendant(component, this._localityRoot)
    ) {
      if (!this._localQueue) this._localQueue = new Set();
      this._localQueue.add(component);
      // Do NOT schedule a new RAF; we will drain locals in this same flush.
      return;
    }

    this.dirty.add(component);
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  async flush() {
    // Serialize overlapping calls
    if (this._inFlight) await this._inFlight;
    this._inFlight = new Promise(res => { this._resolveInFlight = res; });
    this._duringFlush = true;

    this.scheduled = false;

    try {
      if (!this.dirty.size) return;

      this._frameStart = performance.now();
      const noBudget = this.frameBudgetMs <= 0 || !Number.isFinite(this.frameBudgetMs);
      const shouldYield = () => {
        if (noBudget) return false;
        const elapsed = performance.now() - this._frameStart;
        const exceeded = elapsed >= this.frameBudgetMs;
        if (exceeded && this.onYield) this.onYield(elapsed);
        return exceeded;
      };

      // Component batch: depth -> componentPriority -> creationOrder
      const batch = [...this.dirty].sort((a, b) =>
        ((a._depth | 0) - (b._depth | 0)) ||
        ((a._componentPriority | 0) - (b._componentPriority | 0)) ||
        ((a._createdAt | 0) - (b._createdAt | 0)),
      );
      this.dirty.clear();

      // Depth group gating: don't split siblings at the same depth
      let groupDepth = batch.length ? (batch[0]._depth | 0) : null;
      const shouldYieldBetweenComponents = (nextDepth) => {
        if (this._localityMode === 'subtree') return false; // locality processing ignores depth gating
        if (groupDepth != null && nextDepth === groupDepth) return false;
        return shouldYield();
      };

      // If any not ready, keep them dirty and do nothing this frame
      const anyNotReady = batch.some(c => !c.runtime.isReady);
      if (anyNotReady) {
        for (const c of batch) if (!c.runtime.isReady) this.dirty.add(c);
        if (this.dirty.size) this._scheduleNext();
        return;
      }

      const hosts = new Set();
      let stop = false;

      const processOne = async (component, { allowDepthYield }) => {
        if (component._destroyed) return false;

        // Ensure node attached (idempotent)
        try {
          await component._ensureAttached();
        } catch (err) {
          component.runtime.reportError(err, { component, op: null, phase: 'attach' });
          return false;
        }

        // Drain this component once per frame
        if (component._cmds.size > 0) {
          const drained = await component._cmds.drain(
            component._effect.bind(component),
            shouldYield,
          );
          if (!drained) {
            this.dirty.add(component);
            return true; // yielded
          }
        }

        // Initial commit (after possible pre-ready diffs)
        if (!component._hasInitialized) {
          if (allowDepthYield && shouldYieldBetweenComponents(component._depth | 0)) {
            this.dirty.add(component);
            return true; // yielded between components
          }

          try {
            await component._runInitialDiff();
          } catch (err) {
            component.runtime.reportError(err, { component, op: null, phase: 'initial-diff' });
          }

          // Anything queued during init/commit runs next RAF (unless captured by locality)
          if (component._cmds.size > 0) this.dirty.add(component);
        }

        if (component.runtime?.host) hosts.add(component.runtime.host);
        return false;
      };

      for (let i = 0; i < batch.length && !stop; i++) {
        const component = batch[i];

        // Set locality root per component
        const loc = component.constructor?.progressive?.locality ?? 'depth';
        this._localityMode = loc;
        this._localityRoot = (loc === 'subtree') ? component : null;
        this._localQueue = null;

        // Process the component itself with depth gating
        const yielded = await processOne(component, { allowDepthYield: true });
        if (yielded) {
          // Requeue remaining components in this batch
          for (let j = i + 1; j < batch.length; j++) this.dirty.add(batch[j]);
          stop = true;
        } else if (this._localityRoot) {
          // Drain any locally dirtied descendants (subtree locality)
          while (!stop && this._localQueue && this._localQueue.size) {
            const locals = [...this._localQueue];
            this._localQueue.clear();

            // Sort locals with the same comparator
            locals.sort((a, b) =>
              ((a._depth | 0) - (b._depth | 0)) ||
              ((a._componentPriority | 0) - (b._componentPriority | 0)) ||
              ((a._createdAt | 0) - (b._createdAt | 0)),
            );

            for (let k = 0; k < locals.length; k++) {
              const lc = locals[k];
              const y = await processOne(lc, { allowDepthYield: false }); // no depth-gating inside subtree
              if (y || shouldYield()) {
                // Budget pressure: requeue remaining locals and batch
                for (let m = k; m < locals.length; m++) this.dirty.add(locals[m]);
                for (let j = i + 1; j < batch.length; j++) this.dirty.add(batch[j]);
                stop = true;
                break;
              }
            }
          }
        }

        // Clear locality context before moving on
        this._localityRoot = null;
        this._localQueue = null;
        this._localityMode = 'depth';

        if (stop) break;

        // End of component: update groupDepth and maybe yield *between* components
        const nextDepth = (i + 1) < batch.length ? (batch[i + 1]._depth | 0) : (groupDepth == null ? null : groupDepth + 1);
        if (nextDepth !== null && nextDepth !== groupDepth) {
          if (shouldYieldBetweenComponents(nextDepth)) {
            for (let j = i + 1; j < batch.length; j++) this.dirty.add(batch[j]);
            break;
          }
          groupDepth = nextDepth; // advance group
        }
      }

      for (const host of hosts) host.requestRender?.();

      if (this.dirty.size) this._scheduleNext();
    } finally {
      // Resolve in-flight for *this* flush call
      const done = this._resolveInFlight;
      this._resolveInFlight = null;
      this._inFlight = null;
      this._duringFlush = false;
      this._localityRoot = null;
      this._localityMode = 'depth';
      this._localQueue = null;
      done?.();
    }
  }

  _scheduleNext() {
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  /**
   * Deterministic wait: run/await flushes until there are no pending frames or work.
   */
  async whenIdle({ max = 100 } = {}) {
    for (let i = 0; i < max; i++) {
      if (this._inFlight) await this._inFlight;
      if (this.scheduled) { await this.flush(); continue; }
      if (this.dirty.size) { await this.flush(); continue; }
      return;
    }
    throw new Error('Scheduler.whenIdle(): exceeded max iterations');
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
    this.app = null; // set by Ride.mount

    let resolveReady;
    this.whenReady = new Promise(resolve => { resolveReady = resolve; });
    this._resolveReady = (host) => {
      this.host = host;
      this.isReady = true;
      resolveReady(host);
    };
  }

  reportError(err, ctx) {
    try {
      // Prefer app-level handlers when available
      const app = this.app;
      let handler = app?.constructor?.onError || app?.onError;
      let receiver = app;

      // Fallback to component-level handlers if app not ready yet
      if (typeof handler !== 'function') {
        const comp = ctx?.component;
        handler = comp?.constructor?.onError || comp?.onError;
        receiver = comp;
      }

      if (typeof handler === 'function') {
        handler.call(receiver, err, ctx);
      } else {
        console.error('[Ride] Unhandled error:', err, ctx);
      }
    } catch (e) {
      console.error('[Ride] Error in onError handler:', e, { originalError: err, ctx });
    }
  }
}

/* ============================================================================
 * Component (with behaviors)
 * ==========================================================================*/

export class Component {
  // Local-only behaviors; base → derived merged automatically at runtime
  static behaviors = Object.freeze([]);

  // Optional plugin sugar
  static use(...bs) {
    const cur = this.behaviors || [];
    this.behaviors = Object.freeze([...cur, ...bs]);
  }

  // Merge behaviors along prototype chain (base first, then derived)
  static _collectBehaviors() {
    const out = [];
    for (let C = this; C && C !== Component; C = Object.getPrototypeOf(C)) {
      const list = C.behaviors || C.behaviours || [];
      if (list && list.length) out.unshift(...list);
    }
    return Object.freeze(out);
  }

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

    // Cleanups
    this._cleanups = new Map();     // key -> () => (void|Promise)
    this._initCleanup = null;       // legacy init cleanup
    this._lifetimeCleanups = [];    // behavior init cleanups (component lifetime)

    // Behaviors
    this._behaviors = this.constructor._collectBehaviors();

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

  _commit(next) {
    this.prevProps = this.props;
    this.props = next;
    this._stagedProps = null;
  }

  _makeCtx({ phase, op, collectCleanupsRef, deferFlagRef } = {}) {
    const component = this;
    const onError = (err, ph = phase, extra) =>
      this.runtime.reportError(err, { component, op: op ?? null, phase: ph, ...extra });

    const addCleanup = (fn) => {
      if (typeof fn !== 'function') return;
      if (phase === 'effect' && collectCleanupsRef) {
        collectCleanupsRef.push(fn);
      } else {
        // treat as lifetime cleanup (e.g., behavior init)
        this._lifetimeCleanups.push(fn);
      }
    };

    const defer = () => { if (deferFlagRef) deferFlagRef.value = true; };

    return { component, addCleanup, defer, onError };
  }

  async _runInitialDiff() {
    if (!this._needsInitialDiff) return;

    const prev = this.props;
    const next = this._stagedProps ?? this.props;

    if (this._preReadyDiffRan) {
      // Already ran diff pre-ready to buffer ops; just commit props now.
      this._commit(next);
    } else {
      const result = await this._runDiff(prev, next);
      if (result !== DIFF.DEFER) {
        this._commit(next);
      }
    }

    this._needsInitialDiff = false;
    this._hasInitialized = true;

    if (this._cmds.size) this.runtime.scheduler.markDirty(this);
  }

  async _runDiff(prev, next) {
    const ticket = ++this._diffTicket;

    // Behaviors can force defer
    const deferFlagRef = { value: false };
    if (this._behaviors.length) {
      const ctx = this._makeCtx({ phase: 'diff', deferFlagRef });
      for (const b of this._behaviors) {
        if (!b?.diff) continue;
        try {
          let r = b.diff.call(this, prev, next, ctx);
          if (r && typeof r.then === 'function') r = await r;
          if (r === DIFF.DEFER) deferFlagRef.value = true;
        } catch (err) {
          this.runtime.reportError(err, { component: this, op: null, phase: 'diff' });
          deferFlagRef.value = true;
        }
      }
    }

    let result;
    try { result = this.diff(prev, next); }
    catch (err) { this.runtime.reportError(err, { component: this, op: null, phase: 'diff' }); deferFlagRef.value = true; }
    if (result && typeof result.then === 'function') {
      try { result = await result; }
      catch (err) { this.runtime.reportError(err, { component: this, op: null, phase: 'diff' }); deferFlagRef.value = true; }
    }

    if (ticket !== this._diffTicket) return DIFF.DEFER; // stale
    if (deferFlagRef.value || result === DIFF.DEFER) return DIFF.DEFER;
    return DIFF.COMMIT;
  }

  // Pre-ready diff path: skip behaviors to avoid spurious first-render effects
  async _runDiffPreReady(prev, next) {
    const ticket = ++this._diffTicket;
    let result;
    try { result = this.diff(prev, next); }
    catch (err) { this.runtime.reportError(err, { component: this, op: null, phase: 'diff' }); return DIFF.DEFER; }
    if (result && typeof result.then === 'function') {
      try { result = await result; }
      catch (err) { this.runtime.reportError(err, { component: this, op: null, phase: 'diff' }); return DIFF.DEFER; }
    }
    if (ticket !== this._diffTicket) return DIFF.DEFER;
    return result === DIFF.DEFER ? DIFF.DEFER : DIFF.COMMIT;
  }

  // Swallow internals; forward user ops to behaviors + legacy effect()
  async _effect(op) {
    if (op.type === '@ride/init') {
      if (!this._initDone) {
        // Behavior init (can register lifetime cleanups)
        try {
          const ctx = this._makeCtx({ phase: 'init' });
          for (const b of this._behaviors) {
            if (!b?.init) continue;
            const r = b.init.call(this, ctx);
            const res = (r && typeof r.then === 'function') ? await r : r;
            if (typeof res === 'function') this._lifetimeCleanups.push(res);
          }
        } catch (err) {
          this.runtime.reportError(err, { component: this, op, phase: 'init' });
        }

        // Legacy user init
        try {
          const maybe = this.init();
          const res = (maybe && typeof maybe.then === 'function') ? await maybe : maybe;
          if (typeof res === 'function') this._initCleanup = res;
        } catch (err) {
          this.runtime.reportError(err, { component: this, op, phase: 'init' });
        }

        this._initDone = true;
      }
      return; // swallowed
    }

    // Per-key cleanup: run old cleanup for this key before applying new effect
    const key = op.key;
    const prevCleanup = key != null ? this._cleanups.get(key) : null;
    if (prevCleanup) {
      try {
        const r = prevCleanup();
        if (r && typeof r.then === 'function') await r;
      }
      catch (err) { this.runtime.reportError(err, { component: this, op, phase: 'cleanup' }); }
      finally { this._cleanups.delete(key); }
    }

    const collected = [];
    const ctx = this._makeCtx({ phase: 'effect', op, collectCleanupsRef: collected });

    // Behaviors first (base → derived), with optional filters
    for (const b of this._behaviors) {
      const matchesType = !b?.types || (Array.isArray(b.types) && b.types.includes(op.type));
      const matches = typeof b?.matches === 'function' ? !!b.matches(op) : true;
      if (!b?.effect || !matchesType || !matches) continue;
      try {
        let r = b.effect.call(this, op, ctx);
        if (r && typeof r.then === 'function') r = await r;
        if (typeof r === 'function') collected.push(r);
      } catch (err) {
        this.runtime.reportError(err, { component: this, op, phase: 'effect' });
      }
    }

    // Legacy effect last
    if (typeof this.effect === 'function') {
      try {
        let r = this.effect(op);
        if (r && typeof r.then === 'function') r = await r;
        if (typeof r === 'function') collected.push(r);
      } catch (err) {
        this.runtime.reportError(err, { component: this, op, phase: 'effect' });
      }
    }

    // Combine multiple cleanups into one (reverse order) and ensure we await thenables
    if (collected.length && key != null) {
      const combined = async () => {
        for (let i = collected.length - 1; i >= 0; i--) {
          try {
            const res = collected[i]();
            if (res && typeof res.then === 'function') await res;
          } catch (err) {
            this.runtime.reportError(err, { component: this, op, phase: 'cleanup' });
          }
        }
      };
      this._cleanups.set(key, combined);
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
    if (result !== DIFF.DEFER) this._commit(next);
    if (this.runtime.isReady && this._cmds.size) this.runtime.scheduler.markDirty(this);
  }

  async _processUpdatePreReady(prev, next) {
    // IMPORTANT: during pre-ready we do *not* run behavior diffs (skip spurious effects)
    await this._runDiffPreReady(prev, next);   // queue ops; do not commit
    this._preReadyDiffRan = true;
    // No scheduling while not ready — first RAF will be scheduled when the host becomes ready.
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

  setPriority(priority) {
    this._componentPriority = priority | 0;
  }

  async destroy() {
    this._destroyed = true;

    // Stop any queued ops from running post-destroy
    this._cmds.ops.length = 0;
    this._cmds.index.clear();
    this._cmds.size = 0;

    // Destroy children first
    for (const child of this._children) await child.destroy();
    this._children.clear();

    // Run all per-key cleanups
    for (const [, fn] of this._cleanups) {
      try {
        const r = fn();
        if (r && typeof r.then === 'function') await r;
      } catch (err) {
        this.runtime.reportError(err, { component: this, op: null, phase: 'cleanup' });
      }
    }
    this._cleanups.clear();

    // Run behavior lifetime cleanups (reverse)
    for (let i = this._lifetimeCleanups.length - 1; i >= 0; i--) {
      try {
        const r = this._lifetimeCleanups[i]();
        if (r && typeof r.then === 'function') await r;
      } catch (err) {
        this.runtime.reportError(err, { component: this, op: null, phase: 'cleanup' });
      }
    }
    this._lifetimeCleanups.length = 0;

    // Run legacy init-scope cleanup last
    if (typeof this._initCleanup === 'function') {
      try {
        const r = this._initCleanup();
        if (r && typeof r.then === 'function') await r;
      } catch (err) {
        this.runtime.reportError(err, { component: this, op: null, phase: 'cleanup' });
      }
      this._initCleanup = null;
    }

    // Detach/destroy node
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
    if (this.runtime.isReady) this.runtime.scheduler.markDirty(this);
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
    runtime.app = app; // so we can surface errors to App.onError

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
      runtime.reportError(err, { component: app, op: null, phase: 'host-init' });
    }
  }

  static async unmount(app) {
    await app.destroy();
    app.runtime.host?.teardown?.();
  }

  // Deterministic flushing for tests/tools
  static async flushUntilIdle(app, opts) {
    await app.runtime.scheduler.whenIdle(opts);
  }
}
