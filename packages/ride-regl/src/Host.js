// packages/ride-regl/Host.js
import createREGL from 'regl';

class Host {
  constructor({ canvas }) {
    this.canvas = canvas;
    this.regl = null;

    // scene graph
    this.rootNode = null;   // { id, kind, children, props, texture, texSize, _lastSource, _texEntry, _geom }
    this.nodes = new Map();

    // draw scheduling (used by Ride)
    this._raf = 0;
    this._needs = false;

    // draw commands
    this.drawSprite = null;
    this.drawTextMSDF = null;

    // resize plumbing
    this._container = null;
    this._ro = null;
    this._lastCss = { w: 0, h: 0 };
    this._lastDev = { w: 0, h: 0, dpr: 1 };

    // context lost/restore
    this._ctxLost = false;
    this._onCtxLost = null;
    this._onCtxRestored = null;

    // MSDF registry
    // fontName -> { imageData: ImageBitmap[], atlasTex: regl.texture[], atlasW, atlasH, emSize, lineHeight, base, glyphs(Map), kern(Map) }
    this.msdf = { fonts: new Map() };

    // — Texture cache —
    // byObj: identity cache (fast path)
    // byKey: URL/Blob/content-hash cache (cross-object dedupe)
    this._texCache = {
      byObj: new WeakMap(),  // source object -> entry
      byKey: new Map(),      // string key     -> entry
    };
  }

  // one-liner for Ride.createHost
  static async create({ className, container = document.body, width, height, dpr, autoResize = true } = {}) {
    const canvas = document.createElement('canvas');
    if (className) canvas.className = className;
    container.appendChild(canvas);

    const host = new Host({ canvas });
    await host.init();

    host._container = container;

    // initial size (commit immediately and draw now)
    host._applySize({
      cssW: Math.max(1, Math.floor(width ?? container.clientWidth ?? 1)),
      cssH: Math.max(1, Math.floor(height ?? container.clientHeight ?? 1)),
      dpr:  (dpr ?? window.devicePixelRatio ?? 1),
      commit: true,
      redrawNow: true,
    });

    if (autoResize) host._installAutoResize();

    return host;
  }

  async init() {
    this.regl = createREGL({
      canvas: this.canvas,
      attributes: { alpha: true, antialias: true, premultipliedAlpha: true },
      extensions: ['OES_standard_derivatives'], // WebGL1: for fwidth/dFdx/dFdy
    });

    // scene root
    this.rootNode = this.rootNode || { id: 'root', kind: 'scene', children: [], props: {} };
    this.nodes.set('root', this.rootNode);

    // —— SPRITE pipeline (rotation + anchor) ——————————————————————————
    const quad = [ 0,0, 1,0, 0,1,  0,1, 1,0, 1,1 ];
    const spriteVert = `
      precision mediump float;
      attribute vec2 position;      // 0..1
      uniform vec2 uTranslatePx;    // device px (position)
      uniform vec2 uScalePx;        // device px (size)
      uniform vec2 uAnchor;         // 0..1 (normalized anchor point)
      uniform float uRotation;      // radians
      uniform vec2 uViewport;       // device px
      varying vec2 vUV;
      void main() {
        vec2 anchoredPos = position - uAnchor;
        vec2 scaledPos = anchoredPos * uScalePx;
        float c = cos(uRotation), s = sin(uRotation);
        vec2 rotatedPos = vec2(
          scaledPos.x * c - scaledPos.y * s,
          scaledPos.x * s + scaledPos.y * c
        );
        vec2 xy = rotatedPos + uTranslatePx;
        vec2 clip = vec2(
          (xy.x / uViewport.x) * 2.0 - 1.0,
          1.0 - (xy.y / uViewport.y) * 2.0
        );
        vUV = position;
        gl_Position = vec4(clip, 0.0, 1.0);
      }
    `;

    const viewport = () => [this.canvas.width, this.canvas.height];

    this.drawSprite = this.regl({
      vert: spriteVert,
      frag: `
        precision mediump float;
        varying vec2 vUV;
        uniform sampler2D uTex;
        uniform float uAlpha;
        void main() {
          vec4 c = texture2D(uTex, vUV);
          gl_FragColor = vec4(c.rgb, c.a * uAlpha);
        }
      `,
      attributes: { position: quad },
      uniforms: {
        uTranslatePx: this.regl.prop('uTranslatePx'),
        uScalePx: this.regl.prop('uScalePx'),
        uAnchor: this.regl.prop('uAnchor'),
        uRotation: this.regl.prop('uRotation'),
        uViewport: viewport,
        uTex: this.regl.prop('uTex'),
        uAlpha: this.regl.prop('uAlpha'),
      },
      count: 6,
      depth: { enable: false },
      blend: { enable: true, func: { src: 'src alpha', dst: 'one minus src alpha' } },
      scissor: { enable: this.regl.prop('scissorEnabled'), box: this.regl.prop('scissorBox') },
    });

    // —— MSDF TEXT pipeline (improved AA) ————————————————————————————
    const textVert = `
      precision mediump float;
      attribute vec2 aPosPx;   // local vertex in DEVICE px (y down)
      attribute vec2 aUV;
      uniform vec2 uTranslatePx;
      uniform vec2 uTextSizePx;
      uniform vec2 uAnchor;    // 0..1 (apply around text block)
      uniform float uRotation; // radians
      uniform vec2 uViewport;
      varying vec2 vUV;
      void main() {
        vec2 p = aPosPx - uAnchor * uTextSizePx;
        float c = cos(uRotation), s = sin(uRotation);
        vec2 rp = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
        vec2 xy = rp + uTranslatePx;
        vec2 clip = vec2((xy.x/uViewport.x)*2.0-1.0, 1.0-(xy.y/uViewport.y)*2.0);
        vUV = aUV;
        gl_Position = vec4(clip, 0.0, 1.0);
      }
    `;

    const textFrag = `
#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uAtlas;
uniform vec4 uColor;
uniform float uSoft;      // extra blur factor (0 = sharp)
varying vec2 vUV;

float median3(vec3 v){ return max(min(v.r,v.g), min(max(v.r,v.g), v.b)); }

void main() {
  vec3 msdf = texture2D(uAtlas, vUV).rgb;

  float sd = median3(msdf) - 0.5;

  vec3 w3 = fwidth(msdf);
  float w = max(median3(w3), 1e-6);

  w *= (1.0 + max(uSoft, 0.0));

  float alpha = clamp(sd / w + 0.5, 0.0, 1.0);

  gl_FragColor = vec4(uColor.rgb, uColor.a * alpha);
}
    `;

    this.drawTextMSDF = this.regl({
      vert: textVert,
      frag: textFrag,
      attributes: {
        aPosPx: this.regl.prop('aPosPx'),
        aUV: this.regl.prop('aUV'),
      },
      uniforms: {
        uTranslatePx: this.regl.prop('uTranslatePx'),
        uTextSizePx: this.regl.prop('uTextSizePx'),
        uAnchor: this.regl.prop('uAnchor'),
        uRotation: this.regl.prop('uRotation'),
        uViewport: viewport,
        uAtlas: this.regl.prop('uAtlas'),
        uColor: this.regl.prop('uColor'),
        uSoft: this.regl.prop('uSoft'),
      },
      count: this.regl.prop('count'),
      depth: { enable: false },
      blend: { enable: true, func: { src: 'src alpha', dst: 'one minus src alpha' } },
      scissor: { enable: this.regl.prop('scissorEnabled'), box: this.regl.prop('scissorBox') },
    });

    // context lost / restore
    this._onCtxLost = (e) => { e.preventDefault(); this._ctxLost = true; cancelAnimationFrame(this._raf); };
    this._onCtxRestored = () => {
      this._ctxLost = false;
      try { this.regl && this.regl.destroy(); } catch {}
      this.regl = null;

      // drop old GPU resources (buffers)
      this.nodes.forEach(n => {
        if (n._geom) {
          try { n._geom.pages?.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
          try { n._geom.pages?.forEach(pg => pg.aUV?.destroy?.()); } catch {}
          n._geom = null;
        }
      });

      // clear texture cache (old GL handles are invalid anyway)
      this._texCache.byKey.clear();
      this._texCache.byObj = new WeakMap();

      // re-init pipeline
      this.init().then(async () => {
        // re-upload MSDF atlas textures from saved imageData (with filtering)
        this.msdf.fonts.forEach((f) => {
          try { f.atlasTex?.forEach(tex => tex.destroy?.()); } catch {}
          const makeTex = (img) => this.regl.texture({
            data: img, flipY: true,
            min: 'linear', mag: 'linear',
            wrapS: 'clamp', wrapT: 'clamp',
            mipmap: false,
          });
          f.atlasTex = f.imageData.map(makeTex);
        });

        // re-upload sprite textures lazily from _lastSource
        this.nodes.forEach(n => { if (n._lastSource) this.setTexture(n, n._lastSource); });

        // redraw immediately at current size
        this._applySize({ commit: true, redrawNow: true });
      });
    };
    this.canvas.addEventListener('webglcontextlost', this._onCtxLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onCtxRestored, false);
  }

  teardown() {
    cancelAnimationFrame(this._raf);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.canvas.removeEventListener('webglcontextlost', this._onCtxLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this._onCtxRestored, false);

    // release node resources
    for (const n of this.nodes.values()) {
      if (n._geom?.pages) {
        try { n._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
        try { n._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
      }
      if (n._texEntry) {
        try { this._releaseTextureEntry(n._texEntry); } catch {}
      } else if (n.texture) {
        try { n.texture.destroy?.(); } catch {}
      }
    }
    this.nodes.clear();

    // destroy font textures
    this.msdf.fonts.forEach(f => { try { f.atlasTex?.forEach(tex => tex.destroy?.()); } catch {} });
    this.msdf.fonts.clear();

    // clear texture cache
    this._texCache.byKey.forEach(e => { try { e.tex?.destroy?.(); } catch {} });
    this._texCache.byKey.clear();
    this._texCache.byObj = new WeakMap();

    if (this.regl) this.regl.destroy();
  }

  // ————————————————————————————————————————————————
  // Texture cache helpers
  // ————————————————————————————————————————————————
  _makeTex(source) {
    return this.regl.texture({
      data: source,
      flipY: true,
      min: 'linear', mag: 'linear',
      wrapS: 'clamp', wrapT: 'clamp',
      mipmap: false,
    });
  }

  _getDimensions(source) {
    if (source instanceof HTMLCanvasElement) return [source.width, source.height];
    if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return [source.width, source.height];
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return [source.width, source.height];
    if (source instanceof HTMLImageElement) return [source.naturalWidth || source.width, source.naturalHeight || source.height];
    if (source instanceof HTMLVideoElement) return [source.videoWidth || 0, source.videoHeight || 0];
    return [0, 0];
  }

  _keyFromUrlish(source) {
    try {
      if (source instanceof HTMLImageElement) {
        const url = source.currentSrc || source.src || '';
        if (url) {
          const [w, h] = this._getDimensions(source);
          return `url:${url}#${w}x${h}`;
        }
      }
      if (typeof File !== 'undefined' && source instanceof File) {
        return `file:${source.name}:${source.size}:${source.lastModified}`;
      }
      if (typeof Blob !== 'undefined' && source instanceof Blob && 'size' in source) {
        return `blob:${source.size}:${(source.type||'')}`;
      }
    } catch {}
    return null;
  }

  async _fingerprint64(source) {
    const W = 64, H = 64;
    try {
      const off = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(W, H)
        : (() => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; })();
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      const [sw, sh] = this._getDimensions(source);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(source, 0, 0, sw, sh, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H).data; // ~16 KB

      if (crypto?.subtle?.digest) {
        const buf = await crypto.subtle.digest('SHA-1', img);
        const bytes = new Uint8Array(buf);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return `sha1:${hex}`;
      } else {
        // fallback djb2
        let h = 5381;
        for (let i = 0; i < img.length; i++) h = ((h << 5) + h) ^ img[i];
        return `djb2:${(h>>>0).toString(16)}`;
      }
    } catch {
      return null; // tainted or drawImage failed
    }
  }

  async _acquireTextureFromSource(source, { contentHash = false } = {}) {
    // Tier 0: identity cache
    const hit = this._texCache.byObj.get(source);
    if (hit) { hit.refs++; return hit; }

    // Tier 1: URL/Blob-derived key
    let key = this._keyFromUrlish(source);

    // Tier 2: optional content fingerprint
    if (!key && contentHash) {
      const fp = await this._fingerprint64(source);
      if (fp) key = `fp:${fp}`;
    }

    if (key && this._texCache.byKey.has(key)) {
      const entry = this._texCache.byKey.get(key);
      entry.refs++;
      this._texCache.byObj.set(source, entry);
      console.log('CACHE FOUND')
      return entry;
    }

    const tex = this._makeTex(source);
    const [w, h] = this._getDimensions(source);
    const entry = { tex, key: key || null, refs: 1, width: w, height: h };

    this._texCache.byObj.set(source, entry);
    if (key) this._texCache.byKey.set(key, entry);

    return entry;
  }

  _releaseTextureEntry(entry) {
    if (!entry) return;
    entry.refs = Math.max(0, (entry.refs|0) - 1);
    if (entry.refs === 0) {
      try { entry.tex?.destroy?.(); } catch {}
      if (entry.key) this._texCache.byKey.delete(entry.key);
      // byObj entries fall out naturally when the source object GCs
    }
  }

  // ————————————————————————————————————————————————
  // Fonts (fontbm JSON .fnt + atlas pages)
  // ————————————————————————————————————————————————
  async registerFont(fontName, opts) {
    const makeTex = (img) => this.regl.texture({
      data: img, flipY: true,
      min: 'linear', mag: 'linear',
      wrapS: 'clamp', wrapT: 'clamp',
      mipmap: false,
    });

    if (opts.fontUrl) {
      const fontUrl = opts.fontUrl.trim();
      const base = new URL(fontUrl, window.location.href);
      const fontData = await fetch(base).then(r => r.json());

      let pageNames = [];
      if (Array.isArray(fontData.pages) && fontData.pages.length > 0) pageNames = fontData.pages;
      else if (Array.isArray(fontData.page) && fontData.page.length > 0) pageNames = fontData.page;
      else {
        const stem = base.pathname.replace(/\.[^.]+$/, '');
        pageNames = [stem.split('/').pop() + '_0.png'];
      }

      const imageData = await Promise.all(pageNames.map(async (name) => {
        const url = new URL(name, base);
        const blob = await fetch(url).then(r => r.blob());
        return await createImageBitmap(blob);
      }));

      const atlasTex = imageData.map(makeTex);

      const common = fontData.common || {};
      const info   = fontData.info || {};
      const atlasW = common.scaleW, atlasH = common.scaleH;
      const emSize = Math.abs(info.size) || 32;
      const lineHeight = common.lineHeight || emSize;
      const basePx = common.base || Math.round(lineHeight * 0.8);

      const glyphs = new Map();
      for (const ch of (fontData.chars || [])) {
        glyphs.set(ch.id, {
          x: ch.x, y: ch.y, w: ch.width, h: ch.height,
          xoff: ch.xoffset, yoff: ch.yoffset,
          xadv: ch.xadvance, page: ch.page || 0,
        });
      }

      const kern = new Map();
      for (const k of (fontData.kernings || [])) {
        if (!kern.has(k.first)) kern.set(k.first, new Map());
        kern.get(k.first).set(k.second, k.amount);
      }

      this.msdf.fonts.set(fontName, {
        imageData, atlasTex, atlasW, atlasH, emSize, lineHeight, base: basePx, glyphs, kern
      });
      return;
    }

    // Legacy/manual path
    const fontData = opts.fontData;
    const imgs = Array.isArray(opts.imageData) ? opts.imageData : [opts.imageData];
    const atlasTex = imgs.map(makeTex);

    const common = fontData.common || {};
    const info   = fontData.info || {};
    const atlasW = common.scaleW, atlasH = common.scaleH;
    const emSize = Math.abs(info.size) || 32;
    const lineHeight = common.lineHeight || emSize;
    const basePx = common.base || Math.round(lineHeight * 0.8);

    const glyphs = new Map();
    for (const ch of (fontData.chars || [])) {
      glyphs.set(ch.id, {
        x: ch.x, y: ch.y, w: ch.width, h: ch.height,
        xoff: ch.xoffset, yoff: ch.yoffset,
        xadv: ch.xadvance, page: ch.page || 0,
      });
    }

    const kern = new Map();
    for (const k of (fontData.kernings || [])) {
      if (!kern.has(k.first)) kern.set(k.first, new Map());
      kern.get(k.first).set(k.second, k.amount);
    }

    this.msdf.fonts.set(fontName, {
      imageData: imgs, atlasTex, atlasW, atlasH, emSize, lineHeight, base: basePx, glyphs, kern
    });
  }

  // ————————————————————————————————————————————————
  // scene graph
  // ————————————————————————————————————————————————
  createNode(_component, kind = 'scene') {
    const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const node = { id, kind, parent: undefined, children: [], props: {}, texture: null, texSize: null, _lastSource: null, _texEntry: null, _geom: null };
    this.nodes.set(id, node);
    return node;
  }
  createTextNode() {
    const node = this.createNode(null, 'text');
    node.text = {
      fontName: null,
      text: '',
      fontSize: 16,
      color: [1,1,1,1],     // can be '#rrggbb[aa]'
      shadow: null,         // { dx, dy, color, softness }
      truncateWidth: Infinity,
    };
    return node;
  }
  attachNode(parent, child) {
    const p = parent || this.rootNode;
    child.parent = p;
    if (!p.children.includes(child)) p.children.push(child);
  }
  detachNode(parent, child) {
    const p = parent || child.parent || this.rootNode;
    if (!p) return;
    p.children = p.children.filter(c => c !== child);
    child.parent = undefined;
  }
  destroyNode(node) {
    if (node._geom?.pages) {
      try { node._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
      try { node._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
    }
    if (node._texEntry) {
      this._releaseTextureEntry(node._texEntry);
      node._texEntry = null;
    } else if (node.texture) {
      try { node.texture.destroy?.(); } catch {}
    }
    this.nodes.delete(node.id);
  }

  setProps(node, patch) { Object.assign(node.props, patch); }
  setTextProps(node, patch) {
    Object.assign(node.text, patch);
    // rebuild geometry if content/metrics changed
    if ('text' in patch || 'fontName' in patch || 'fontSize' in patch || 'truncateWidth' in patch) {
      if (node._geom?.pages) {
        try { node._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
        try { node._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
      }
      node._geom = null;
    }
    this.requestRender();
  }

  // — Cached, async —
  // opts: { contentHash?: boolean }  // if true, dedupe across different objects by 64x64 fingerprint
  async setTexture(node, source, opts = {}) {
    if (!this.regl) return;
    // release previous
    if (node._texEntry) {
      this._releaseTextureEntry(node._texEntry);
      node._texEntry = null;
    } else if (node.texture) {
      try { node.texture.destroy?.(); } catch {}
    }

    node._lastSource = source;

    const entry = await this._acquireTextureFromSource(source, { contentHash: !!opts.contentHash });
    node._texEntry = entry;
    node.texture = entry.tex;
    node.texSize = [entry.width, entry.height];

    // no implicit render here; Sprite/Typography will requestRender via setProps
  }

  // drawing
  requestRender() {
    if (this._needs || this._ctxLost) return;
    this._needs = true;
    this._raf = requestAnimationFrame(() => {
      this._needs = false;
      this.frame();
    });
  }

  // helpers
  _parseColor(c) {
    if (Array.isArray(c)) return [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1];
    if (typeof c === 'string' && c[0] === '#') {
      const hex = c.slice(1);
      const norm = (v) => parseInt(v, 16) / 255;
      if (hex.length === 3)  return [norm(hex[0]+hex[0]), norm(hex[1]+hex[1]), norm(hex[2]+hex[2]), 1];
      if (hex.length === 6)  return [norm(hex.slice(0,2)), norm(hex.slice(2,4)), norm(hex.slice(4,6)), 1];
      if (hex.length === 8)  return [norm(hex.slice(0,2)), norm(hex.slice(2,4)), norm(hex.slice(4,6)), norm(hex.slice(6,8))];
    }
    if (typeof c === 'string' && c.startsWith('rgb')) {
      const m = c.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255,255,255,1];
      const [r,g,b,a=1] = m; return [r/255, g/255, b/255, a];
    }
    return [1,1,1,1];
  }

  _createTextGeometryBM(node, {
    fontName, text, fontSize = 16, maxWidthCss = Infinity, dpr = 1
  }) {
    const font = this.msdf.fonts.get(fontName);
    if (!font) return null;

    const scale = fontSize / font.emSize;
    const atlasW = font.atlasW, atlasH = font.atlasH;

    const codes = Array.from(text ?? "", ch => ch.codePointAt(0));
    const dot = 46; // '.'
    const ellipsis = font.glyphs.has(8230) ? [8230] : [dot, dot, dot];

    const advOf = (cp) => {
      const g = font.glyphs.get(cp); if (!g) return 0;
      return g.xadv * scale;
    };
    const kernOf = (a,b) => (font.kern.get(a)?.get(b) || 0) * scale;

    // measure & determine cutoff
    let pen = 0, last = null, cutoff = codes.length - 1;
    for (let i=0;i<codes.length;i++) {
      const c = codes[i];
      pen += (last != null ? kernOf(last, c) : 0) + advOf(c);
      if (pen <= maxWidthCss) cutoff = i;
      last = c;
    }

    let out = codes.slice();
    if (pen > maxWidthCss && codes.length) {
      // measure ellipsis
      let eW = 0, p = null;
      for (const ec of ellipsis) { eW += (p!=null? kernOf(p,ec):0) + advOf(ec); p = ec; }
      // shrink base to fit base + ellipsis
      let baseEnd = cutoff, baseW = 0, l=null;
      for (let i=0;i<=baseEnd;i++) { const cc=codes[i]; baseW += (l!=null? kernOf(l,cc):0) + advOf(cc); l=cc; }
      while (baseEnd>=0 && baseW + eW > maxWidthCss) {
        const cc = codes[baseEnd];
        const prev = codes[baseEnd-1];
        baseW -= advOf(cc) + (prev!=null? kernOf(prev,cc):0);
        baseEnd--;
      }
      out = codes.slice(0, Math.max(0, baseEnd+1)).concat(ellipsis);
    }

    // build quads, bucketed by page (positions in DEVICE px, y down)
    const pageBuckets = new Map(); // page -> { pos:number[], uv:number[] }
    let x = 0, prev = null;

    const basePx = font.base * scale; // distance from line top to baseline
    let maxRight = 0;
    const lineHcss = font.lineHeight * scale;

    const pushQuad = (page, x0,y0,x1,y1,u0,v0,u1,v1) => {
      if (!pageBuckets.has(page)) pageBuckets.set(page, { pos: [], uv: [] });
      const B = pageBuckets.get(page);
      B.pos.push(
        x0, y0,  x1, y0,  x0, y1,
        x0, y1,  x1, y0,  x1, y1
      );
      B.uv.push(
        u0, v0,  u1, v0,  u0, v1,
        u0, v1,  u1, v0,  u1, v1
      );
    };

    for (const c of out) {
      const g = font.glyphs.get(c);
      if (!g) { prev = c; continue; }

      x += (prev != null ? kernOf(prev, c) : 0);

      const x0css = x + g.xoff * scale;
      const y0css = basePx + g.yoff * scale;
      const wcss = g.w * scale, hcss = g.h * scale;

      const x0 = x0css * dpr;
      const y0 = y0css * dpr;
      const x1 = (x0css + wcss) * dpr;
      const y1 = (y0css + hcss) * dpr;

      const u0 = (g.x) / atlasW, v0 = (g.y) / atlasH;
      const u1 = (g.x + g.w) / atlasW, v1 = (g.y + g.h) / atlasH;

      pushQuad(g.page || 0, x0, y0, x1, y1, u0, v0, u1, v1);

      x += g.xadv * scale;
      maxRight = Math.max(maxRight, x + (g.xoff + g.w) * scale);
      prev = c;
    }

    const textWcss = Math.max(x, maxRight);
    const textHcss = Math.max(lineHcss, font.lineHeight * scale);
    const textWdev = Math.max(1, Math.round(textWcss * dpr));
    const textHdev = Math.max(1, Math.round(textHcss * dpr));

    // Finalize buffers per page
    const pages = [];
    for (const [page, B] of pageBuckets) {
      const aPosPx = this.regl.buffer(new Float32Array(B.pos));
      const aUV    = this.regl.buffer(new Float32Array(B.uv));
      const count  = B.pos.length / 2;
      pages.push({ page, aPosPx, aUV, count });
    }

    return {
      pages,
      sizeCss: [textWcss, textHcss],
      sizeDev: [textWdev, textHdev],
      textOut: String.fromCodePoint(...out),
    };
  }

  frame() {
    if (!this.regl || this._ctxLost) return;

    const canvasW = Math.max(1, this.canvas.width);
    const canvasH = Math.max(1, this.canvas.height);
    const cssW = Math.max(1, this._lastCss.w || this.canvas.clientWidth || canvasW);
    const cssH = Math.max(1, this._lastCss.h || this.canvas.clientHeight || canvasH);
    const dprX = canvasW / cssW;
    const dprY = canvasH / cssH;

    const toDevice = (x, y, w, h) => [x * dprX, y * dprY, w * dprX, h * dprY];
    const offsetRect = (r, ox, oy) => [r[0] + ox, r[1] + oy, r[2], r[3]];
    const intersect = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      const x = Math.max(a[0], b[0]);
      const y = Math.max(a[1], b[1]);
      const R = Math.min(a[0] + a[2], b[0] + b[2]);
      const B = Math.min(a[1] + a[3], b[1] + b[3]);
      const w = Math.max(0, R - x);
      const h = Math.max(0, B - y);
      return (w > 0 && h > 0) ? [x, y, w, h] : null;
    };
    const clamp = (v) => Math.max(0, Math.round(v));

    // Helper to convert degrees to radians if needed
    const toRadians = (angle, unit = 'radians') => {
      if (unit === 'degrees' || unit === 'deg') return angle * Math.PI / 180;
      return angle;
    };

    const visit = (node, absX, absY, parentAlpha, parentScissorCss, parentRotation = 0) => {
      const p = node.props || {};
      const [anchorX, anchorY] = p.anchor || [0, 0];

      // rotation: support deg or rad
      const localRotation = p.rotation ?? 0;
      const rotationUnit = p.rotationUnit ?? 'radians';
      const rotation = toRadians(localRotation, rotationUnit);

      // total rotation down the tree
      const totalRotation = parentRotation + rotation;

      // local translation (apply parent's rotation to our x,y)
      let lx = p.x || 0, ly = p.y || 0;
      if (parentRotation !== 0) {
        const c = Math.cos(parentRotation), s = Math.sin(parentRotation);
        const rx = lx * c - ly * s;
        const ry = lx * s + ly * c;
        lx = rx; ly = ry;
      }

      // PIVOT = where this node's anchor should land in world space
      const pivotX = absX + lx;
      const pivotY = absY + ly;

      // ORIGIN = top-left for children (container-only). For sprites we keep pivot and let shader anchor.
      let originX = pivotX, originY = pivotY;

      if (node.kind !== 'sprite') {
        const wCss = p.width  ?? 0;
        const hCss = p.height ?? 0;
        let offX = -anchorX * wCss;
        let offY = -anchorY * hCss;
        if (totalRotation !== 0) {
          const c = Math.cos(totalRotation), s = Math.sin(totalRotation);
          const rx = offX * c - offY * s;
          const ry = offX * s + offY * c;
          offX = rx; offY = ry;
        }
        originX = pivotX + offX;
        originY = pivotY + offY;
      }

      const a = (p.alpha == null ? 1 : p.alpha) * parentAlpha;

      // Scissor
      let localScissorCss = null;
      if (p.scissor) localScissorCss = offsetRect(p.scissor, originX, originY);
      const mergedScissorCss = intersect(parentScissorCss, localScissorCss);

      // SPRITE draw
      if (node.kind === 'sprite' && node.texture) {
        const wCss = p.width  != null ? p.width  : (node.texSize ? node.texSize[0] / dprX : 0);
        const hCss = p.height != null ? p.height : (node.texSize ? node.texSize[1] / dprY : 0);
        const [tx, ty, tw, th] = toDevice(pivotX, pivotY, wCss, hCss);

        let scissorEnabled = false, scissorBox = { x: 0, y: 0, width: 0, height: 0 };
        if (mergedScissorCss) {
          let [sx, sy, sw, sh] = toDevice(...mergedScissorCss);
          sx = clamp(sx);
          sy = clamp(canvasH - (sy + sh));
          sw = clamp(sw);
          sh = clamp(sh);
          if (sw > 0 && sh > 0) scissorEnabled = true, scissorBox = { x: sx, y: sy, width: sw, height: sh };
        }

        this.drawSprite({
          uTranslatePx: [tx, ty],
          uScalePx: [tw, th],
          uAnchor: [anchorX, anchorY],
          uRotation: totalRotation,
          uTex: node.texture,
          uAlpha: a,
          scissorEnabled,
          scissorBox,
        });
      }

      // TEXT draw (MSDF)
      if (node.kind === 'text') {
        const t = node.text;
        const dpr = canvasW / (this._lastCss.w || this.canvas.clientWidth || canvasW);

        if (!node._geom) {
          node._geom = this._createTextGeometryBM(node, {
            fontName: t.fontName,
            text: t.text,
            fontSize: t.fontSize ?? 16,
            maxWidthCss: Number.isFinite(t.truncateWidth) ? t.truncateWidth : Infinity,
            dpr
          });
        }
        const G = node._geom;
        const font = t.fontName ? this.msdf.fonts.get(t.fontName) : null;
        if (G && font) {
          let scissorEnabled = false, scissorBox = { x:0,y:0,width:0,height:0 };
          if (mergedScissorCss) {
            let [sx, sy, sw, sh] = toDevice(...mergedScissorCss);
            sx = clamp(sx); sy = clamp(canvasH - (sy + sh)); sw = clamp(sw); sh = clamp(sh);
            if (sw>0 && sh>0) scissorEnabled = true, scissorBox = { x:sx, y:sy, width:sw, height:sh };
          }

          const mainColor = this._parseColor(t.color);
          const baseUniforms = {
            uTranslatePx: toDevice(pivotX, pivotY, 0, 0).slice(0,2),
            uTextSizePx: G.sizeDev,
            uAnchor: p.anchor || [0,0],
            uRotation: totalRotation,
            scissorEnabled, scissorBox,
          };

          // Draw per-page
          for (const pg of G.pages) {
            const uniformsCommon = {
              ...baseUniforms,
              aPosPx: pg.aPosPx,
              aUV: pg.aUV,
              count: pg.count,
              uAtlas: font.atlasTex[pg.page] || font.atlasTex[0],
            };

            // shadow
            if (t.shadow) {
              const dx = t.shadow.dx ?? 1;
              const dy = t.shadow.dy ?? 1;
              const soft = Math.max(0, t.shadow.softness ?? 0);
              const shadowColor = this._parseColor(t.shadow.color ?? '#000000');
              const [tx, ty] = toDevice(dx, dy, 0, 0);

              this.drawTextMSDF({
                ...uniformsCommon,
                uTranslatePx: [ uniformsCommon.uTranslatePx[0] + tx, uniformsCommon.uTranslatePx[1] + ty ],
                uColor: shadowColor,
                uSoft: soft,
              });
            }

            // main (sharp)
            this.drawTextMSDF({
              ...uniformsCommon,
              uColor: [mainColor[0], mainColor[1], mainColor[2], mainColor[3] * a],
              uSoft: 0.0,
            });
          }
        }
      }

      // Children
      for (const child of node.children) {
        visit(child, originX, originY, a, mergedScissorCss, totalRotation);
      }
    };

    this.regl.poll();
    this.regl.clear({ color: [0.07, 0.08, 0.1, 1], depth: 1 });
    visit(this.rootNode, 0, 0, 1, null, 0);
  }

  // simple, immediate resize: update CSS + backing store, then redraw NOW
  _applySize({ cssW, cssH, dpr, commit = true, redrawNow = true } = {}) {
    const container = this._container || this.canvas.parentElement || document.body;
    const wCss = Math.max(1, cssW ?? container.clientWidth ?? 1);
    const hCss = Math.max(1, cssH ?? container.clientHeight ?? 1);
    const DPR  = Math.max(1, dpr ?? window.devicePixelRatio ?? 1);
    const wDev = Math.max(1, Math.floor(wCss * DPR));
    const hDev = Math.max(1, Math.floor(hCss * DPR));

    if (this._lastCss.w !== wCss || this._lastCss.h !== hCss) {
      this.canvas.style.width = wCss + 'px';
      this.canvas.style.height = hCss + 'px';
      this._lastCss = { w: wCss, h: hCss };
    }

    if (commit && (this._lastDev.w !== wDev || this._lastDev.h !== hDev || this._lastDev.dpr !== DPR)) {
      this.canvas.width  = wDev;
      this.canvas.height = hDev;
      this._lastDev = { w: wDev, h: hDev, dpr: DPR };
    }

    if (redrawNow) this.frame();
  }

  _installAutoResize() {
    const onRO = () => { this._applySize({ commit: true, redrawNow: true }); };
    this._ro = new ResizeObserver(onRO);
    this._ro.observe(this._container);

    const onWindowResize = () => this._applySize({ commit: true, redrawNow: true });
    window.addEventListener('resize', onWindowResize);
    this._removeWinResize = () => window.removeEventListener('resize', onWindowResize);
  }
}

export default Host;
