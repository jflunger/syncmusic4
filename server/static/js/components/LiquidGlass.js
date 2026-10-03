/**
 * Liquid Glass effect as a custom element, shaped like an icon.
 * Usage: <liquid-glass src="cover.jpg" shape="play"><button aria-label="Play"></button></liquid-glass>
 *   shape: play | pause | prev | next | slab | circle (default)
 *     slab is a rounded rectangle filling the element (any aspect); its slotted content
 *     is laid out in flow, so the element sizes to it (e.g. a text panel).
 *   accent: optional #rrggbb tint
 *   blur: optional frosting radius in CSS px (0 = clear glass)
 * The glass itself *is* the icon: the shape is a signed distance field in the fragment
 * shader, and the glass refracts `src` (the image painted behind the element's parent,
 * laid out like CSS `background-size: cover`) through a rounded bevel along its outline.
 * Slotted content (a transparent button) sits on top as the hit target.
 * Pressing shrinks the glass and releasing springs it back; changing `shape` morphs the
 * old outline into the new one (the two distance fields are blended).
 */

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 uResolution;
uniform sampler2D uImage;
uniform vec2 uTexOffset;   // element box -> image uv
uniform vec2 uTexScale;
uniform float uShapeFrom;  // 0 circle, 1 play, 2 pause, 3 prev, 4 next
uniform float uShapeTo;
uniform float uMorph;      // 0 = uShapeFrom, 1 = uShapeTo
uniform vec4 uTint;
uniform vec2 uHalf;        // element half-extents in shape units (1 along the short side)
uniform float uBlur;       // frosting radius in canvas px (0 = clear)

const float BEVEL = 0.22;      // bevel width, in shape units (box half-size = 1)
const float REFRACT = 0.16;    // how far edges pull the image inward
const float DISPERSION = 0.04; // per-channel refraction spread (chromatic edge)

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}

// Smooth union: parts of an icon melt into each other like liquid.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float skipShape(vec2 p) {
  float tri = sdTri(p, vec2(-0.62, -0.52), vec2(-0.62, 0.52), vec2(0.22, 0.0)) - 0.1;
  float bar = sdBox(p - vec2(0.48, 0.0), vec2(0.08, 0.52)) - 0.1;
  return smin(tri, bar, 0.08);
}

// Rounded rectangle filling the element, inset so its shadow fits.
float slabSdf(vec2 p) {
  const float INSET = 0.25;
  const float RADIUS = 0.45;
  return sdBox(p, uHalf - INSET - RADIUS) - RADIUS;
}

float iconSdf(float shape, vec2 p) {
  if (shape < 0.5) return length(p) - 0.8;
  if (shape > 4.5) return slabSdf(p);
  if (shape < 1.5) return sdTri(p, vec2(-0.44, -0.62), vec2(-0.44, 0.62), vec2(0.68, 0.0)) - 0.12;
  if (shape < 2.5) {
    vec2 q = vec2(abs(p.x) - 0.3, p.y);
    return sdBox(q, vec2(0.12, 0.58)) - 0.1;
  }
  if (shape < 3.5) return skipShape(vec2(-p.x, p.y));
  return skipShape(p);
}

// Blending the two distance fields morphs one outline into the other; mid-way the
// shapes melt together, which reads as liquid.
float shapeSdf(vec2 p) {
  if (uMorph <= 0.0) return iconSdf(uShapeFrom, p);
  if (uMorph >= 1.0) return iconSdf(uShapeTo, p);
  return mix(iconSdf(uShapeFrom, p), iconSdf(uShapeTo, p), uMorph);
}

vec2 toTex(vec2 uv) {
  return uTexOffset + uv * uTexScale;
}

void main() {
  float unit = 0.5 * min(uResolution.x, uResolution.y);  // px per shape unit
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / unit;
  vec2 uv = gl_FragCoord.xy / uResolution;
  float px = 1.0 / unit;

  float d = shapeSdf(p);

  // Soft drop shadow below the glass so it reads against busy covers.
  float shadow = (1.0 - smoothstep(-0.05, 0.18, shapeSdf(p + vec2(0.0, 0.06)))) * 0.28;
  float alpha = smoothstep(px, -px, d);

  if (alpha <= 0.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, shadow);
    return;
  }

  // Outward normal from the SDF gradient.
  vec2 e = vec2(px, 0.0);
  vec2 n = normalize(vec2(shapeSdf(p + e.xy) - shapeSdf(p - e.xy),
                          shapeSdf(p + e.yx) - shapeSdf(p - e.yx)) + 1e-6);

  // 0 at the outline -> 1 once past the bevel; rim = 1 - circular bevel height.
  float t = clamp(-d / BEVEL, 0.0, 1.0);
  float rim = 1.0 - sqrt(1.0 - (1.0 - t) * (1.0 - t));

  // Refract: the bevel bends the image inward; the flat top slightly magnifies.
  vec2 toUv = unit / uResolution;  // shape units -> element uv
  vec2 center = vec2(0.5);
  vec2 base = center + (uv - center) * 0.96;
  vec2 bend = -n * rim * REFRACT * toUv;
  vec3 col;
  if (uBlur > 0.0) {
    // Frosted: gaussian-weighted 7x7 taps spanning +-uBlur px around the refracted point.
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    vec2 stepUv = vec2(uBlur / 3.0) / uResolution;
    for (int i = -3; i <= 3; i++) {
      for (int j = -3; j <= 3; j++) {
        vec2 o = vec2(float(i), float(j));
        float w = exp(-dot(o, o) / 4.5);
        acc += texture2D(uImage, toTex(base + bend + o * stepUv)).rgb * w;
        wsum += w;
      }
    }
    col = acc / wsum;
  } else {
    col.r = texture2D(uImage, toTex(base + bend * (1.0 + DISPERSION))).r;
    col.g = texture2D(uImage, toTex(base + bend)).g;
    col.b = texture2D(uImage, toTex(base + bend * (1.0 - DISPERSION))).b;
  }

  // Glass body: a touch brighter than what's behind it.
  col = mix(col, vec3(1.0), 0.10);
  if (uTint.a > 0.001) col = mix(col, uTint.rgb, uTint.a * 0.3);

  // Lighting: specular on the edge facing the light (top-left), faint rim on the far
  // edge, and a thin bright line hugging the outline.
  vec2 light = normalize(vec2(-0.6, 0.8));
  float facing = dot(n, light);
  float spec = pow(max(facing, 0.0), 2.0) * rim * 0.75;
  float back = pow(max(-facing, 0.0), 2.0) * rim * 0.3;
  float edge = (1.0 - smoothstep(0.0, 0.035, -d)) * 0.35;
  col += vec3(spec + back + edge);
  col = clamp(col, 0.0, 1.0);

  // Composite the glass over its own shadow at the antialiased edge.
  float a = alpha + shadow * (1.0 - alpha);
  gl_FragColor = vec4(col * alpha / max(a, 1e-4), a);
}`;

const SHAPES = { circle: 0, play: 1, pause: 2, prev: 3, next: 4, slab: 5 };
const MORPH_MS = 380;
const PRESS_MIN_MS = 110;

class LiquidGlass extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'accent', 'shape', 'blur'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._frame = null;
    this._gl = null;
    this._uniforms = null;
    this._texture = null;
    this._textureReady = false;

    // Shape morph state (see _startMorph).
    this._shapeFrom = 0;
    this._shapeTo = 0;
    this._morph = 1;
    this._morphStart = 0;

    // Press animation: keep the pressed state at least PRESS_MIN_MS so a quick tap
    // still visibly dips before springing back.
    this._pressedAt = 0;
    this._releaseTimer = null;
    this._onPress = () => this._press();
    this._onRelease = () => this._release();
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-block;
          position: relative;
          /* Release: overshooting curve gives the springy bounce back to full size. */
          transition: transform 420ms cubic-bezier(0.34, 1.9, 0.64, 1);
          -webkit-tap-highlight-color: transparent;
        }
        :host(.pressed) {
          transform: scale(0.86);
          transition: transform 120ms cubic-bezier(0.3, 0.7, 0.4, 1);
        }
        canvas {
          position: absolute;
          inset: 0;
          display: block;
          width: 100%;
          height: 100%;
        }
        .content {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        /* A slab sizes to its content (text panel) instead of the content filling it. */
        :host([shape="slab"]) .content {
          position: relative;
          display: block;
        }
        .source { display: none; }
      </style>
      <img class="source" crossorigin="anonymous" />
      <canvas></canvas>
      <div class="content"><slot></slot></div>
    `;

    this._canvas = this.shadowRoot.querySelector('canvas');
    this._img = this.shadowRoot.querySelector('.source');

    this._shapeFrom = this._shapeTo = SHAPES[this.getAttribute('shape')] ?? 0;
    this._morph = 1;

    this.addEventListener('pointerdown', this._onPress);
    this.addEventListener('pointerup', this._onRelease);
    this.addEventListener('pointercancel', this._onRelease);
    this.addEventListener('pointerleave', this._onRelease);

    this._initGL();
    this._loadImage(this.getAttribute('src'));

    // Draw on demand: only size, position-in-parent, image or attributes change the output.
    this._resizeObserver = new ResizeObserver(() => this._updateSize());
    this._resizeObserver.observe(this);
    if (this.parentElement) this._resizeObserver.observe(this.parentElement);
    this._updateSize();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal || !this._gl) return;
    if (name === 'src') this._loadImage(newVal);
    else if (name === 'shape') this._startMorph(SHAPES[newVal] ?? 0);
    else this._scheduleDraw();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._frame);
    this._frame = null;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    clearTimeout(this._releaseTimer);
    this.removeEventListener('pointerdown', this._onPress);
    this.removeEventListener('pointerup', this._onRelease);
    this.removeEventListener('pointercancel', this._onRelease);
    this.removeEventListener('pointerleave', this._onRelease);
  }

  /** Shrink on press. */
  _press() {
    if (this.getAttribute('shape') === 'slab') return; // panels aren't buttons
    clearTimeout(this._releaseTimer);
    this._pressedAt = performance.now();
    this.classList.add('pressed');
  }

  /** Spring back on release, after the minimum press time has elapsed. */
  _release() {
    if (!this.classList.contains('pressed')) return;
    const wait = Math.max(0, PRESS_MIN_MS - (performance.now() - this._pressedAt));
    clearTimeout(this._releaseTimer);
    this._releaseTimer = setTimeout(() => this.classList.remove('pressed'), wait);
  }

  /**
   * Morph from the currently displayed outline to `shape`. An interrupted morph
   * restarts from whichever shape it was closer to.
   * @param {number} shape
   */
  _startMorph(shape) {
    const shown = this._morph < 0.5 ? this._shapeFrom : this._shapeTo;
    if (shape === shown && this._morph >= 1) return;
    this._shapeFrom = shown;
    this._shapeTo = shape;
    this._morph = 0;
    this._morphStart = performance.now();
    this._scheduleDraw();
  }

  _initGL() {
    const gl = this._canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    if (!gl) { console.error('liquid-glass: WebGL not supported'); return; }
    this._gl = gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('liquid-glass shader error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
      }
      return s;
    };

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this._uniforms = {
      resolution: gl.getUniformLocation(program, 'uResolution'),
      image: gl.getUniformLocation(program, 'uImage'),
      texOffset: gl.getUniformLocation(program, 'uTexOffset'),
      texScale: gl.getUniformLocation(program, 'uTexScale'),
      shapeFrom: gl.getUniformLocation(program, 'uShapeFrom'),
      shapeTo: gl.getUniformLocation(program, 'uShapeTo'),
      morph: gl.getUniformLocation(program, 'uMorph'),
      tint: gl.getUniformLocation(program, 'uTint'),
      half: gl.getUniformLocation(program, 'uHalf'),
      blur: gl.getUniformLocation(program, 'uBlur'),
    };

    this._texture = gl.createTexture();
  }

  _loadImage(src) {
    this._textureReady = false;
    if (!src) { this._scheduleDraw(); return; }
    this._img.onload = () => {
      this._uploadTexture();
      this._textureReady = true;
      this._scheduleDraw();
    };
    if (this._img.src === src && this._img.complete) {
      this._img.onload();
    } else {
      this._img.src = src;
    }
  }

  _uploadTexture() {
    const gl = this._gl;
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  _updateSize() {
    const rect = this.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = Math.round(rect.width * dpr);
    this._canvas.height = Math.round(rect.height * dpr);
    this._scheduleDraw();
  }

  _scheduleDraw() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      this._draw();
    });
  }

  /**
   * Map this element's box to image uv, assuming the image fills the parent like
   * `background-size: cover; background-position: center` (uv y is up, as in GL).
   * @returns {{offset: number[], scale: number[]}}
   */
  _texMapping() {
    const me = this.getBoundingClientRect();
    const parent = this.parentElement?.getBoundingClientRect();
    if (!parent || !parent.width || !parent.height) return { offset: [0, 0], scale: [1, 1] };

    // Element box within the parent, as parent uv.
    const ox = (me.left - parent.left) / parent.width;
    const oy = 1 - (me.bottom - parent.top) / parent.height;
    const sx = me.width / parent.width;
    const sy = me.height / parent.height;

    // Cover crop: the visible part of the image, as image uv.
    const imgAspect = (this._img.naturalWidth || 1) / (this._img.naturalHeight || 1);
    const boxAspect = parent.width / parent.height;
    let cw = 1, ch = 1;
    if (imgAspect > boxAspect) cw = boxAspect / imgAspect;
    else ch = imgAspect / boxAspect;
    const cx = (1 - cw) / 2;
    const cy = (1 - ch) / 2;

    return { offset: [cx + ox * cw, cy + oy * ch], scale: [sx * cw, sy * ch] };
  }

  /**
   * Advance the morph clock and return its eased (ease-in-out cubic) progress.
   * @returns {number}
   */
  _easedMorph() {
    if (this._morph < 1) {
      this._morph = Math.min(1, (performance.now() - this._morphStart) / MORPH_MS);
    }
    const t = this._morph;
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  _draw() {
    // Advance the morph first, and keep drawing every frame until it finishes.
    const morph = this._easedMorph();
    if (this._morph < 1) this._scheduleDraw();
    const gl = this._gl;
    if (!gl) return;
    const w = this._canvas.width;
    const h = this._canvas.height;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this._textureReady || !w || !h) return;

    const map = this._texMapping();
    gl.uniform2f(this._uniforms.resolution, w, h);
    const short = Math.min(w, h);
    gl.uniform2f(this._uniforms.half, w / short, h / short);
    const blur = parseFloat(this.getAttribute('blur')) || 0;
    gl.uniform1f(this._uniforms.blur, blur * (window.devicePixelRatio || 1));
    gl.uniform2f(this._uniforms.texOffset, map.offset[0], map.offset[1]);
    gl.uniform2f(this._uniforms.texScale, map.scale[0], map.scale[1]);
    gl.uniform1f(this._uniforms.shapeFrom, this._shapeFrom);
    gl.uniform1f(this._uniforms.shapeTo, this._shapeTo);
    gl.uniform1f(this._uniforms.morph, morph);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.uniform1i(this._uniforms.image, 0);

    const accent = this.getAttribute('accent');
    if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
      const c = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16) / 255);
      gl.uniform4f(this._uniforms.tint, c[0], c[1], c[2], 1);
    } else {
      gl.uniform4f(this._uniforms.tint, 0, 0, 0, 0);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

customElements.define('liquid-glass', LiquidGlass);
