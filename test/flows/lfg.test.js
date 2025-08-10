import { Ride, Component, DIFF } from '../../src/index.js';
import { MockHost, tick, delay, raf, createDeferred } from '../helpers';

describe('Ride', () => {
  let diffs = [];
  let effects = [];

  beforeEach(() => {
    diffs = [];
    effects = [];
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

    expect(app.props).toEqual({ initial: true });

    expect(diffs[0]).toEqual({
      prev: { initial: true },
      next: { initial: true, foo: 1 },
    });

    // 2 - second deferred update - should accumulate

    diffs = [];

    app.update({ bar: 2 });

    await raf();

    expect(app.props).toEqual({ initial: true });

    expect(diffs[0]).toEqual({
      prev: { initial: true },
      next: { initial: true, foo: 1, bar: 2 },
    });

    // 3 - finally commit

    diffs = [];

    app.update({ ready: true });

    await raf();

    expect(app.props).toEqual({ initial: true, foo: 1, bar: 2, ready: true });

    expect(diffs[0]).toEqual({
      prev: { initial: true },
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
        this.mount(B, {});
        this.mount(C, {});
        this.mount(D, {});
      }
    }

    class B extends Component {
      static progressive = { priority: 0 };

      async init() {
        this.queue('render', { who: 'B' });
      }

      async effect(op) {
        await delay(6);

        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    class C extends Component {
      static progressive = { priority: 10 };

      async init() {
        this.queue('render', { who: 'C' });
      }

      async effect(op) {
        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    class D extends Component {
      static progressive = { priority: 20 };

      async init() {
        this.queue('render', { who: 'D' });
      }

      async effect(op) {
        await delay(6);

        effects.push({ type: op.type, who: op.payload.who });
      }
    }

    const app = Ride.mount(App, {});

    await raf();

    // 1 - App init runs, children scheduled for the next RAF

    await raf();

    // 2 - B and C init run, they queue 'render' operations to the next RAF

    await raf();

    // 3 -  B runs (priority 0), the budget is exceeded, C is deferred

    await raf();

    expect(effects).toEqual([{ type: 'render', who: 'B' }]);

    // 4 - C, D runs

    await raf();

    expect(effects).toEqual([{ type: 'render', who: 'B' }, { type: 'render', who: 'C' }, { type: 'render', who: 'D' }]);
  });
});
