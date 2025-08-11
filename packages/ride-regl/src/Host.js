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

    // resize plumbing
    this._container = null;
    this._ro = null;
    this._lastCss = { w: 0, h: 0 };
    this._lastDev = { w: 0, h: 0, dpr: 1 };

    // context lost/restore
    this._ctxLost = false;
    this._onCtxLost = null;
    this._onCtxRestored = null;
  }

  // one-liner for Ride.createHost
  static async create({ container = document.body, width, height, dpr, autoResize = true } = {}) {
    const canvas = document.createElement('canvas');
    canvas.className = 'ride-regl-canvas';
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
    });

    // scene root
    this.rootNode = { id: 'root', kind: 'scene', children: [], props: {} };
    this.nodes.set('root', this.rootNode);

    // sprite pipeline
    const quad = [ 0,0, 1,0, 0,1,  0,1, 1,0, 1,1 ];
    const vert = `
      precision mediump float;
      attribute vec2 position;      // 0..1
      uniform vec2 uTranslatePx;    // device px
      uniform vec2 uScalePx;        // device px
      uniform vec2 uViewport;       // device px
      varying vec2 vUV;
      void main() {
        vec2 xy = position * uScalePx + uTranslatePx;
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
      vert,
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
        uViewport: viewport,
        uTex: this.regl.prop('uTex'),
        uAlpha: this.regl.prop('uAlpha'),
      },
      count: 6,
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
      this.nodes.forEach(n => { if (n.texture) { try { n.texture.destroy(); } catch {} n.texture = null; } });
      // re-init pipeline
      this.init().then(() => {
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
    for (const n of this.nodes.values()) n.texture && n.texture.destroy && n.texture.destroy();
    this.nodes.clear();
    if (this.regl) this.regl.destroy();
  }

  // scene graph
  createNode(_component, kind = 'scene') {
    const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const node = { id, kind, parent: undefined, children: [], props: {}, texture: null, texSize: null, _lastSource: null };
    this.nodes.set(id, node);
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
    if (node.texture) node.texture.destroy();
    this.nodes.delete(node.id);
  }

  setProps(node, patch) { Object.assign(node.props, patch); }
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

    const visit = (node, absX, absY, parentAlpha, parentScissorCss) => {
      const p = node.props || {};
      const x = (p.x || 0) + absX;
      const y = (p.y || 0) + absY;
      const a = (p.alpha == null ? 1 : p.alpha) * parentAlpha;

      const localScissorCss = p.scissor ? offsetRect(p.scissor, x, y) : null;
      const mergedScissorCss = intersect(parentScissorCss, localScissorCss);

      if (node.kind === 'sprite' && node.texture) {
        const wCss = p.width  != null ? p.width  : (node.texSize ? node.texSize[0] / dprX : 0);
        const hCss = p.height != null ? p.height : (node.texSize ? node.texSize[1] / dprY : 0);
        const [tx, ty, tw, th] = toDevice(x, y, wCss, hCss);

        let scissorEnabled = false;
        let scissorBox = { x: 0, y: 0, width: 0, height: 0 };
        if (mergedScissorCss) {
          let [sx, sy, sw, sh] = toDevice(...mergedScissorCss);
          sx = clamp(sx);
          sy = clamp(canvasH - (sy + sh)); // GL bottom-left
          sw = clamp(sw);
          sh = clamp(sh);
          if (sw > 0 && sh > 0) { scissorEnabled = true; scissorBox = { x: sx, y: sy, width: sw, height: sh }; }
        }

        this.drawSprite({
          uTranslatePx: [tx, ty],
          uScalePx: [tw, th],
          uTex: node.texture,
          uAlpha: a,
          scissorEnabled,
          scissorBox,
        });
      }

      for (const child of node.children) visit(child, x, y, a, mergedScissorCss);
    };

    this.regl.poll();
    this.regl.clear({ color: [0.07, 0.08, 0.1, 1], depth: 1 });
    visit(this.rootNode, 0, 0, 1, null);
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

    // handle DPR change (often also triggers RO, but this covers edge cases)
    const onWindowResize = () => this._applySize({ commit: true, redrawNow: true });
    window.addEventListener('resize', onWindowResize);

    // keep a reference so teardown can remove it
    this._removeWinResize = () => window.removeEventListener('resize', onWindowResize);
  }
}

export default Host;
