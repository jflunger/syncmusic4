/**
 * Liquid Glass effect as a custom element.
 * Usage: <liquid-glass src="image.jpg"><button>Click</button></liquid-glass>
 * Wraps child content in a frosted-glass circle rendered via WebGL.
 */

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;

uniform vec3 iResolution;
uniform float iTime;
uniform vec4 iMouse;
uniform sampler2D iChannel0;
uniform vec2 uTexOffset;
uniform vec2 uTexScale;
uniform vec4 uTint;

vec2 toTex(vec2 v) {
  return uTexOffset + v * uTexScale;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  const float NUM_ZERO = 0.0;
  const float NUM_ONE = 1.0;
  const float NUM_HALF = 0.5;
  const float NUM_TWO = 2.0;
  const float POWER_EXPONENT = 2.0;
  const float MASK_MULTIPLIER_1 = 5.0;
  const float MASK_MULTIPLIER_2 = 4.75;
  const float MASK_MULTIPLIER_3 = 5.5;
  const float LENS_MULTIPLIER = 2.0;
  const float MASK_STRENGTH_1 = 8.0;
  const float MASK_STRENGTH_2 = 16.0;
  const float MASK_STRENGTH_3 = 2.0;
  const float MASK_THRESHOLD_1 = 0.95;
  const float MASK_THRESHOLD_2 = 0.9;
  const float MASK_THRESHOLD_3 = 1.5;
  const float SAMPLE_RANGE = 4.0;
  const float SAMPLE_OFFSET = 0.5;
  const float GRADIENT_RANGE = 0.2;
  const float GRADIENT_OFFSET = 0.1;
  const float GRADIENT_EXTREME = -1000.0;
  const float LIGHTING_INTENSITY = 0.3;

  vec2 uv = fragCoord / iResolution.xy;
  vec2 mouse = iMouse.xy;
  if (length(mouse) < NUM_ONE) {
    mouse = iResolution.xy / NUM_TWO;
  }
  vec2 m2 = uv - mouse / iResolution.xy;

  float roundedBox = pow(abs(m2.x * iResolution.x / iResolution.y), POWER_EXPONENT)
                   + pow(abs(m2.y), POWER_EXPONENT);

  float rb1 = clamp((NUM_ONE - roundedBox * MASK_MULTIPLIER_1) * MASK_STRENGTH_1, NUM_ZERO, NUM_ONE);
  float rb2 = clamp((MASK_THRESHOLD_1 - roundedBox * MASK_MULTIPLIER_2) * MASK_STRENGTH_2, NUM_ZERO, NUM_ONE)
            - clamp(pow(MASK_THRESHOLD_2 - roundedBox * MASK_MULTIPLIER_2, NUM_ONE) * MASK_STRENGTH_2, NUM_ZERO, NUM_ONE);
  float rb3 = clamp((MASK_THRESHOLD_3 - roundedBox * MASK_MULTIPLIER_3) * MASK_STRENGTH_3, NUM_ZERO, NUM_ONE)
            - clamp(pow(NUM_ONE - roundedBox * MASK_MULTIPLIER_3, NUM_ONE) * MASK_STRENGTH_3, NUM_ZERO, NUM_ONE);

  fragColor = vec4(NUM_ZERO);
  float transition = smoothstep(NUM_ZERO, NUM_ONE, rb1 + rb2);

  if (transition > NUM_ZERO) {
    vec2 lens = (uv - NUM_HALF) * (NUM_ONE - roundedBox * LENS_MULTIPLIER) + NUM_HALF;
    float total = NUM_ZERO;
    for (float x = -SAMPLE_RANGE; x <= SAMPLE_RANGE; x++) {
      for (float y = -SAMPLE_RANGE; y <= SAMPLE_RANGE; y++) {
        vec2 offset = vec2(x, y) * SAMPLE_OFFSET / iResolution.xy;
        fragColor += texture2D(iChannel0, toTex(offset + lens));
        total += NUM_ONE;
      }
    }
    fragColor /= total;

    float gradient = clamp((clamp(m2.y, NUM_ZERO, GRADIENT_RANGE) + GRADIENT_OFFSET) / NUM_TWO, NUM_ZERO, NUM_ONE)
                   + clamp((clamp(-m2.y, GRADIENT_EXTREME, GRADIENT_RANGE) * rb3 + GRADIENT_OFFSET) / NUM_TWO, NUM_ZERO, NUM_ONE);
    vec4 lighting = clamp(fragColor + vec4(rb1) * gradient + vec4(rb2) * LIGHTING_INTENSITY, NUM_ZERO, NUM_ONE);

    vec4 glassColor = mix(texture2D(iChannel0, toTex(uv)), lighting, transition);
    if (uTint.a > 0.001) {
      glassColor.rgb = mix(glassColor.rgb, uTint.rgb, uTint.a * 0.4);
    }
    fragColor = vec4(glassColor.rgb, transition);
  } else {
    fragColor = vec4(NUM_ZERO);
  }
}

void main() {
  mainImage(gl_FragColor, gl_FragCoord.xy);
}`;

class LiquidGlass extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'accent'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._animationId = null;
    this._gl = null;
    this._uniforms = null;
    this._texture = null;
    this._textureReady = false;
    this._startTime = 0;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-block;
          position: relative;
          border-radius: 50%;
          overflow: hidden;
        }
        .container {
          width: 100%;
          height: 100%;
          position: relative;
        }
        canvas {
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
          pointer-events: auto;
        }
        .source { display: none; }
      </style>
      <div class="container">
        <img class="source" crossorigin="anonymous" />
        <canvas></canvas>
        <div class="content"><slot></slot></div>
      </div>
    `;

    this._canvas = this.shadowRoot.querySelector('canvas');
    this._img = this.shadowRoot.querySelector('.source');

    this._initGL();
    this._loadImage(this.getAttribute('src'));

    this._resizeObserver = new ResizeObserver(() => this._updateSize());
    this._resizeObserver.observe(this);
    this._updateSize();

    this._startTime = performance.now();
    this._render();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'src' && oldVal !== newVal && this._gl) {
      this._loadImage(newVal);
    }
  }

  disconnectedCallback() {
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
      this._animationId = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
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

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this._uniforms = {
      resolution: gl.getUniformLocation(program, 'iResolution'),
      time: gl.getUniformLocation(program, 'iTime'),
      mouse: gl.getUniformLocation(program, 'iMouse'),
      texture: gl.getUniformLocation(program, 'iChannel0'),
      texOffset: gl.getUniformLocation(program, 'uTexOffset'),
      texScale: gl.getUniformLocation(program, 'uTexScale'),
      tint: gl.getUniformLocation(program, 'uTint'),
    };

    this._texture = gl.createTexture();
  }

  _loadImage(src) {
    if (!src) return;
    this._textureReady = false;
    this._img.onload = () => {
      this._uploadTexture();
      this._textureReady = true;
    };
    if (this._img.src === src && this._img.complete) {
      this._uploadTexture();
      this._textureReady = true;
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
    this._canvas.width = rect.width * dpr;
    this._canvas.height = rect.height * dpr;
  }

  _render() {
    const gl = this._gl;
    if (!gl) return;

    const w = this._canvas.width;
    const h = this._canvas.height;
    const t = (performance.now() - this._startTime) / 1000;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this._textureReady) {
      gl.uniform3f(this._uniforms.resolution, w, h, 1.0);
      gl.uniform1f(this._uniforms.time, t);
      gl.uniform4f(this._uniforms.mouse, w / 2, h / 2, 0, 0);

      const myRect = this.getBoundingClientRect();
      const parentRect = this.parentElement?.getBoundingClientRect();
      if (parentRect && parentRect.width > 0 && parentRect.height > 0) {
        const ox = (myRect.left - parentRect.left) / parentRect.width;
        const oy = 1.0 - (myRect.bottom - parentRect.top) / parentRect.height;
        const sx = myRect.width / parentRect.width;
        const sy = myRect.height / parentRect.height;
        gl.uniform2f(this._uniforms.texOffset, ox, oy);
        gl.uniform2f(this._uniforms.texScale, sx, sy);
      } else {
        gl.uniform2f(this._uniforms.texOffset, 0, 0);
        gl.uniform2f(this._uniforms.texScale, 1, 1);
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.uniform1i(this._uniforms.texture, 0);

      const accent = this.getAttribute('accent');
      if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
        const r = parseInt(accent.slice(1, 3), 16) / 255;
        const g = parseInt(accent.slice(3, 5), 16) / 255;
        const b = parseInt(accent.slice(5, 7), 16) / 255;
        gl.uniform4f(this._uniforms.tint, r, g, b, 1);
      } else {
        gl.uniform4f(this._uniforms.tint, 0, 0, 0, 0);
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    this._animationId = requestAnimationFrame(() => this._render());
  }
}

customElements.define('liquid-glass', LiquidGlass);
