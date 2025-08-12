import { same } from './utils';

describe('same (core)', () => {
  it('defaults to strict === when spec is omitted or "strict"', () => {
    expect(same(1, 1)).toBe(true);
    expect(same(1, '1')).toBe(false);
    expect(same(NaN, NaN)).toBe(false);  // === semantics
    expect(same(-0, 0)).toBe(true);      // === treats -0 and 0 as equal
    expect(same(10, 10, 'strict')).toBe(true);
  });

  it('accepts a custom comparator function', () => {
    expect(same(2, 3, (a, b) => a < b)).toBe(true);
    expect(same(3, 2, (a, b) => a < b)).toBe(false);
  });
});

describe('same.shallow()', () => {
  it('compares arrays shallowly', () => {
    expect(same([1, 2], [1, 2], same.shallow())).toBe(true);
    expect(same([1, 2], [1, 3], same.shallow())).toBe(false);
    expect(same([1, 2], [1, 2, 3], same.shallow())).toBe(false);
  });

  it('compares plain objects shallowly', () => {
    expect(same({ a: 1, b: 2 }, { a: 1, b: 2 }, same.shallow())).toBe(true);
    expect(same({ a: 1, b: 2 }, { a: 1, b: 3 }, same.shallow())).toBe(false);
    expect(same({ a: 1, b: 2 }, { a: 1 }, same.shallow())).toBe(false);
    // different shapes don't compare shallowly
    expect(same({ a: 1 }, ['a', 1], same.shallow())).toBe(false);
  });
});

describe('same.byKeys(keys)', () => {
  it('does shallowEqualBy for selected keys only', () => {
    const prev = { x: 1, y: 2, extra: 9 };
    const next = { x: 1, y: 2, extra: 42 };
    expect(same(prev, next, same.byKeys(['x', 'y']))).toBe(true);
    expect(same(prev, next, same.byKeys(['x', 'extra']))).toBe(false);
  });
});

describe('same.tuple(n)', () => {
  it('compares fixed-length tuples', () => {
    expect(same([10, 20], [10, 20], same.tuple(2))).toBe(true);
    expect(same([10, 20], [10, 21], same.tuple(2))).toBe(false);
    expect(same([10, 20, 30], [10, 20], same.tuple(2))).toBe(false);
    expect(same([10, 20], 'not-array', same.tuple(2))).toBe(false);
  });
});

describe('same.map(shape)', () => {
  it('composes per-key specs (tuple, byKeys, int)', () => {
    const prev = {
      anchor: [0, 1],
      meta: { a: 1, b: 2, c: 3 },
      vx: 10.9,
    };
    const next = {
      anchor: [0, 1],
      meta: { a: 1, b: 2, c: 999 }, // ignored in byKeys
      vx: 10.1, // int-coerced equal
    };

    const spec = same.map({
      anchor: same.tuple(2),
      meta: same.byKeys(['a', 'b']),
      vx: same.int(),
    });

    expect(same(prev, next, spec)).toBe(true);

    const next2 = { ...next, anchor: [0, 2] };
    expect(same(prev, next2, spec)).toBe(false);
  });
});

describe('same.with(normalize, spec)', () => {
  it('normalizes both sides before comparing', () => {
    const normShadow = (s) => !s ? null : ({
      dx: (s.dx ?? 1) | 0,
      dy: (s.dy ?? 1) | 0,
      softness: (s.softness ?? 0) | 0,
      color: s.color ?? '#000000',
    });

    const prev = { shadow: { dx: 1.2, dy: 2.9, softness: 0,   color: '#fff' } }; // dx→1, dy→2, soft→0
    const next = { shadow: { dx: 1,   dy: 2.1, softness: 0.2, color: '#fff' } }; // dx→1, dy→2, soft→0

    const spec = same.map({
      shadow: same.with(normShadow, same.byKeys(['dx', 'dy', 'softness', 'color'])),
    });

    expect(same(prev, next, spec)).toBe(true);

    const next2 = { shadow: { dx: 1, dy: 2, softness: 0, color: '#000' } };
    expect(same(prev, next2, spec)).toBe(false);
  });
});

describe('same.eq(normalize) and same.int()', () => {
  it('uses Object.is semantics with normalize', () => {
    const id = same.eq(); // no normalize → Object.is
    expect(same(NaN, NaN, id)).toBe(true);     // Object.is treats NaN === NaN
    expect(same(-0, 0, id)).toBe(false);       // Object.is distinguishes -0 vs 0

    const lower = same.eq((s) => (s == null ? s : String(s).toLowerCase()));
    expect(same('HELLO', 'hello', lower)).toBe(true);
    expect(same('HELLO', 'world', lower)).toBe(false);
  });

  it('int() compares after |0 coercion', () => {
    expect(same(10.9, 10.1, same.int())).toBe(true);
    expect(same(10.9, 11.1, same.int())).toBe(false);
    expect(same(-1.2, -1.9, same.int())).toBe(true); // both → -1
  });
});
