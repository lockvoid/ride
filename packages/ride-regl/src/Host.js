// packages/ride-regl/Host.js
import createREGL from 'regl';

class Host {
  constructor({ canvas }) {
    this.canvas = canvas;
    this.regl = null;

    // scene graph
    this.rootNode = null;   // { id, kind, children, props, texture, texSize, _lastSource }
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
    // fontName -> {
    //   imageData: ImageBitmap[], atlasTex: regl.texture[], atlasW, atlasH, emSize, lineHeight, base,
    //   glyphs: Map(codepoint -> { x,y,w,h,xoff,yoff,xadv,page }),
    //   kern: Map(first -> Map(second -> amount))
    // }
    this.msdf = { fonts: new Map() };
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
      attributes: { alpha: true, antialias: false, premultipliedAlpha: true },
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

    // —— MSDF TEXT pipeline (WebGL1) ————————————————————————————————
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

    // NOTE: the extension pragma MUST be the very first line.
    const textFrag = `
#extension GL_OES_standard_derivatives : enable
precision mediump float;
uniform sampler2D uAtlas;
uniform vec4 uColor;
uniform float uSoft;
varying vec2 vUV;
float median3(vec3 v){ return max(min(v.r,v.g), min(max(v.r,v.g), v.b)); }
void main() {
  vec3 msdf = texture2D(uAtlas, vUV).rgb;
  float sd = median3(msdf) - 0.5;
  float w = fwidth(sd) + 0.0001 + uSoft*0.01;
  float a = smoothstep(-w, w, sd);
  gl_FragColor = vec4(uColor.rgb, uColor.a * a);
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
      // drop old GPU resources
      this.nodes.forEach(n => {
        if (n.texture) { try { n.texture.destroy(); } catch {} n.texture = null; }
        if (n._geom) {
          try { n._geom.pages?.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
          try { n._geom.pages?.forEach(pg => pg.aUV?.destroy?.()); } catch {}
          n._geom = null;
        }
      });
      // re-init pipeline
      this.init().then(() => {
        // re-upload MSDF atlas textures from saved imageData
        this.msdf.fonts.forEach((f) => {
          try { f.atlasTex?.forEach(tex => tex.destroy?.()); } catch {}
          f.atlasTex = f.imageData.map(img => this.regl.texture({ data: img, flipY: true }));
        });
        // re-upload sprite textures
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
    for (const n of this.nodes.values()) {
      if (n.texture && n.texture.destroy) n.texture.destroy();
      if (n._geom?.pages) {
        try { n._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
        try { n._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
      }
    }
    this.nodes.clear();
    // destroy font textures
    this.msdf.fonts.forEach(f => { try { f.atlasTex?.forEach(tex => tex.destroy?.()); } catch {} });
    if (this.regl) this.regl.destroy();
  }

  // ————————————————————————————————————————————————
  // Fonts (fontbm JSON .fnt + atlas pages)
  // ————————————————————————————————————————————————
  // Usage 1: await host.registerFont('Inter', { fontUrl: '/fonts/Inter-Regular.fnt' })
  // Usage 2 (legacy): host.registerFont('Inter', { imageData: ImageBitmap|ImageBitmap[], fontData: {...} })
  async registerFont(fontName, opts) {
    if (opts.fontUrl) {
      // Load JSON
      const fontUrl = opts.fontUrl.trim();
      const base = new URL(fontUrl, window.location.href);
      const fontData = await fetch(base).then(r => r.json());

      // Pages list (fontbm puts them in fontData.pages)
      let pageNames = [];
      if (Array.isArray(fontData.pages) && fontData.pages.length > 0) {
        pageNames = fontData.pages;
      } else if (Array.isArray(fontData.page) && fontData.page.length > 0) {
        pageNames = fontData.page; // rare alt
      } else {
        // best effort: derive Inter-Regular_0.png next to .fnt
        const stem = base.pathname.replace(/\.[^.]+$/, '');
        pageNames = [stem.split('/').pop() + '_0.png'];
      }

      // Fetch all pages as ImageBitmap[]
      const imageData = await Promise.all(pageNames.map(async (name) => {
        const url = new URL(name, base);
        const blob = await fetch(url).then(r => r.blob());
        return await createImageBitmap(blob);
      }));

      // Build textures
      const atlasTex = imageData.map(img => this.regl.texture({ data: img, flipY: true }));

      // Parse metrics (same as manual path)
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

    // Legacy/manual path (already have images + JSON)
    const fontData = opts.fontData;
    const imgs = Array.isArray(opts.imageData) ? opts.imageData : [opts.imageData];
    const atlasTex = imgs.map(img => this.regl.texture({ data: img, flipY: true }));

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
    const node = { id, kind, parent: undefined, children: [], props: {}, texture: null, texSize: null, _lastSource: null };
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
      shadow: null,         // { dx, dy, color, softnessPx }
      truncateWidth: Infinity,
      softnessPx: 0,
    };
    node._geom = null;
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
    if (node.texture && node.texture.destroy) node.texture.destroy();
    if (node._geom?.pages) {
      try { node._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
      try { node._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
    }
    this.nodes.delete(node.id);
  }

  setProps(node, patch) { Object.assign(node.props, patch); }
  setTextProps(node, patch) {
    Object.assign(node.text, patch);
    if ('text' in patch || 'fontName' in patch || 'fontSize' in patch || 'truncateWidth' in patch) {
      if (node._geom?.pages) {
        try { node._geom.pages.forEach(pg => pg.aPosPx?.destroy?.()); } catch {}
        try { node._geom.pages.forEach(pg => pg.aUV?.destroy?.()); } catch {}
      }
      node._geom = null;
    }
    this.requestRender();
  }
  setTexture(node, source) {
    if (!this.regl) return;
    if (node.texture) node.texture.destroy();
    node.texture = this.regl.texture(source);
    node._lastSource = source;

    let w = 0, h = 0;
    if (source instanceof HTMLCanvasElement) { w = source.width; h = source.height; }
    else if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) { w = source.width; h = source.height; }
    else if (source instanceof HTMLImageElement) { w = source.naturalWidth || source.width; h = source.naturalHeight || source.height; }
    node.texSize = [w, h];
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
      const y0css = basePx + g.yoff * scale; // top-left of glyph box from line top
      const wcss = g.w * scale, hcss = g.h * scale;

      const x0 = Math.round(x0css * dpr);
      const y0 = Math.round(y0css * dpr);
      const x1 = Math.round((x0css + wcss) * dpr);
      const y1 = Math.round((y0css + hcss) * dpr);

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
      pages,                         // array of { page, aPosPx, aUV, count }
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

      // IMPORTANT: Only containers (non-sprites) shift their origin by -anchor*size
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

      // Scissor (axis-aligned). When rotated, this is a best-effort box.
      let localScissorCss = null;
      if (p.scissor) {
        localScissorCss = offsetRect(p.scissor, originX, originY);
      }
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
        const dpr = dprX;

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

          const color = this._parseColor(t.color);
          const baseUniforms = {
            uTranslatePx: toDevice(pivotX, pivotY, 0, 0).slice(0,2),
            uTextSizePx: G.sizeDev,
            uAnchor: p.anchor || [0,0],
            uRotation: totalRotation,
            uSoft: t.softnessPx || 0,
            scissorEnabled, scissorBox,
          };

          // Draw per-page
          for (const pg of G.pages) {
            const uniformsCommon = {
              ...baseUniforms,
              uAtlas: font.atlasTex[pg.page] || font.atlasTex[0],
            };

            // shadow pass
            if (t.shadow) {
              const { dx=1, dy=1, color: sc='#000000', softnessPx=1 } = t.shadow;
              const [tx, ty] = toDevice(dx, dy, 0, 0);
              this.drawTextMSDF({
                ...uniformsCommon,
                aPosPx: pg.aPosPx,
                aUV: pg.aUV,
                count: pg.count,
                uTranslatePx: [ uniformsCommon.uTranslatePx[0] + tx, uniformsCommon.uTranslatePx[1] + ty ],
                uColor: this._parseColor(sc),
                uSoft: softnessPx,
              });
            }

            // main pass
            this.drawTextMSDF({
              ...uniformsCommon,
              aPosPx: pg.aPosPx,
              aUV: pg.aUV,
              count: pg.count,
              uColor: [color[0], color[1], color[2], color[3] * a], // parent alpha
            });
          }
        }
      }

      // Children use ORIGIN (top-left after container anchor shift)
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

    // CSS size first (no blink)
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

    if (redrawNow) this.frame(); // draw synchronously in the same frame
  }

  _installAutoResize() {
    const onRO = () => {
      this._applySize({ commit: true, redrawNow: true });
    };
    this._ro = new ResizeObserver(onRO);
    this._ro.observe(this._container);

    const onWindowResize = () => this._applySize({ commit: true, redrawNow: true });
    window.addEventListener('resize', onWindowResize);
    this._removeWinResize = () => window.removeEventListener('resize', onWindowResize);
  }
}

export default Host;
