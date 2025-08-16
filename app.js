/* Slow Sunset • Bit Art
   Goal: crisp pixel-art sunset with very slow motion and ordered dithering.
   No libraries. Works well on 5k displays by integer scaling from a smaller scene.
*/

(() => {
  // ----- Config
  const CYCLE_MIN = 45;       // full sunset progression length in minutes
  const FPS_CAP = 30;         // frame cap
  const BASE_W = 768;         // target scene width before scaling up
  const BASE_H = 432;         // target scene height before scaling up
  const MIN_SCALE = 3;        // pixels per scene pixel at small screens
  const MAX_SCALE = 16;       // safety cap for TV panels
  const DITHER_STRENGTH = 1;  // 1 is classic Bayer

  // Channel quantization levels for pixel look
  const LEVELS_R = 6, LEVELS_G = 7, LEVELS_B = 6;

  // ----- Canvas setup
  const canvas = document.getElementById("view");
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;

  // Offscreen scene buffer
  const scene = document.createElement("canvas");
  const sctx = scene.getContext("2d", { alpha: false });
  sctx.imageSmoothingEnabled = false;

  // ----- Bayer 8x8 matrix for ordered dithering
  const BAYER8 = [
    0,48,12,60,3,51,15,63,
    32,16,44,28,35,19,47,31,
    8,56,4,52,11,59,7,55,
    40,24,36,20,43,27,39,23,
    2,50,14,62,1,49,13,61,
    34,18,46,30,33,17,45,29,
    10,58,6,54,9,57,5,53,
    42,26,38,22,41,25,37,21
  ];

  // ----- Time
  const start = performance.now();
  let paused = false;
  let lastFrame = 0;

  // ----- Resize with integer scale for crisp pixels on any panel
  let scale = 6, viewW = 0, viewH = 0, sceneW = 0, sceneH = 0, offsetX = 0, offsetY = 0;
  function resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    viewW = Math.floor(window.innerWidth * dpr);
    viewH = Math.floor(window.innerHeight * dpr);
    canvas.width = viewW;
    canvas.height = viewH;

    // choose integer scale that fits and targets the base size
    const sFitW = Math.floor(viewW / BASE_W);
    const sFitH = Math.floor(viewH / BASE_H);
    scale = clamp(Math.min(sFitW, sFitH), MIN_SCALE, MAX_SCALE);

    // scene size implied by the chosen scale
    sceneW = Math.max(Math.floor(viewW / scale), 64);
    sceneH = Math.max(Math.floor(viewH / scale), 64);
    scene.width = sceneW;
    scene.height = sceneH;

    // letterbox centering in display pixels
    const drawW = sceneW * scale;
    const drawH = sceneH * scale;
    offsetX = Math.floor((viewW - drawW) / 2);
    offsetY = Math.floor((viewH - drawH) / 2);
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();

  // ----- Utility
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function mix(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Hash based value noise. Cheap and good for clouds and waves.
  function hash2(ix, iy) {
    // integer hash
    let x = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
    return x - Math.floor(x);
  }
  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const n00 = hash2(xi, yi);
    const n10 = hash2(xi + 1, yi);
    const n01 = hash2(xi, yi + 1);
    const n11 = hash2(xi + 1, yi + 1);
    return mix(mix(n00, n10, u), mix(n01, n11, u), v);
  }
  function fbm(x, y) {
    // two octave fractal noise
    const n1 = noise2(x, y);
    const n2 = noise2(x * 2.0, y * 2.0) * 0.5;
    return (n1 + n2 * 0.75) / 1.75;
  }

  // HSV to RGB for smooth gradients
  function hsv(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [r + m, g + m, b + m];
  }

  // Quantize one channel with Bayer threshold
  function quantChannel(v, levels, bx, by) {
    const t = ((BAYER8[(by & 7) * 8 + (bx & 7)] / 64) - 0.5) * (DITHER_STRENGTH / levels);
    const q = Math.floor(clamp(v + t, 0, 1) * (levels - 1) + 0.5);
    return q / (levels - 1);
  }

  // Pack float rgb to byte array
  function pack(px, i, r, g, b) {
    px[i] = Math.round(clamp(r, 0, 1) * 255);
    px[i + 1] = Math.round(clamp(g, 0, 1) * 255);
    px[i + 2] = Math.round(clamp(b, 0, 1) * 255);
    px[i + 3] = 255;
  }

  // ----- Main render
  function render(tNow) {
    const elapsed = (tNow - start) / 1000;
    if (paused) { requestAnimationFrame(render); return; }

    const minFrameTime = 1000 / FPS_CAP;
    if (tNow - lastFrame < minFrameTime) { requestAnimationFrame(render); return; }
    lastFrame = tNow;

    // Scene parameters
    const horizon = 0.56;                   // y in [0,1]
    const cycleSec = CYCLE_MIN * 60;        // total cycle length
    const phase = (elapsed % cycleSec) / cycleSec;

    // Sun position and size
    const sunX = 0.5 + 0.08 * Math.sin(phase * Math.PI * 2.0);
    const sunY = mix(0.32, 0.68, phase);    // slow descent
    const sunR = mix(0.045, 0.055, 0.5 - 0.5 * Math.cos(phase * Math.PI)); // slight ease
    const glowR = sunR * 3.0;

    const img = sctx.getImageData(0, 0, sceneW, sceneH);
    const px = img.data;

    // Precompute color drift for the sky over time
    const topHue = mix(250, 220, phase);    // purple to deep magenta
    const midHue = mix(305, 30, phase);     // rose to orange
    const botHue = mix(25,  35, phase);     // warm orange band
    const skyShift = 0.05 * Math.sin(elapsed * 0.02);

    // Cloud field drift
    const cloudT = elapsed * 0.012;          // very slow
    const cloudFreq = 0.75;                  // coarse
    const cloudSharp = 0.62;                 // threshold

    // Water waves drift
    const waveT = elapsed * 0.2;             // slow
    const waveAmp = 0.0035;                  // subtle vertical shimmer

    // Loop over pixels
    let p = 0;
    for (let y = 0; y < sceneH; y++) {
      const ny = y / sceneH;
      const above = ny < horizon;

      // base sky gradient for this scanline
      const tSky = ny / horizon;
      const t1 = smoothstep(0.0, 0.6, tSky);
      const t2 = smoothstep(0.4, 1.0, tSky);
      const [rTop, gTop, bTop] = hsv(topHue + skyShift * 20, 0.55, 0.45);
      const [rMid, gMid, bMid] = hsv(midHue + skyShift * 15, 0.72, 0.85);
      const [rBot, gBot, bBot] = hsv(botHue, 0.95, 1.0);

      const rSky = mix(mix(rTop, rMid, t1), rBot, t2);
      const gSky = mix(mix(gTop, gMid, t1), gBot, t2);
      const bSky = mix(mix(bTop, bMid, t1), bBot, t2);

      // mirrored gradient for water
      const nyMirror = Math.max(0, 2 * horizon - ny);
      const tRef = nyMirror / horizon;
      const t1r = smoothstep(0.0, 0.6, tRef);
      const t2r = smoothstep(0.4, 1.0, tRef);
      const rRef = mix(mix(rTop, rMid, t1r), rBot, t2r);
      const gRef = mix(mix(gTop, gMid, t1r), gBot, t2r);
      const bRef = mix(mix(bTop, bMid, t1r), bBot, t2r);

      for (let x = 0; x < sceneW; x++, p += 4) {
        const nx = x / sceneW;

        // Clouds above horizon using soft thresholded fbm
        let r = rSky, g = gSky, b = bSky;

        if (above) {
          const c = fbm((nx + cloudT * 0.05) * cloudFreq, (ny * 0.7 - cloudT * 0.03) * cloudFreq);
          const cover = smoothstep(cloudSharp, 1.0, c);
          // shape tint: cooler at the top, warmer near horizon
          const shade = mix(0.92, 0.98, tSky);
          r *= mix(shade, 1.0, 0.25 * cover);
          g *= mix(shade, 1.0, 0.25 * cover);
          b *= mix(shade, 1.0, 0.25 * cover);
        } else {
          // Water reflection and waves
          // Distort reflection by a stack of ripples
          const dx = nx - 0.5;
          const dy = ny - horizon;
          const ripple =
            Math.sin((nx * 120.0) + waveT) * 0.5 +
            Math.sin((nx * 30.0)  - waveT * 0.8) * 0.35;

          const yWarp = nyMirror + ripple * waveAmp;
          const tRw = yWarp / horizon;
          const t1w = smoothstep(0.0, 0.6, tRw);
          const t2w = smoothstep(0.4, 1.0, tRw);

          let rw = mix(mix(rTop, rMid, t1w), rBot, t2w);
          let gw = mix(mix(gTop, gMid, t1w), gBot, t2w);
          let bw = mix(mix(bTop, bMid, t1w), bBot, t2w);

          // Darken with depth
          const depth = smoothstep(0.0, 0.9, dy / (1 - horizon));
          const darken = mix(0.95, 0.75, depth);
          r = rw * darken;
          g = gw * darken;
          b = bw * darken;

          // Specular path under the sun
          const sunDx = Math.abs(nx - sunX);
          const band = 1.0 / (1.0 + 220.0 * sunDx * sunDx);
          const glint = 0.6 * band * (0.5 + 0.5 * Math.sin((nx * 180.0) + waveT * 0.8));
          r = clamp(r + glint, 0, 1);
          g = clamp(g + glint * 0.9, 0, 1);
          b = clamp(b + glint * 0.8, 0, 1);
        }

        // Sun disc and soft glow affect both sky and water
        const dxs = nx - sunX;
        const dys = ny - sunY;
        const dist = Math.hypot(dxs, dys);

        if (dist < glowR) {
          const glow = smoothstep(glowR, 0.0, dist);
          r = mix(r, 1.0, glow * 0.55);
          g = mix(g, 0.95, glow * 0.5);
          b = mix(b, 0.75, glow * 0.35);
        }
        if (dist < sunR) {
          const core = smoothstep(sunR, 0.0, dist);
          const sR = mix(1.0, 1.0, core);
          const sG = mix(0.95, 0.98, core);
          const sB = mix(0.7, 0.85, core);
          r = mix(r, sR, core);
          g = mix(g, sG, core);
          b = mix(b, sB, core);
        }

        // Subtle scanline shimmer to enrich close viewing
        const micro = 0.004 * Math.sin((y * 2 + x * 3) * 0.5);
        r = clamp(r + micro, 0, 1);
        g = clamp(g + micro, 0, 1);
        b = clamp(b + micro, 0, 1);

        // Ordered dithering to pixel-art look
        const rq = quantChannel(r, LEVELS_R, x, y);
        const gq = quantChannel(g, LEVELS_G, x, y);
        const bq = quantChannel(b, LEVELS_B, x, y);

        pack(px, p, rq, gq, bq);
      }
    }

    sctx.putImageData(img, 0, 0);

    // Blit scaled to display canvas without smoothing
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scene, 0, 0, sceneW, sceneH, offsetX, offsetY, sceneW * scale, sceneH * scale);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);

  // ----- Controls
  const hint = document.getElementById("hint");
  setTimeout(() => hint.classList.add("fade"), 4000);

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "f") toggleFullscreen();
    if (k === "p") paused = !paused;
    if (k === "s") saveFrame();
  });

  function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  function saveFrame() {
    // Save the upscaled frame as PNG
    const link = document.createElement("a");
    link.download = "slow-sunset.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }
})();
