import { Ride, Component } from '@lockvoid/ride';
import { Host, Scene, Sprite } from '@lockvoid/ride-regl';

function fitCanvasTo(container, canvas) {
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const { clientWidth: w, clientHeight: h } = container;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
}

async function loadImageBitmap(url) {
  const res = await fetch(url, { mode: 'cors' });
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

class App extends Component {
  static progressive = { budget: 8 };

  static async createHost(props) {
    return Host.create({ container: props.container,  autoResize: { policy: 'live' } });
  }

  async init() {
    const scene = this.mount(Scene, { x: 0, y: 0, alpha: 1, scissor: [0, 0, 400, 400] });

    const bmp = await loadImageBitmap('/grid.png');
    console.log('[demo] imageBitmap', bmp.width, bmp.height); // should log real size

    // ⬇️ mount INTO the scene, not the app
    const spite = scene.mount(Sprite, {
      x: 0, y: 0, width: 400, height: 400, alpha: 1, source: bmp,
    });

    setInterval(() => {
      scene.update({ x: Math.random() * 100, y: Math.random() * 100 });
    }, 1000);
  }
}

export default App;

// bootstrap helper
export function startDemo({ container = document.body, imageUrl } = {}) {
  return Ride.mount(App, { container, imageUrl });
}
