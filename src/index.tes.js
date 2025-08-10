import { describe, it, expect } from 'vitest';
import { Ride, Component, DIFF } from './index.js';
import { MockHost } from '../test/helpers/mockHost.js';
import { micro, raf } from '../test/helpers/async.js';

describe('Ride core', () => {
  it('gates flush until host is ready', async () => {
    let resolveHost;
    class App extends Component {
      static async createHost() {
        return new Promise(res => { resolveHost = () => res(new MockHost()); });
      }
      createNode(){ return {}; }
      diff(){ this.queue('x', { a: 1 }, { key: 'x' }); }
      effect(){ App._seen = (App._seen||0) + 1; }
    }

    const app = Ride.mount(App, {});
    app.update({ foo: 1 });

    await micro();              // still no host
    expect(App._seen || 0).toBe(0);

    resolveHost();              // host becomes ready
    await raf();                // allow first flush frame
    expect(App._seen).toBe(1);

    await Ride.unmount(app);
  });

  it('DIFF.DEFER stages props without committing baseline', async () => {
    class App extends Component {
      createNode(){ return {}; }
      diff(_prev, next){
        if (!next.ready) {
          this.queue('mode', { m: 'placeholder' }, { key: 'mode' });
          return DIFF.DEFER;
        }
        this.queue('mode', { m: 'ready' }, { key: 'mode' });
      }
      effect(){ /* noop */ }
    }

    const app = Ride.mount(App, { host: new MockHost() });

    app.update({ a: 1 });       // staged only
    await raf();
    expect(app.props.a).toBeUndefined();

    app.update({ ready: true });
    await raf();
    expect(app.props.ready).toBe(true);

    await Ride.unmount(app);
  });

  it('coalesces ops by key and applies squash (last write wins)', async () => {
    const seen = [];
    class App extends Component {
      createNode(){ return {}; }
      async init(){
        this.queue('pos', { x: 1 }, { key: 'pos', squash: (_a,b)=>b });
        this.queue('pos', { x: 2 }, { key: 'pos', squash: (_a,b)=>b });
      }
      effect(op){ if (op.type === 'pos') seen.push(op.payload.x); }
    }
    const app = Ride.mount(App, { host: new MockHost() });
    await raf();                // let init + flush happen
    expect(seen).toEqual([2]);
    await Ride.unmount(app);
  });

  it('progressive update budget throttles per frame', async () => {
    const order = [];
    class App extends Component {
      static progressive = { updateBudget: 2 }; // 2 ops per frame
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
      effect(){ /* noop */ }
    }
    const host = new MockHost();
    const app = Ride.mount(App, { host });
    const before = host.renderCalls;

    app.update({ any: 1 });
    await raf();

    expect(host.renderCalls).toBeGreaterThan(before);
    await Ride.unmount(app);
  });
});
