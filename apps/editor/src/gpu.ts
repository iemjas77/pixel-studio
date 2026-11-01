import { BLEND_MODES, composeRegion, type BlendMode, type ComposeOptions, type RenderNode } from '@ps/raster';

/**
 * WebGL2 compositor. Mirrors the CPU reference (packages/raster-ref/src/composite.ts):
 *  - sources are straight-alpha RGBA8 (raster/text) or premultiplied float (isolated groups),
 *  - accumulation is premultiplied RGBA32F ping-pong, the same W3C formulas,
 *  - one un-premultiply (+ optional linear→sRGB encode) on output to RGBA8.
 * Documented agreement with the CPU reference: ≤ 1/255 per channel (rounding), see docs/HANDOVER.md.
 * Falls back to the CPU reference when WebGL2 / float render targets are unavailable or the
 * context is lost; recovers when the context is restored.
 */
const MODE_INDEX: Record<BlendMode, number> = Object.fromEntries(BLEND_MODES.map((m, i) => [m, i])) as Record<BlendMode, number>;

const VS = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_src; uniform sampler2D u_mask; uniform sampler2D u_back;
uniform int u_srcPremult; uniform int u_hasMask; uniform float u_opacity; uniform int u_mode; uniform int u_linear; uniform int u_final;
out vec4 o;
float s2l(float c){ return c<=0.04045 ? c/12.92 : pow((c+0.055)/1.055, 2.4); }
float l2s(float c){ c=clamp(c,0.0,1.0); return c<=0.0031308 ? c*12.92 : 1.055*pow(c,1.0/2.4)-0.055; }
float hardLight(float cb,float cs){ return cs<=0.5 ? cb*(2.0*cs) : cb+(2.0*cs-1.0)-cb*(2.0*cs-1.0); }
float blendCh(int m,float cb,float cs){
  if(m==0) return cs;
  if(m==1) return cb*cs;
  if(m==2) return cb+cs-cb*cs;
  if(m==3) return hardLight(cs,cb);
  if(m==4) return min(cb,cs);
  if(m==5) return max(cb,cs);
  if(m==6) return cb==0.0 ? 0.0 : (cs>=1.0 ? 1.0 : min(1.0, cb/(1.0-cs)));
  if(m==7) return cb>=1.0 ? 1.0 : (cs<=0.0 ? 0.0 : 1.0-min(1.0,(1.0-cb)/cs));
  if(m==8) return hardLight(cb,cs);
  if(m==9){ if(cs<=0.5) return cb-(1.0-2.0*cs)*cb*(1.0-cb); float d = cb<=0.25 ? ((16.0*cb-12.0)*cb+4.0)*cb : sqrt(cb); return cb+(2.0*cs-1.0)*(d-cb); }
  if(m==10) return abs(cb-cs);
  return cb+cs-2.0*cb*cs;
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 back = texelFetch(u_back, p, 0);
  if(u_final==1){
    if(back.a<=0.0){ o=vec4(0.0); return; }
    vec3 c = back.rgb/back.a;
    if(u_linear==1) c = vec3(l2s(c.r),l2s(c.g),l2s(c.b));
    o = vec4(clamp(c,0.0,1.0), clamp(back.a,0.0,1.0)); return;
  }
  vec4 s = texelFetch(u_src, p, 0);
  float sa; vec3 sc;
  if(u_srcPremult==1){ if(s.a<=0.0){ o=back; return; } sa=s.a; sc=s.rgb/s.a; }
  else { if(s.a<=0.0){ o=back; return; } sa=s.a; sc=s.rgb; if(u_linear==1) sc=vec3(s2l(sc.r),s2l(sc.g),s2l(sc.b)); }
  sa *= u_opacity;
  if(u_hasMask==1) sa *= texelFetch(u_mask, p, 0).r;
  if(sa<=0.0){ o=back; return; }
  float ab = back.a;
  vec3 res;
  if(ab<=0.0 || u_mode==0){ res = back.rgb*(1.0-sa) + sa*sc; }
  else {
    vec3 cb = back.rgb/ab;
    vec3 B = vec3(blendCh(u_mode,cb.r,sc.r), blendCh(u_mode,cb.g,sc.g), blendCh(u_mode,cb.b,sc.b));
    res = back.rgb*(1.0-sa) + sa*((1.0-ab)*sc + ab*B);
  }
  o = vec4(res, sa + ab*(1.0-sa));
}`;

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; fmt: 'f32' | 'u8' }

export class GpuCompositor {
  private canvas: OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  /** Live GL objects created by this compositor (leak check: must return to baseline after each compose). */
  liveResources = 0;
  lastBackend: 'gpu' | 'cpu' = 'cpu';
  contextLosses = 0;
  private pool: Target[] = [];
  private enabled = true;
  private loseExt: WEBGL_lose_context | null = null;

  constructor() {
    this.canvas = new OffscreenCanvas(4, 4);
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; this.prog = null; this.pool = []; this.liveResources = 0; this.contextLosses++; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.init(); });
    this.init();
  }
  get available() { return this.gl !== null && this.enabled; }
  setEnabled(v: boolean) { this.enabled = v; }

  private init(): boolean {
    try {
      const gl = this.canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) { this.gl = null; return false; }
      const sh = (t: number, src: string) => { const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s; };
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
      this.loc = {};
      for (const u of ['u_src', 'u_mask', 'u_back', 'u_srcPremult', 'u_hasMask', 'u_opacity', 'u_mode', 'u_linear', 'u_final']) this.loc[u] = gl.getUniformLocation(p, u);
      this.vao = gl.createVertexArray();
      this.loseExt = gl.getExtension('WEBGL_lose_context');
      this.gl = gl; this.prog = p; this.pool = [];
      return true;
    } catch { this.gl = null; return false; }
  }

  // ---- resources ----
  private newTarget(w: number, h: number, fmt: 'f32' | 'u8'): Target {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (fmt === 'f32') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    this.liveResources += 2;
    return { tex, fbo, w, h, fmt };
  }
  private acquire(w: number, h: number, fmt: 'f32' | 'u8' = 'f32'): Target {
    const i = this.pool.findIndex(t => t.w === w && t.h === h && t.fmt === fmt);
    if (i >= 0) return this.pool.splice(i, 1)[0];
    return this.newTarget(w, h, fmt);
  }
  private release(t: Target) { this.pool.push(t); }
  private destroy(t: Target) { const gl = this.gl; if (!gl) return; gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); this.liveResources -= 2; }
  /** Free all pooled GPU resources. */
  dispose() { for (const t of this.pool) this.destroy(t); this.pool = []; }

  private upload(data: Uint8Array, w: number, h: number, kind: 'rgba' | 'r'): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (kind === 'rgba') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.liveResources++;
    return tex;
  }
  private del(tex: WebGLTexture) { this.gl!.deleteTexture(tex); this.liveResources--; }

  private bind(unit: number, tex: WebGLTexture, name: string) {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(this.loc[name], unit);
  }

  private pass(out: Target, back: Target, o: { src?: WebGLTexture; mask?: WebGLTexture | null; srcPremult?: boolean; opacity?: number; mode?: number; linear: boolean; final?: boolean }) {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.w, out.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    this.bind(2, back.tex, 'u_back');
    if (o.src) this.bind(0, o.src, 'u_src'); else this.bind(0, back.tex, 'u_src');
    if (o.mask) this.bind(1, o.mask, 'u_mask'); else this.bind(1, back.tex, 'u_mask');
    gl.uniform1i(this.loc.u_srcPremult, o.srcPremult ? 1 : 0);
    gl.uniform1i(this.loc.u_hasMask, o.mask ? 1 : 0);
    gl.uniform1f(this.loc.u_opacity, o.opacity ?? 1);
    gl.uniform1i(this.loc.u_mode, o.mode ?? 0);
    gl.uniform1i(this.loc.u_linear, o.linear ? 1 : 0);
    gl.uniform1i(this.loc.u_final, o.final ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Returns a float premultiplied accumulation target (caller releases it). */
  private render(nodes: RenderNode[], x: number, y: number, w: number, h: number, linear: boolean): Target {
    const gl = this.gl!;
    let a = this.acquire(w, h), b = this.acquire(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    for (const n of nodes) {
      if (!n.visible || n.opacity <= 0) continue;
      let src: WebGLTexture | null = null, child: Target | null = null;
      if (n.children) { child = this.render(n.children, x - n.offsetX, y - n.offsetY, w, h, linear); src = child.tex; }
      else if (n.pixels) src = this.upload(n.pixels.readRegion(x - n.offsetX, y - n.offsetY, w, h), w, h, 'rgba');
      else continue;
      const mask = n.maskEnabled && n.mask ? this.upload(n.mask.readRegion(x - n.offsetX, y - n.offsetY, w, h), w, h, 'r') : null;
      this.pass(b, a, { src, mask, srcPremult: !!child, opacity: n.opacity, mode: MODE_INDEX[n.blend], linear });
      if (child) this.release(child); else this.del(src);
      if (mask) this.del(mask);
      [a, b] = [b, a];
    }
    this.release(b);
    return a;
  }

  /** Compose a doc-space region to straight-alpha RGBA8 (GPU if possible, CPU reference otherwise). */
  compose(nodes: RenderNode[], x: number, y: number, w: number, h: number, opts: ComposeOptions = {}): Uint8Array {
    if (!this.available || w > 4096 || h > 4096) return this.cpu(nodes, x, y, w, h, opts);
    try {
      const gl = this.gl!;
      if (gl.isContextLost()) return this.cpu(nodes, x, y, w, h, opts);
      const acc = this.render(nodes, x, y, w, h, !!opts.linear);
      const out = this.acquire(w, h, 'u8');
      this.pass(out, acc, { linear: !!opts.linear, final: true });
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      this.release(acc); this.release(out);
      if (this.pool.length > 12) { for (const t of this.pool.splice(0, this.pool.length - 6)) this.destroy(t); }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error');
      this.lastBackend = 'gpu';
      return px;
    } catch {
      return this.cpu(nodes, x, y, w, h, opts);
    }
  }
  private cpu(nodes: RenderNode[], x: number, y: number, w: number, h: number, opts: ComposeOptions) {
    this.lastBackend = 'cpu';
    return composeRegion(nodes, x, y, w, h, opts);
  }

  /** Test hook: simulate GPU context loss / restore via WEBGL_lose_context. */
  debugLoseContext() { this.loseExt?.loseContext(); }
  debugRestoreContext() { this.loseExt?.restoreContext(); }
}
