// Tiny, generic comparator.
//
// same(a, b, spec?)
// - spec omitted or "strict" → a === b
// - spec is a function       → spec(a, b) boolean
// - spec is a helper (same.shallow, same.byKeys, same.tuple, same.map, same.with)
//
// Helpers:
//   same.shallow()              -> shallow equality for arrays OR plain objects
//   same.byKeys(['x','y'])      -> shallowEqualBy specific keys
//   same.tuple(n)               -> shallow array equality of fixed length n
//   same.map({ k: subSpec })    -> per-key spec for objects
//   same.with(normalize, spec)  -> normalize then compare
//

export function same(a, b, spec) {
  if (spec == null || spec === 'strict') return a === b;
  if (typeof spec === 'function') return !!spec(a, b);
  if (spec && typeof spec._cmp === 'function') return !!spec._cmp(a, b);
  if (typeof spec === 'object') return same.map(spec)._cmp(a, b);
  return a === b;
}

// plain-object check (no arrays)
const isPlainObject = (o) => o != null && typeof o === 'object' && !Array.isArray(o);

// Shallow equality for arrays OR plain objects
same.shallow = () => ({
  _cmp: (a, b) => {
    if (a === b) return true;

    // arrays
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // plain objects
    if (isPlainObject(a) && isPlainObject(b)) {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      for (let i = 0; i < ka.length; i++) {
        const k = ka[i];
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (a[k] !== b[k]) return false;
      }
      return true;
    }

    // different shapes → not shallow-equal
    return false;
  },
});

// Keep the old name working if you were using it

same.byKeys = (keys) => ({
  _cmp: (a = {}, b = {}) => {
    for (let i = 0; i < keys.length; i++) if (a[keys[i]] !== b[keys[i]]) return false;
    return true;
  },
});

same.tuple = (n) => ({
  _cmp: (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== n || b.length !== n) return false;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  },
});

same.map = (shape) => ({
  _cmp: (a = {}, b = {}) => {
    for (const k in shape) {
      if (!same(a[k], b[k], shape[k])) return false;
    }
    return true;
  },
});

same.with = (normalize, subSpec = 'strict') => (a, b) =>
  same(normalize(a), normalize(b), subSpec);

same.eq = (normalize) => ({
  _cmp: (a, b) => {
    const A = normalize ? normalize(a) : a;
    const B = normalize ? normalize(b) : b;
    return Object.is(A, B);
  },
});

// Tiny sugar for common int-coercion case
same.int = () => same.eq(v => (v | 0));
