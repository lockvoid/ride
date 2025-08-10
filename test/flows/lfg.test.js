import { Ride, Component, DIFF } from '../../src/index.js';
import { MockHost, tick, timeout, raf, createDeferred } from '../helpers';

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

  it('coalesces operations by key (last write wins)', async () => {
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
    expect(buffer.ops).toMatchObject([{ type: '@ride/init'}]);
    expect(effects.length).toBe(0);

    // 2

    await raf();

    buffer = app.getCommandBuffer();

    expect(buffer.length).toBe(2);
    expect(buffer.ops).toMatchObject([{ type: 'position'}, { type: 'velocity' }]);
    expect(effects.length).toBe(0);

    // 3

    await raf();

    expect(buffer.length).toBe(0);
    expect(buffer.ops).toStrictEqual([]);
    expect(effects.length).toBe(2);
    expect(effects).toMatchObject([{ type: 'position', payload: { x: 2, y: 2 } }, { type: 'velocity', payload: { v: 10 } } ]);
  });
/*

  it('progressive update budget throttles per frame', async () => {
    const order = [];
    class App extends Component {
      static progressive = { updateBudget: 2 }; // 2 effects per frame
      createNode(){ return {}; }
      async init(){
        for (let i=0;i<5;i++){
          this.queue('u', { i }, { key:`k|${i}` });
        }
      }
      effect(op){ order.push(op.payload.i); }
    }
    const app = Ride.mount(App, { host: new MockHost() });

    await raf();                       // frame 1
    expect(order.length).toBe(2);

    await raf();                       // frame 2
    expect(order.length).toBe(4);

    await raf();                       // frame 3
    expect(order).toEqual([0,1,2,3,4]);

    await Ride.unmount(app);
  });

  it('progressive create budget throttles child mounts', async () => {
    class Leaf extends Component { createNode(){ return {}; } }
    class App extends Component {
      static progressive = { createBudget: 3 }; // 1 create per frame
      createNode(){ return { children: [] }; }
      async init(){
        this.deferMount(Leaf, {}, { key:'leaf1' });
        this.deferMount(Leaf, {}, { key:'leaf2' });
        this.deferMount(Leaf, {}, { key:'leaf3' });
      }
    }
    const host = new MockHost();
    const app = Ride.mount(App, { host });

    await Promise.resolve();
    await raf();  expect(host.attached).toBe(1);
    await raf();  expect(host.attached).toBe(2);
    await raf();  expect(host.attached).toBe(3);

    await Ride.unmount(app);
  });

  it('requestRender is called after flush', async () => {
    class App extends Component {
      createNode(){ return {}; }
      diff(){ this.queue('noop', {}, { key:'noop' }); }
      effect(){}
    }
    const host = new MockHost();
    const app = Ride.mount(App, { host });
    const before = host.renderCalls;

    app.update({ any: 1 });
    await raf();

    expect(host.renderCalls).toBeGreaterThan(before);
    await Ride.unmount(app);
  }); */
});
