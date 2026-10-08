/**
 * Shared renderer for the liquid-glass playlist cards: a heavily distorting, frosted glass
 * slab with the playlist's covers drifting slowly sideways behind it.
 *
 * Browsers cap a page at ~16 live WebGL contexts and the player's <liquid-glass> controls
 * already use several, so cards can't each own one. Instead ONE offscreen WebGL canvas
 * renders every visible card in turn and copies the result into the card's own 2D canvas.
 *
 * Usage:
 *   const handle = glassStrip.register(canvasEl, ['cover1.jpg', ...], seed);
 *   glassStrip.unregister(handle);
 * The canvas gets the class `ready` once its first frame is painted (fade it in with CSS).
 * register() returns null when WebGL is unavailable — keep a CSS fallback underneath.
 */

const VERTEX_SHADER = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;        // card size, device px
uniform float uDpr;
uniform float uTime;      // seconds (frozen under reduced motion)
uniform float uScroll;    // strip offset, in tiles (one tile = one card height)
uniform float uN;         // tiles in the atlas
uniform sampler2D uImage; // 1024x128 atlas: uN square covers stretched side by side

const float BLUR_BIAS = 3.6; // mip bias → frosting

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Rounded slab filling the card, in device px.
float slab(vec2 p) {
  float r = 14.0 * uDpr;
  return sdBox(p, uRes * 0.5 - uDpr - r) - r;
}

// Frosted sample: four diagonal taps on a mip-biased lookup.
vec3 frost(vec2 uv) {
  vec2 o = vec2(6.0 / 1024.0, 6.0 / 128.0);
  return (texture2D(uImage, uv + o, BLUR_BIAS).rgb
        + texture2D(uImage, uv - o, BLUR_BIAS).rgb
        + texture2D(uImage, uv + vec2(o.x, -o.y), BLUR_BIAS).rgb
        + texture2D(uImage, uv + vec2(-o.x, o.y), BLUR_BIAS).rgb) * 0.25;
}

// Card-height units -> atlas uv (strip scrolls left as uScroll grows; u repeats).
vec2 stripUv(vec2 s) {
  return vec2((s.x + uScroll) / uN, clamp(s.y + 0.5, 0.0, 1.0));
}

void main() {
  vec2 p = gl_FragCoord.xy - uRes * 0.5;
  float d = slab(p);
  float alpha = smoothstep(1.0, -1.0, d);
  if (alpha <= 0.0) { gl_FragColor = vec4(0.0); return; }

  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(slab(p + e.xy) - slab(p - e.xy),
                          slab(p + e.yx) - slab(p - e.yx)) + 1e-6);

  // Thick rounded bevel: 0 at the outline -> 1 past it.
  float t = clamp(-d / (20.0 * uDpr), 0.0, 1.0);
  float rim = 1.0 - sqrt(1.0 - (1.0 - t) * (1.0 - t));

  vec2 q = p / uRes.y; // card-height units, centred
  // Slow liquid wobble — the glass itself looks like it's flowing.
  vec2 wob = vec2(sin(q.y * 5.0 + uTime * 0.8 + q.x * 1.7) + 0.5 * sin(q.x * 3.1 - uTime * 0.6),
                  cos(q.x * 2.3 + uTime * 0.5) + 0.5 * cos(q.y * 4.0 - q.x * 1.1 + uTime * 0.9)) * 0.08;
  // Heavy refraction: the bevel drags the image inward, the flat top magnifies.
  vec2 bend = -n * rim * 0.5;
  vec2 s = q * 0.8 + wob + bend;
  vec2 disp = bend * 0.14 / vec2(uN, 1.0);

  vec2 uv = stripUv(s);
  vec3 col;
  col.r = frost(uv + disp).r;
  col.g = frost(uv).g;
  col.b = frost(uv - disp).b;

  // Richer, darker glass so the title stays legible over any cover.
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, 1.35) * 0.6;
  col = mix(col, vec3(1.0), 0.05);

  // Soft sheen across the upper half, kept off the bevel.
  float top = clamp(p.y / (uRes.y * 0.5), 0.0, 1.0);
  col += top * top * 0.07 * t;

  // Lighting: specular on the lit edge, faint back-rim, thin bright outline.
  vec2 light = normalize(vec2(-0.6, 0.8));
  float facing = dot(n, light);
  float spec = pow(max(facing, 0.0), 2.0) * rim * 0.7;
  float back = pow(max(-facing, 0.0), 2.0) * rim * 0.25;
  float edge = (1.0 - smoothstep(0.0, 1.5 * uDpr, -d)) * 0.4;
  col = clamp(col + spec + back + edge, 0.0, 1.0);

  gl_FragColor = vec4(col * alpha, alpha); // premultiplied
}`;

const ATLAS_W = 1024;          // power of two: REPEAT wrap + mipmaps in WebGL1
const ATLAS_H = 128;
const MAX_TILES = 8;
const SPEED = 0.06;            // tiles per second — one cover drifts past every ~16s
const FRAME_MS = 33;           // ~30fps is plenty for a slow drift
const MAX_DPR = 2;
const RELEASE_DELAY_MS = 5000; // keep textures briefly so list re-renders don't reload

class GlassStripRenderer {
  constructor() {
    this._items = new Set();
    this._visible = new Set();
    this._textures = new Map(); // covers key -> { tex, atlas, n, refs, ready, failed }
    this._images = new Map();   // url -> Promise<HTMLImageElement|null>
    this._gl = null;
    this._glFailed = false;
    this._frame = null;
    this._last = 0;
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    this._io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const item = entry.target._glassItem;
        if (!item) continue;
        if (entry.isIntersecting) { this._visible.add(item); item.dirty = true; }
        else this._visible.delete(item);
      }
      this._kick();
    }, { rootMargin: '100px' });

    this._ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const item = entry.target._glassItem;
        if (item) this._sizeItem(item);
      }
      this._kick();
    });

    document.addEventListener('visibilitychange', () => this._kick());
  }

  /**
   * Start rendering a card into `canvas`.
   * @param {HTMLCanvasElement} canvas
   * @param {string[]} covers cover URLs (may be empty)
   * @param {number} seed per-card offset so cards don't drift in lockstep
   * @returns {object|null} handle for unregister(), or null without WebGL
   */
  register(canvas, covers, seed = 0) {
    if (!this._ensureGL()) return null;
    const key = covers.join(' ');
    const item = { canvas, ctx: canvas.getContext('2d'), key, seed, dirty: true };
    canvas._glassItem = item;
    this._acquire(key, covers);
    this._items.add(item);
    this._sizeItem(item);
    this._io.observe(canvas);
    this._ro.observe(canvas);
    return item;
  }

  /** @param {object|null} item handle from register() */
  unregister(item) {
    if (!item || !this._items.has(item)) return;
    this._items.delete(item);
    this._visible.delete(item);
    this._io.unobserve(item.canvas);
    this._ro.unobserve(item.canvas);
    item.canvas._glassItem = null;
    this._release(item.key);
  }

  /* ---------- GL setup ---------- */

  _ensureGL() {
    if (this._gl) return true;
    if (this._glFailed) return false;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    // preserveDrawingBuffer: we read the buffer back (drawImage) between draws in one task.
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true });
    if (!gl) { this._glFailed = true; return false; }
    this._glCanvas = canvas;
    this._gl = gl;
    if (!this._initProgram()) { this._gl = null; this._glFailed = true; return false; }

    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this._lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._lost = false;
      this._initProgram();
      for (const entry of this._textures.values()) {
        entry.tex = gl.createTexture();
        if (entry.ready) this._upload(entry);
      }
      this._items.forEach(i => { i.dirty = true; });
      this._kick();
    });
    return true;
  }

  _initProgram() {
    const gl = this._gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('glass-strip shader error:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return false;
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    const u = name => gl.getUniformLocation(program, name);
    this._u = {
      res: u('uRes'), dpr: u('uDpr'), time: u('uTime'), scroll: u('uScroll'), n: u('uN'), image: u('uImage'),
    };
    gl.uniform1i(this._u.image, 0);
    return true;
  }

  /* ---------- textures ---------- */

  _acquire(key, covers) {
    let entry = this._textures.get(key);
    if (entry) {
      entry.refs++;
      clearTimeout(entry.releaseTimer);
      return;
    }
    entry = { tex: this._gl.createTexture(), atlas: null, n: 1, refs: 1, ready: false, failed: false };
    this._textures.set(key, entry);
    this._buildAtlas(covers).then(({ atlas, n }) => {
      entry.atlas = atlas;
      entry.n = n;
      entry.ready = this._upload(entry);
      entry.failed = !entry.ready;
      this._items.forEach(i => { if (i.key === key) i.dirty = true; });
      this._kick();
    });
  }

  _release(key) {
    const entry = this._textures.get(key);
    if (!entry || --entry.refs > 0) return;
    entry.releaseTimer = setTimeout(() => {
      if (entry.refs > 0) return;
      this._textures.delete(key);
      if (this._gl && !this._lost) this._gl.deleteTexture(entry.tex);
    }, RELEASE_DELAY_MS);
  }

  /** Load a cover CORS-clean (a failed load is skipped so the atlas never taints). */
  _loadImage(url) {
    if (!this._images.has(url)) {
      this._images.set(url, new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      }));
    }
    return this._images.get(url);
  }

  /**
   * Paint up to MAX_TILES square-cropped covers side by side into a 1024x128 atlas. Each
   * tile is stretched to 1024/n wide; the shader maps one tile to one card height, so
   * covers display square regardless. No covers → a few soft green placeholder tiles.
   */
  async _buildAtlas(covers) {
    const imgs = (await Promise.all(covers.slice(0, MAX_TILES).map(u => this._loadImage(u)))).filter(Boolean);
    const atlas = document.createElement('canvas');
    atlas.width = ATLAS_W;
    atlas.height = ATLAS_H;
    const ctx = atlas.getContext('2d');
    const n = imgs.length || 3;
    const tileW = ATLAS_W / n;
    for (let i = 0; i < n; i++) {
      const x = i * tileW;
      const img = imgs[i];
      if (img) {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, x, 0, tileW + 1, ATLAS_H);
      } else {
        const g = ctx.createLinearGradient(x, 0, x + tileW, ATLAS_H);
        g.addColorStop(0, ['#1db954', '#0e5c2b', '#2a7f62'][i % 3]);
        g.addColorStop(1, ['#0b3d1f', '#27c46a', '#103a30'][i % 3]);
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, tileW + 1, ATLAS_H);
      }
    }
    return { atlas, n };
  }

  /** @returns {boolean} false if the upload was refused (e.g. tainted canvas) */
  _upload(entry) {
    const gl = this._gl;
    if (!gl || this._lost) return false;
    try {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.atlas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return true;
    } catch (err) {
      console.warn('glass-strip: texture upload failed', err);
      return false;
    }
  }

  /* ---------- render loop ---------- */

  _sizeItem(item) {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.round(item.canvas.clientWidth * dpr);
    const h = Math.round(item.canvas.clientHeight * dpr);
    if (w !== item.canvas.width || h !== item.canvas.height) {
      item.canvas.width = w;
      item.canvas.height = h;
    }
    item.dpr = dpr;
    item.dirty = true;
  }

  _kick() {
    if (this._frame || document.hidden || !this._visible.size) return;
    this._frame = requestAnimationFrame(now => this._tick(now));
  }

  _tick(now) {
    this._frame = null;
    if (document.hidden || !this._visible.size || this._lost) return;
    const animate = !this._reducedMotion;
    if (animate && now - this._last < FRAME_MS) { this._kick(); return; }
    this._last = now;

    const time = animate ? now / 1000 : 0;
    let pending = false;
    for (const item of this._visible) {
      if (!animate && !item.dirty) continue;
      if (!this._draw(item, time)) pending = true;
    }
    // Keep looping while animating, or while a texture is still loading.
    if (animate || pending) this._kick();
  }

  /** @returns {boolean} true once the card is painted (or can never be) */
  _draw(item, time) {
    const entry = this._textures.get(item.key);
    if (!entry || entry.failed) return true;
    if (!entry.ready) return false;
    const { width: w, height: h } = item.canvas;
    if (!w || !h) return true;

    const gl = this._gl;
    const glc = this._glCanvas;
    if (glc.width < w || glc.height < h) {
      glc.width = Math.max(glc.width, w);
      glc.height = Math.max(glc.height, h);
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this._u.res, w, h);
    gl.uniform1f(this._u.dpr, item.dpr);
    gl.uniform1f(this._u.time, time + item.seed * 7.3);
    gl.uniform1f(this._u.scroll, (time * SPEED + item.seed) % entry.n);
    gl.uniform1f(this._u.n, entry.n);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // The viewport sits at the GL canvas's bottom-left; copy that region out.
    item.ctx.globalCompositeOperation = 'copy';
    item.ctx.drawImage(glc, 0, glc.height - h, w, h, 0, 0, w, h);
    if (item.dirty) {
      item.dirty = false;
      item.canvas.classList.add('ready');
    }
    return true;
  }
}

const glassStrip = new GlassStripRenderer();
export default glassStrip;
