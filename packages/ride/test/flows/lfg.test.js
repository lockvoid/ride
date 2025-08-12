import { Ride, Component, DIFF } from '../../src/index.js';
import { MockHost, tick, delay, raf, createDeferred } from '../helpers';

describe('Ride', () => {
  let diffs;
  let effects;
  let calls;
  let log;

  beforeEach(() => {
    diffs = [];
    effects = [];
    calls = [];
    log = [];
  });

  it('diffs the initial props', async () => {
    const host = createDeferred();

    class App extends Component {
      static progressive = { budget: Number.MAX_SAFE_INTEGER };

      static async createHost() {
        return host;
      }

      diff(prev = {}, next = {}) {
        diffs.push({ prev, next });
      }
    }

    const app = Ride.mount(App, { action: 'foo' });

    await raf();

    expect(diffs).toEqual([{ prev: {}, next: { action: 'foo' } }]);
  });

  it('buffers operations before the host is ready', async () => {
    let buffer;

    const host = createDeferred();

    class App extends Component {
      static progressive = { budget: Number.MAX_SAFE_INTEGER };

      static async createHost() {
        return host;
      }

      diff(prev = {}, next = {}) {
        this.queue(next.action, { prev, next });
      }

      effect(op) {
        effects.push(op);
      }
    }

    const app = Ride.mount(App, { action: 'foo' });

    // 1

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init', priority: -1 }, { type: 'foo', priority: 0 }]);
    expect(effects.length).toBe(0);

    // 2

    app.update({ action: 'bar' });

    buffer = app.getCommandBuffer();

    expect(app.getCommandBuffer().length).toBe(3);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init', priority: -1 }, { type: 'foo', priority: 0 }, { type: 'bar', priority: 0 }]);
    expect(effects.length).toBe(0);

    // 3

    app.update({ action: 'qux' });

    buffer = app.getCommandBuffer();

    expect(app.getCommandBuffer().length).toBe(4);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init', priority: -1 }, { type: 'foo', priority: 0 }, { type: 'bar', priority: 0 }, { type: 'qux', priority: 0 }]);
    expect(effects.length).toBe(0);

    // 4

    await raf();

    buffer = app.getCommandBuffer();

    expect(app.getCommandBuffer().length).toBe(4);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init', priority: -1 }, { type: 'foo', priority: 0 }, { type: 'bar', priority: 0 }, { type: 'qux', priority: 0 }]);
    expect(effects.length).toBe(0);

    // 5

    host.resolve(new MockHost());

    await raf();

    expect(app.getCommandBuffer().length).toBe(4);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init', priority: -1 }, { type: 'foo', priority: 0 }, { type: 'bar', priority: 0 }, { type: 'qux', priority: 0 }]);
    expect(effects.length).toBe(0);

    await raf();

    expect(app.getCommandBuffer().length).toBe(0);
    expect(buffer.ops).toStrictEqual([]);
    expect(effects.length).toBe(3);
    expect(effects).toMatchObject([{ type: 'foo' }, { type: 'bar' }, { type: 'qux' }]);
  });

  it('defers effects', async () => {
    class App extends Component {
      static async createHost() {
        return new MockHost();
      }

      diff(prev, next) {
        if (!next.foo) {
          return;
        }

        if (next.foo < 3) {
          this.queue('bar', { value: 'deferred' });

          return DIFF.DEFER;
        } else {
          this.queue('foo', { iteration: next.foo });
        }
      }

      effect(op) {
        effects.push({ type: op.type, payload: op.payload });
      }
    }

    const app = Ride.mount(App, {});

    await raf();

    // 1 - should defer and queue 'bar'

    effects = [];

    app.update({ foo: 1 });

    await raf();

    expect(app.props.foo).toBe(undefined);
    expect(effects.length).toBe(1);
    expect(effects[0].type).toBe('bar');
    expect(effects[0].payload.value).toBe('deferred');

    // 2 - should defer and queue another 'bar' (coalesced)

    effects = [];

    app.update({ foo: 2 });

    await raf();

    expect(app.props.foo).toBe(undefined);
    expect(effects.length).toBe(1);
    expect(effects[0].type).toBe('bar');

    // 3 - should commit and queue 'foo'

    effects = [];

    app.update({ foo: 3 });

    await raf();

    expect(app.props.foo).toBe(3);
    expect(effects.length).toBe(1);
    expect(effects[0].type).toBe('foo');
    expect(effects[0].payload.iteration).toBe(3);
  });

  it('preserves prev props and accumulates next props when deferring', async () => {
    class App extends Component {
      static async createHost() {
        return new MockHost();
      }

      diff(prev, next) {
        diffs.push({ prev: {...prev}, next: {...next} });

        if (!next.ready) {
          return DIFF.DEFER;
        }
      }
    }

    const app = Ride.mount(App, { initial: true });

    await raf();

    diffs = []; // Reset after initial diff

    // 1 - first deferred update

    app.update({ foo: 1 });

    await raf();

    expect(app.props).toEqual({});

    expect(diffs[0]).toEqual({
      prev: {},
      next: { initial: true, foo: 1 },
    });

    // 2 - second deferred update - should accumulate

    diffs = [];

    app.update({ bar: 2 });

    await raf();

    expect(app.props).toEqual({});

    expect(diffs[0]).toEqual({
      prev: {},
      next: { initial: true, foo: 1, bar: 2 },
    });

    // 3 - finally commit

    diffs = [];

    app.update({ ready: true });

    await raf();

    expect(app.props).toEqual({ initial: true, foo: 1, bar: 2, ready: true });

    expect(diffs[0]).toEqual({
      prev: {},
      next: { initial: true, foo: 1, bar: 2, ready: true },
    });

    // 4 - one more update after commit to verify prev is now updated

    diffs = [];

    app.update({ final: true });

    await raf();

    expect(app.props).toEqual({ initial: true, foo: 1, bar: 2, ready: true, final: true });

    expect(diffs[0]).toEqual({
      prev: { initial: true, foo: 1, bar: 2, ready: true },
      next: { initial: true, foo: 1, bar: 2, ready: true, final: true },
    });
  });

  it('coalesces operations by a key (last write wins)', async () => {
    let buffer;

    class App extends Component {
      static async createHost() {
        return new MockHost();
      }

      async init() {
        this.queue('position', { x: 1, y: 1 });

        this.queue('position', { x: 2, y: 2 });

        this.queue('velocity', { v: 10 });

      // console.log(' app.getCommandBuffer();',  this.getCommandBuffer());
      }

      effect(op) {
        effects.push({ type: op.type, payload: op.payload });
      }
    }

    const app = Ride.mount(App, {});

    // 1

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(1);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init' }]);
    expect(effects.length).toBe(0);

    // 2

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: 'position' }, { type: 'velocity' }]);
    expect(effects.length).toBe(0);

    // 3

    await raf();

    expect(buffer.length).toBe(0);
    expect(buffer.ops).toStrictEqual([]);
    expect(effects.length).toBe(2);
    expect(effects).toMatchObject([{ type: 'position', payload: { x: 2, y: 2 } }, { type: 'velocity', payload: { v: 10 } } ]);
  });

  it('coalesces by operations an explicit key (last write wins)', async () => {
    let buffer;

    class App extends Component {
      static progressive = { budget: Number.MAX_SAFE_INTEGER };
      static async createHost() { return new MockHost(); }

      async init() {
        this.queue('position1', { x: 1, y: 1 }, { key: 'position' });
        this.queue('position2', { x: 2, y: 2 }, { key: 'position' });

        this.queue('velocity', { v: 10 }, { key: 'vel' });
      }

      effect(op) {
        effects.push({ type: op.type, payload: op.payload });
      }
    }

    const app = Ride.mount(App, {});

    // 1

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(1);
    expect(buffer.ops).toMatchObject([{ type: '@ride/init'}]);
    expect(effects.length).toBe(0);

    // 2

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: 'position2' }, { type: 'velocity' }]);
    expect(effects.length).toBe(0);

    // 3

    await raf();

    expect(buffer.length).toBe(0);
    expect(buffer.ops).toStrictEqual([]);
    expect(effects.length).toBe(2);
    expect(effects).toMatchObject([{ type: 'position2', payload: { x: 2, y: 2 } }, { type: 'velocity', payload: { v: 10 } } ]);
  });

  it('coalesces via coalesceBy and merges payloads via squashWith', async () => {
    let buffer;

    const coalesceById = (type, payload) => {
      return `patch:${payload.id}`;
    };

    const squashWithMerge = (prevPayload, nextPayload) => {
      const out = { ...prevPayload, ...nextPayload };

      if (typeof prevPayload.dx === 'number' && typeof nextPayload.dx === 'number') {
        out.dx = prevPayload.dx + nextPayload.dx;
      }

      if (typeof prevPayload.dy === 'number' && typeof nextPayload.dy === 'number') {
        out.dy = prevPayload.dy + nextPayload.dy;
      }
      return out;
    };

    class App extends Component {
      static progressive = { budget: Number.MAX_SAFE_INTEGER };

      static async createHost() {
        return new MockHost();
      }

      async init() {
        this.queue('patch', { id: 1, dx: 1, dy: 0 }, { coalesceBy: coalesceById, squashWith: squashWithMerge });
        this.queue('patch', { id: 1, dx: 2, dy: 3 }, { coalesceBy: coalesceById, squashWith: squashWithMerge });
        this.queue('patch', { id: 1, dx: 4, dy: 1 }, { coalesceBy: coalesceById, squashWith: squashWithMerge });
        this.queue('patch', { id: 2, dx: 5, dy: 5 }, { coalesceBy: coalesceById, squashWith: squashWithMerge });
      }

      effect(op) {
        effects.push({ type: op.type, payload: op.payload });
      }
    }

    const app = Ride.mount(App, {});

    await raf();

    // 1

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: 'patch', key: 'patch:1' }, { type: 'patch', key: 'patch:2' }]);
    expect(effects.length).toBe(0);

    // 2

    await raf();

    expect(effects).toMatchObject([{ type: 'patch', payload: { id: 1, dx: 7, dy: 4 } }, { type: 'patch', payload: { id: 2, dx: 5, dy: 5 } }]);
  });

  it('coalescing keeps original sequence but updates priority (ordering stays consistent)', async () => {
    let buffer;

    class App extends Component {
      static progressive = { budget: Number.MAX_SAFE_INTEGER };

      static async createHost() {
        return new MockHost();
      }

      async init() {
        // A effects first with lower prio than B
        this.queue('tick', { a: 1 }, { key: 'A', priority: 10 });

        // B effects after with higher prio than A
        this.queue('tick', { b: 1 }, { key: 'B', priority: 5 });

        // A effects with priority 0 -> coalesces, keeps original sequence but now sorts before B
        this.queue('tick', { a: 2 }, { key: 'A', priority: 0 });
      }

      effect(op) {
        effects.push({ type: op.type, payload: op.payload });
      }
    }

    const app = Ride.mount(App, {});

    await raf();

    // 1

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: 'tick', key: 'A' }, { type: 'tick', key: 'B' }]);
    expect(effects.length).toBe(0);

    // 2

    await raf();

    expect(effects).toMatchObject([{ type: 'tick', payload: { a: 2 } }, { type: 'tick', payload: { b: 1 } }]);
  });

  it('schedules higher-priority siblings before lower-priority ones, slicing by frame budget', async () => {
    class App extends Component {
      static progressive = { budget: 5 };

      static async createHost() {
        return new MockHost();
      }

      async init() {
        for (let i = 0; i < 3; i++) {
          this.mount(Item, { id: i });
        }
      }
    }

    class Item extends Component {
      static progressive = { priority: 0 };

      async init() {
        this.mount(ItemInfo, { id: this.props.id });
        this.mount(ItemPicture, { id: this.props.id });

        this.queue('render', { who: `Item ${this.props.id}` });
      }

      async effect(op) {
        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    class ItemPicture extends Component {
      static progressive = { priority: 10 };

      async init() {
        this.queue('render', { who: `ItemPicture ${this.props.id}` });
      }

      async effect(op) {
        await delay(6);

        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    class ItemInfo extends Component {
      static progressive = { priority: 5 };

      async init() {
        this.queue('render', { who: `ItemInfo ${this.props.id}` });
      }

      async effect(op) {
        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    const app = Ride.mount(App, {});

    await raf();

    // 1

    await raf();

    // 2

    await raf();

    // 3

    await raf();

    expect(effects).toEqual([
      { type: 'render', who: 'Item 0' },
      { type: 'render', who: 'Item 1' },
      { type: 'render', who: 'Item 2' },
    ]);

    // 4

    await raf();

    expect(effects).toEqual([
      { type: 'render', who: 'Item 0' },
      { type: 'render', who: 'Item 1' },
      { type: 'render', who: 'Item 2' },
      { type: 'render', who: 'ItemInfo 0' },
      { type: 'render', who: 'ItemInfo 1' },
      { type: 'render', who: 'ItemInfo 2' },
      { type: 'render', who: 'ItemPicture 0' },
    ]);

    // 5

    await raf();

    expect(effects).toEqual([
      { type: 'render', who: 'Item 0' },
      { type: 'render', who: 'Item 1' },
      { type: 'render', who: 'Item 2' },
      { type: 'render', who: 'ItemInfo 0' },
      { type: 'render', who: 'ItemInfo 1' },
      { type: 'render', who: 'ItemInfo 2' },
      { type: 'render', who: 'ItemPicture 0' },
      { type: 'render', who: 'ItemPicture 1' },
    ]);

    // 6

    await raf();

    expect(effects).toEqual([
      { type: 'render', who: 'Item 0' },
      { type: 'render', who: 'Item 1' },
      { type: 'render', who: 'Item 2' },
      { type: 'render', who: 'ItemInfo 0' },
      { type: 'render', who: 'ItemInfo 1' },
      { type: 'render', who: 'ItemInfo 2' },
      { type: 'render', who: 'ItemPicture 0' },
      { type: 'render', who: 'ItemPicture 1' },
      { type: 'render', who: 'ItemPicture 2' },
    ]);
  });

  it('has context', async () => {
    let child;

    class Parent extends Component {
      static async createHost() {
        return new MockHost();
      }

      async init() {
        child = this.mount(Child);
      }
    }

    class Child extends Component {
    }

    const parent = Ride.mount(Parent, {}, { foo: 'bar' });

    await raf();

    // 1

    await raf();

    expect(parent.context).toEqual({ foo: 'bar' });
    expect(child.context).toEqual({ foo: 'bar' });
  });


  it('runs cleanup before the next effect for the same key', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }

      async init() {
        // 1) queue first subscription
        this.queue('subscribe', { v: 1 }); // key = type = 'subscribe'
      }

      effect(op) {
        log.push(`effect:${op.payload.v}`);
        // return cleanup capturing this op's value
        return () => { log.push(`cleanup:${op.payload.v}`); };
      }
    }

    const app = Ride.mount(App, {});

    // Frame 1: only @ride/init in buffer
    await raf();

    // Frame 2: buffered ops visible, nothing ran yet
    await raf();

    // Frame 3: effect for v=1 runs
    await raf();
    expect(log).toEqual(['effect:1']);

    // Now schedule replacement of the same key
    app.queue('subscribe', { v: 2 });

    // Next buffer frame
    await raf();

    // Next effect frame: cleanup(old) → effect(new)
    await raf();
    expect(log).toEqual(['effect:1', 'cleanup:1', 'effect:2']);
  });

  it('coalescing before first run does not produce extra cleanups', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }

      async init() {
        this.queue('position', { x: 1, y: 1 });
        this.queue('position', { x: 2, y: 2 }); // coalesced with same key
      }

      effect(op) {
        log.push(`effect:${op.type}:${op.payload.x},${op.payload.y}`);
        return () => { log.push(`cleanup:${op.type}`); };
      }
    }

    Ride.mount(App, {});

    await raf(); // @ride/init only
    await raf(); // buffer has coalesced 'position'
    await raf(); // runs single effect

    expect(log).toEqual(['effect:position:2,2']); // only one effect
    // no cleanup yet (only runs on replace or unmount)
  });

  it('runs all per-key cleanups on unmount (plus init cleanup if provided)', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }

      async init() {
        // return component-scope cleanup as well
        return () => { log.push('init-cleanup'); };
      }

      async diff() {
        // queue two different keys
        this.queue('a', { i: 1 });
        this.queue('b', { i: 2 });
      }

      effect(op) {
        log.push(`effect:${op.type}`);
        return () => { log.push(`cleanup:${op.type}`); };
      }
    }

    const app = Ride.mount(App, {});

    await raf(); // @ride/init
    await raf(); // buffer has a,b
    await raf(); // effects for a,b

    // Now unmount (should run cleanup:a, cleanup:b, then init-cleanup)
    await Ride.unmount(app);

    // Order of a/b cleanups is not guaranteed; init-cleanup is last
    const withoutLast = log.slice(0, -1).sort();
    expect(withoutLast).toEqual(['cleanup:a', 'cleanup:b', 'effect:a', 'effect:b'].sort());
    expect(log.at(-1)).toBe('init-cleanup');
  });

  it('awaits async cleanup before running the next effect for the same key', async () => {
    const log = [];

    class App extends Component {
      static async createHost() { return new MockHost(); }
      async init() { this.queue('sub', { step: 1 }); }
      effect(op) {
        log.push(`effect:${op.payload.step}`);
        return async () => {
          log.push(`cleanup-start:${op.payload.step}`);
          await delay(10); // simulate async teardown inside cleanup
          log.push(`cleanup-done:${op.payload.step}`);
        };
      }
    }

    const app = Ride.mount(App, {});

    // First effect
    await raf(); // schedule @ride/init flush
    await Ride.flushUntilIdle(app);
    expect(log).toEqual(['effect:1']);

    // Replace same key -> must run cleanup(1) fully before effect(2)
    app.queue('sub', { step: 2 });

    await raf(); // schedule replacement flush
    await Ride.flushUntilIdle(app);

    expect(log).toEqual([
      'effect:1',
      'cleanup-start:1',
      'cleanup-done:1',
      'effect:2',
    ]);
  });

  it('does not run any cleanup pre-ready (effects haven’t run yet)', async () => {
    // We simulate by queuing multiple ops pre-ready; only last effect runs once,
    // and no cleanup occurs until a later replacement or unmount.
    class App extends Component {
      static async createHost() { return new MockHost(); }

      async init() {
        this.queue('keyX', { n: 1 });
        this.queue('keyX', { n: 2 }); // coalesced pre-ready
      }

      effect(op) {
        log.push(`effect:${op.payload.n}`);
        return () => { log.push(`cleanup:${op.payload.n}`); };
      }
    }

    const app = Ride.mount(App, {});

    await raf(); // @ride/init
    await raf(); // buffer has single keyX(n=2)
    await raf(); // effect(2) runs

    expect(log).toEqual(['effect:2']); // no cleanup yet

    // Unmount triggers one cleanup (for n=2)
    await Ride.unmount(app);
    expect(log).toEqual(['effect:2', 'cleanup:2']);
  });

  it('cleanup lifecycle: replace and unmount', async () => {
    const calls = [];

    class App extends Component {
      static async createHost() { return new MockHost(); }
      async init() { this.queue('subscribe', { id: 'A' }); }
      effect(op) {
        calls.push(`effect:${op.payload.id}`);
        return () => { calls.push(`cleanup:${op.payload.id}`); };
      }
    }

    const app = Ride.mount(App, {});
    await raf(); // @ride/init
    await raf(); // buffer
    await raf(); // effect A

    app.queue('subscribe', { id: 'B' });
    await raf(); // buffer
    await raf(); // cleanup A → effect B

    await Ride.unmount(app); // cleanup B

    expect(calls).toEqual([
      'effect:A',
      'cleanup:A',
      'effect:B',
      'cleanup:B',
    ]);
  });

  it('keeps cleanup+next-effect atomic for the same key even if budget is tiny', async () => {
      const calls = [];

      class App extends Component {
        static progressive = { budget: 1 }; // very tight budget
        static async createHost() { return new MockHost(); }
        async init() { this.queue('sub', { step: 1 }); }
        effect(op) {
          calls.push(`effect:${op.payload.step}`);
          return async () => {
            calls.push(`cleanup-start:${op.payload.step}`);
            // Long cleanup that exceeds budget
            await delay(12);
            calls.push(`cleanup-done:${op.payload.step}`);
          };
        }
      }

      const app = Ride.mount(App, {});
      await raf();
      await Ride.flushUntilIdle(app);
      expect(calls).toEqual(['effect:1']);

      // Replacement
      app.queue('sub', { step: 2 });

      await raf();
      await Ride.flushUntilIdle(app);

      // Even with budget overrun, cleanup(1) completes before effect(2)
      expect(calls).toEqual([
        'effect:1',
        'cleanup-start:1',
        'cleanup-done:1',
        'effect:2',
      ]);
    });

  it('flushUntilIdle waits for in-flight async effect work', async () => {
    const seen = [];

    class App extends Component {
      static async createHost() { return new MockHost(); }
      async init() {
        // two different keys to ensure we drain multiple ops
        this.queue('a', { n: 1 });
        this.queue('b', { n: 2 });
      }
      async effect(op) {
        seen.push(`begin:${op.type}`);
        await delay(5);
        seen.push(`end:${op.type}`);
      }
    }

    const app = Ride.mount(App, {});
    await raf();
    await Ride.flushUntilIdle(app);

    expect(seen).toEqual([
      'begin:a', 'end:a',
      'begin:b', 'end:b',
    ]);
  });


  const recordOnError = (ctxTag = '') => (err, ctx) => {
    calls.push({
      tag: ctxTag,
      phase: ctx.phase,
      opType: ctx.op?.type ?? null,
      message: String(err && err.message || err),
    });
  };

  it('reports effect errors and continues processing later ops', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = recordOnError('effect');

      async init() {
        this.queue('boom', { a: 1 });
      }

      effect(op) {
        if (op.type === 'boom') throw new Error('effect fail');
        calls.push({ ran: op.type });
      }
    }

    const app = Ride.mount(App, {});

    await raf();
    await Ride.flushUntilIdle(app);

    // error was reported
    expect(calls.find(c => c.tag === 'effect' && c.phase === 'effect')?.message).toBe('effect fail');

    // schedule a non-throwing op; framework must keep running
    app.queue('ok', {});
    await raf();
    await Ride.flushUntilIdle(app);

    expect(calls.some(c => c.ran === 'ok')).toBe(true);
  });

  it('reports cleanup errors and still runs the next effect for the same key', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = recordOnError('cleanup');

      async init() { this.queue('task', { step: 1 }); }

      effect(op) {
        calls.push({ effect: op.payload.step });
        // cleanup throws
        return async () => { throw new Error('cleanup kaboom'); };
      }
    }

    const app = Ride.mount(App, {});
    await raf(); await Ride.flushUntilIdle(app);

    app.queue('task', { step: 2 }); // replacement => triggers cleanup
    await raf(); await Ride.flushUntilIdle(app);

    const err = calls.find(c => c.tag === 'cleanup' && c.phase === 'cleanup');
    expect(err?.message).toBe('cleanup kaboom');

    // and the replacement effect still ran
    expect(calls.some(c => c.effect === 2)).toBe(true);
  });

  it('reports diff errors but still processes ops queued before the throw', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = recordOnError('diff');

      diff() {
        this.queue('work', { x: 42 });
        throw new Error('diff blew up');
      }

      effect(op) { calls.push({ work: op.payload.x }); }
    }

    const app = Ride.mount(App, {});
    await raf();              // schedule first flush (@ride/init + post-diff queued ops)
    await Ride.flushUntilIdle(app);

    // diff error reported
    expect(calls.find(c => c.tag === 'diff' && c.phase === 'diff')?.message).toBe('diff blew up');

    // yet effect still ran for the queued op
    expect(calls.find(c => c.work === 42)).toBeTruthy();
  });

  it('reports init errors and continues', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = recordOnError('init');

      async init() { throw new Error('init fail'); }

      diff() { this.queue('after', {}); }
      effect(op) { calls.push({ ran: op.type }); }
    }

    const app = Ride.mount(App, {});
    await raf(); await Ride.flushUntilIdle(app);

    expect(calls.find(c => c.tag === 'init' && c.phase === 'init')?.message).toBe('init fail');
    // After-op should still execute
    expect(calls.some(c => c.ran === 'after')).toBe(true);
  });

  it('reports attach errors; a later markDirty retries and succeeds', async () => {
    // Host that fails first attach, then succeeds
    class FlakyHost {
      constructor() { this.rootNode = {}; this._first = true; }
      attachNode(_parent, _node) {
        if (this._first) { this._first = false; throw new Error('attach nope'); }
        // success on second attempt
      }
      detachNode() {}
      destroyNode() {}
      requestRender() {}
    }

    class App extends Component {
      static async createHost() { return new FlakyHost(); }
      static onError = recordOnError('attach');

      createNode() { return {}; } // ensure there is a node to attach
      async init() { this.queue('doit', {}); }
      effect(op) { calls.push({ ran: op.type }); }
    }

    const app = Ride.mount(App, {});

    await raf();              // first attempt -> attach throws and is reported
    await Ride.flushUntilIdle(app);

    const err = calls.find(c => c.tag === 'attach' && c.phase === 'attach');
    expect(err?.message).toBe('attach nope');

    // Re-mark dirty so scheduler retries attach
    app.queue('doit', { again: true });
    await raf(); await Ride.flushUntilIdle(app);

    expect(calls.some(c => c.ran === 'doit')).toBe(true);
  });

  it('reports host-init errors (createHost) via Ride._bootHost', async () => {
    const onError = vi.fn();

    class App extends Component {
      static async createHost() { throw new Error('host boot broken'); }
      static onError = onError;

      effect() { calls.push('ran'); }
    }

    Ride.mount(App, {});
    // give _bootHost a tick to run and report
    await delay(0);

    expect(onError).toHaveBeenCalled();
    const [err, ctx] = onError.mock.calls[0];
    expect(err.message).toBe('host boot broken');
    expect(ctx.phase).toBe('host-init');
  });

  it('reports cleanup errors thrown on unmount', async () => {
    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = recordOnError('unmount-cleanup');

      async init() { this.queue('x', {}); }
      effect() { return async () => { throw new Error('unmount boom'); }; }
    }

    const app = Ride.mount(App, {});
    await raf(); await Ride.flushUntilIdle(app);

    await Ride.unmount(app);

    const err = calls.find(c => c.tag === 'unmount-cleanup' && c.phase === 'cleanup');
    expect(err?.message).toBe('unmount boom');
  });

  it('prefers static onError over instance onError', async () => {
    const staticSpy = vi.fn();
    const instanceSpy = vi.fn();

    class App extends Component {
      static async createHost() { return new MockHost(); }
      static onError = staticSpy;
      onError = instanceSpy;

      async init() { this.queue('boom', {}); }
      effect() { throw new Error('whoops'); }
    }

    const app = Ride.mount(App, {});
    await raf(); await Ride.flushUntilIdle(app);

    expect(staticSpy).toHaveBeenCalledTimes(1);
    expect(instanceSpy).not.toHaveBeenCalled();
  });

  it('falls back to console.error if no onError handler is provided (no throw)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      class App extends Component {
        static async createHost() { return new MockHost(); }
        async init() { this.queue('boom', {}); }
        effect() { throw new Error('no handler'); }
      }

      const app = Ride.mount(App, {});
      await raf(); await Ride.flushUntilIdle(app);

      expect(spy).toHaveBeenCalled();
      const msg = spy.mock.calls[0][0];
      expect(String(msg)).toContain('[Ride] Unhandled error');
    } finally {
      spy.mockRestore();
    }
  });
});
