const WGSL=`
struct Globals { viewport: vec2<f32>, camera: vec2<f32>, time: f32, intensity: f32 };
@group(0) @binding(0) var<uniform> g: Globals;

struct VIn {
  @location(0) corner: vec2<f32>,
  @location(1) pos: vec2<f32>,
  @location(2) radius: f32,
  @location(3) color: vec4<f32>,
  @location(4) kind: f32,
};
struct VOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) kind: f32,
};

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  let world = v.pos - g.camera;
  let pixel = world + v.corner * v.radius;
  let clip = vec2<f32>(pixel.x / g.viewport.x * 2.0, -pixel.y / g.viewport.y * 2.0);
  o.position = vec4<f32>(clip, 0.0, 1.0);
  o.uv = v.corner;
  o.color = v.color;
  o.kind = v.kind;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let d = length(v.uv);
  if (d > 1.0) { discard; }
  let glow = pow(max(0.0, 1.0 - d), 2.2);
  let ring = smoothstep(0.72, 0.76, abs(sin(d * 18.0 + g.time * 3.0)));
  let pulse = 0.84 + 0.16 * sin(g.time * 5.0 + v.kind * 1.7);
  return vec4<f32>(v.color.rgb * (pulse + glow * 0.65 + ring * 0.25), v.color.a);
}
`;

export class EchoVoidWebGPU {
  constructor(canvas) {
    this.canvas = canvas;
    this.device = null;
    this.context = null;
    this.pipeline = null;
    this.uniformBuffer = null;
    this.uniformBindGroup = null;
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.ready = false;
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format, alphaMode: 'opaque' });

    const module = this.device.createShaderModule({ code: WGSL });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
          { arrayStride: 32, stepMode: 'instance', attributes: [
            { shaderLocation: 1, offset: 0, format: 'float32x2' },
            { shaderLocation: 2, offset: 8, format: 'float32' },
            { shaderLocation: 3, offset: 12, format: 'float32x4' },
            { shaderLocation: 4, offset: 28, format: 'float32' },
          ] },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformBindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.vertexBuffer = this.device.createBuffer({
      size: 6 * 8,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array([
      -1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1
    ]));
    this.ready = true;
    this.resize();
    return true;
  }

  resize() {
    if (!this.ready) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(innerWidth * dpr));
    const h = Math.max(1, Math.floor(innerHeight * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
  }

  ensureCapacity(count) {
    if (count <= this.instanceCapacity) return;
    this.instanceCapacity = Math.max(count, this.instanceCapacity * 2, 64);
    this.instanceBuffer?.destroy();
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceCapacity * 32,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  render(state) {
    if (!this.ready) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const data = [];
    const add = (x,y,r,c,k=0) => data.push(x,y,r,c[0],c[1],c[2],c[3],k);

    const accent = state.accent;
    const ac = state.accentRgb;
    for (const z of state.safeZones) {
      add(z.x,z.y,z.r,[0.25,1,0.78,0.20],5);
      add(z.x,z.y,z.r*.62,[0.25,1,0.78,0.10],5);
    }
    if (state.boss) add(state.boss.x,state.boss.y,state.boss.r,[ac[0],ac[1],ac[2],1],9);
    for (const m of state.monsters) {
      const c = m.type==='BASS'?[1,.25,.32,1]:m.type==='TREBLE'?[.45,.55,1,1]:m.type==='VOCAL'?[1,.35,.75,1]:[.55,1,.8,1];
      add(m.x,m.y,m.r,c,m.type==='BASS'?1:m.type==='TREBLE'?2:m.type==='VOCAL'?3:4);
      if (m.state==='telegraph') add(m.x,m.y,m.r*1.55,[1,1,1,.65],8);
    }
    add(state.player.x,state.player.y,state.player.r,[.94,.97,1,1],10);
    this.ensureCapacity(data.length / 8);

    const globals = new Float32Array([w,h,state.player.x*dpr,state.player.y*dpr,state.time,state.intensity,0,0]);
    this.device.queue.writeBuffer(this.uniformBuffer,0,globals);
    this.device.queue.writeBuffer(this.instanceBuffer,0,new Float32Array(data));

    const encoder=this.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({
      colorAttachments:[{
        view:this.context.getCurrentTexture().createView(),
        clearValue:{r:state.bg[0],g:state.bg[1],b:state.bg[2],a:1},
        loadOp:'clear',storeOp:'store'
      }]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0,this.uniformBindGroup);
    pass.setVertexBuffer(0,this.vertexBuffer);
    pass.setVertexBuffer(1,this.instanceBuffer);
    pass.draw(6,data.length/8,0,0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

export function hexRgb(hex) {
  const n=parseInt(hex.replace('#',''),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
}
