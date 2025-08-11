import createREGL from 'regl';

class Host {
  constructor({ canvas }) {
    this.canvas = canvas;
    this.regl = null;
    this.rootNode = null;
    this.nodes = new Map();
    this._raf = 0;
    this._needs = false;
    this.drawSprite = null;
  }

  async init() {
    this.regl = createREGL({
      canvas: this.canvas,
      pixelRatio: window.devicePixelRatio,
      attributes: { alpha: true, antialias: true, premultipliedAlpha: true },
    });

    // root scene graph node
    this.rootNode = { id: 'root', kind: 'scene', children: [], props: {} };
    this.nodes.set('root', this.rootNode);

    const quad = [
      0, 0,  1, 0,  0, 1,
      0, 1,  1, 0,  1, 1,
    ];

    const vert = `
      precision mediump float;
      attribute vec2 position;      // 0..1
      uniform vec2 uTranslatePx;    // px (device)
      uniform vec2 uScalePx;        // px (device)
      uniform vec2 uViewport;       // px (device)
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
      scissor: {
        enable: this.regl.prop('scissorEnabled'),
        box: this.regl.prop('scissorBox'),
      },
    });
  }

  // Node mgmt
  createNode(_component, kind = 'scene') {
    const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 7)}`;
    const node = { id, kind, parent: undefined, children: [], props: {}, texture: null, texSize: null };
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

  // Mutations
  setProps(node, patch) { Object.assign(node.props, patch); }

  // Rendering
  requestRender() {
    if (this._needs) return;
    this._needs = true;
    console.log('[host] requestRender');
    this._raf = requestAnimationFrame(() => {
      this._needs = false;
      this.frame();
    });
  }

  frame() {
    const canvasW = Math.max(1, this.canvas.width);
    const canvasH = Math.max(1, this.canvas.height);
    const cssW = Math.max(1, this.canvas.clientWidth || canvasW);
    const cssH = Math.max(1, this.canvas.clientHeight || canvasH);
    const dprX = canvasW / cssW;
    const dprY = canvasH / cssH;

    const toDevice = (x, y, w, h) => [x * dprX, y * dprY, w * dprX, h * dprY];

    const offsetRect = (r, ox, oy) => [r[0] + ox, r[1] + oy, r[2], r[3]];

    const intersect = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      const x = Math.max(a[0], b[0]);
      const y = Math.max(a[1], b[1]);
      const r = Math.min(a[0] + a[2], b[0] + b[2]);
      const btm = Math.min(a[1] + a[3], b[1] + b[3]);
      const w = Math.max(0, r - x);
      const h = Math.max(0, btm - y);
      return w > 0 && h > 0 ? [x, y, w, h] : null;
    };

    const visit = (node, absX, absY, parentAlpha, parentScissorCss) => {
      const p = node.props || {};
      const x = (p.x || 0) + absX;
      const y = (p.y || 0) + absY;
      const a = (p.alpha == null ? 1 : p.alpha) * parentAlpha;

      // Local scissor is in the node's local CSS space; offset to absolute CSS space
      const localScissorCss = p.scissor ? offsetRect(p.scissor, x, y) : null;
      // Intersect with ancestor scissor in CSS space
      const mergedScissorCss = intersect(parentScissorCss, localScissorCss);

      if (node.kind === 'sprite' && node.texture) {
        const wCss = p.width != null ? p.width : (node.texSize ? node.texSize[0] / dprX : 0);
        const hCss = p.height != null ? p.height : (node.texSize ? node.texSize[1] / dprY : 0);

        // Convert position/size to device px
        const [tx, ty, tw, th] = toDevice(x, y, wCss, hCss);

        let scissorEnabled = false;
        let scissorBox = { x: 0, y: 0, width: 0, height: 0 };
        if (mergedScissorCss) {
          let [sx, sy, sw, sh] = toDevice(...mergedScissorCss);
          // GL scissor is bottom-left origin
          sx = Math.round(sx);
          sy = Math.round(canvasH - (sy + sh));
          sw = Math.max(0, Math.round(sw));
          sh = Math.max(0, Math.round(sh));
          if (sw > 0 && sh > 0) {
            scissorEnabled = true;
            scissorBox = { x: sx, y: sy, width: sw, height: sh };
          }
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

      for (const child of node.children) {
        visit(child, x, y, a, mergedScissorCss);
      }
    };

    this.regl.poll();
    this.regl.clear({ color: [0.07, 0.08, 0.1, 1], depth: 1 });
    visit(this.rootNode, 0, 0, 1, null);
  }
   setTexture(node, source) {
     if (node.texture) node.texture.destroy();
     node.texture = this.regl.texture(source);
     let w = 0, h = 0;
     if (source instanceof HTMLCanvasElement) { w = source.width; h = source.height; }
     else if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) { w = source.width; h = source.height; }
     else if (source instanceof HTMLImageElement) { w = source.naturalWidth || source.width; h = source.naturalHeight || source.height; }
     node.texSize = [w, h];
     console.log('[host] texture uploaded', node.texSize); // <- should appear now
   }
  teardown() {
    cancelAnimationFrame(this._raf);
    for (const n of this.nodes.values()) n.texture && n.texture.destroy && n.texture.destroy();
    this.nodes.clear();
    if (this.regl) this.regl.destroy();
  }
}

export default Host;
