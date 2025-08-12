import { Ride, Component } from '@lockvoid/ride';
import { Host, Scene, Sprite, Typography } from '@lockvoid/ride-regl';

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
    const host = await Host.create({ container: props.container, autoResize: { policy: 'live' } });

    await host.registerFont('Inter-Regular', { fontUrl: '/public/Inter-Regular.json' });

    return host;
  }

  async init() {
    const scene = this.mount(Scene, {
      x: 200,
      y: 200,
      alpha: 1,
    //  scissor: [0, 0, 200, 200],
      //rotation: 12,
      anchor: [0.5, 0.5],
      width: 400,
      height: 400
    });

    const scene2 = scene.mount(Scene, {
      x: 0,
      y: 0,
      alpha: 1,
    //  scissor: [0, 0, 200, 200],
      //rotation: 12,
      anchor: [0, 0],
      width: 400,
      height: 400
    });



    const bmp = await loadImageBitmap('/public/grid.png');
    console.log('[demo] imageBitmap', bmp.width, bmp.height); // should log real size

    // ⬇️ mount INTO the scene, not the app
    const sprite = scene2.mount(Sprite, {
      x: 1000, y: 100, width: 400, height: 400, alpha: 1, source: bmp,anchor: [0.5,0.5],
    });

    setInterval(() => {
      //scene.update({ x: Math.random() * 100, y: Math.random() * 100 });
    }, 1000);

    let rotation = 0;
    let i = 0;
    const rotate = () => {
      sprite.update({ rotation: rotation += 0.01 });

     //  requestAnimationFrame(rotate)
    };

   scene.mount(Typography, {
     fontName: 'Inter-Regular',
     text: 'Hello MSDF wdcnwjdncjwdncj !',
     fontSize: 16,
     x: 24, y: 48,
     color: '#ffffff',
     truncateWidth: 160,
   });


    rotate();
  }
}

export default App;

// bootstrap helper
export function startDemo({ container = document.body, imageUrl } = {}) {
  return Ride.mount(App, { container, imageUrl });
}
