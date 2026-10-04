const WGSL = `
struct Globals {
  viewport: vec2<f32>,
  camera: vec2<f32>,
  time: f32,
  intensity: f32,
  focal: f32,
  horizon: f32,
};
@group(0) @binding(0) var<uniform> g: Globals;

struct VIn {
  @location(0) pos: vec2<f32>,
  @location(1) radius: f32,
  @location(2) color: vec4<f32>,
  @location(3) kind: f32,
  @location(4) depth: f32,
};
struct VOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) kind: f32,
};

@vertex fn vs(v: VIn, @builtin(vertex_index) vi: u32) -> VOut {
  var o: VOut;
  let corners = array<vec2<f32>,6>(
    vec2<f32>(-1,-1),vec2<f32>(1,-1),vec2<f32>(-1,1),
    vec2<f32>(-1,1),vec2<f32>(1,-1),vec2<f32>(1,1)
  );
  let corner = corners[vi];
  let world = v.pos - g.camera;
  let p = clamp(g.focal / (g.focal + max(0.0,v.depth)),0.25,1.0);
  let py = world.y - v.depth * 0.18;
  let pixel = vec2<f32>(world.x*p,(py-g.horizon)*p+g.horizon) + corner*v.radius*p;
  o.position=vec4<f32>(pixel.x/g.viewport.x*2.0,-pixel.y/g.viewport.y*2.0,0.0,1.0);
  o.uv=corner;
  o.color=v.color;
  o.kind=v.kind;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let d=length(v.uv);
  if(d>1.0){discard;}
  let glow=pow(max(0.0,1.0-d),2.2);
  let ring=smoothstep(0.72,0.76,abs(sin(d*18.0+g.time*3.0)));
  let pulse=0.84+0.16*sin(g.time*5.0+v.kind*1.7);
  return vec4<f32>(v.color.rgb*(pulse+glow*0.65+ring*0.25),v.color.a);
}

struct TVOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) height: f32,
};

@vertex fn terrain_vs(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>) -> TVOut {
  var o: TVOut;
  let rel=pos.xy-g.camera;
  let z=pos.z;
  let p=clamp(g.focal/(g.focal+z),0.25,1.0);
  let y=rel.y-z*0.20;
  let pixel=vec2<f32>(rel.x*p,(y-g.horizon)*p+g.horizon);
  o.position=vec4<f32>(pixel.x/g.viewport.x*2.0,-pixel.y/g.viewport.y*2.0,clamp(z/1800.0,0.0,0.98),1.0);
  o.uv=pos.xy*0.002;
  o.normal=normal;
  o.height=pos.y;
  return o;
}

@fragment fn terrain_fs(v: TVOut) -> @location(0) vec4<f32> {
  let light=normalize(vec3<f32>(-0.35,-0.8,0.55));
  let ndl=max(0.0,dot(normalize(v.normal),-light));
  let grid=0.5+0.5*sin(v.uv.x*40.0+g.time*0.2)*sin(v.uv.y*40.0);
  let pulse=0.75+g.intensity*0.55;
  let base=vec3<f32>(0.055+grid*0.035,0.07+grid*0.025,0.12+g.intensity*0.04);
  return vec4<f32>(base*(0.45+ndl*0.75)*pulse,1.0);
}
`;

export class EchoVoidWebGPU {
  constructor(canvas){
    this.canvas=canvas; this.device=null; this.context=null;
    this.pipeline=null; this.terrainPipeline=null; this.uniformBuffer=null;
    this.uniformBindGroup=null; this.instanceBuffer=null; this.instanceCapacity=0;
    this.terrainBuffer=null; this.terrainVertexCount=0; this.depthTexture=null;
    this.ready=false;
  }

  async init(){
    if(!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter) throw new Error('No WebGPU adapter');
    this.device=await adapter.requestDevice();
    this.context=this.canvas.getContext('webgpu');
    const format=navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({device:this.device,format,alphaMode:'opaque'});

    const module=this.device.createShaderModule({code:WGSL});
    this.pipeline=this.device.createRenderPipeline({
      layout:'auto',
      vertex:{module,entryPoint:'vs',buffers:[{
        arrayStride:28,stepMode:'instance',attributes:[
          {shaderLocation:0,offset:0,format:'float32x2'},
          {shaderLocation:1,offset:8,format:'float32'},
          {shaderLocation:2,offset:12,format:'float32x4'},
          {shaderLocation:3,offset:28,format:'float32'},
          {shaderLocation:4,offset:32,format:'float32'}
        ]
      }]},
      fragment:{module,entryPoint:'fs',targets:[{format}]},
      primitive:{topology:'triangle-list'}
    });
    this.terrainPipeline=this.device.createRenderPipeline({
      layout:'auto',
      vertex:{module,entryPoint:'terrain_vs',buffers:[{
        arrayStride:24,stepMode:'vertex',attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},
          {shaderLocation:1,offset:12,format:'float32x3'}
        ]
      }]},
      fragment:{module,entryPoint:'terrain_fs',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'none'}
    });

    this.uniformBuffer=this.device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.uniformBindGroup=this.device.createBindGroup({
      layout:this.pipeline.getBindGroupLayout(0),
      entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]
    });

    this.terrainBindGroup=this.device.createBindGroup({
      layout:this.terrainPipeline.getBindGroupLayout(0),
      entries:[{binding:0,resource:{buffer:this.uniformBuffer}}]
    });

    this.buildTerrain();
    this.ready=true; this.resize(); return true;
  }

  buildTerrain(){
    const N=28, size=2400, step=size/(N-1), verts=[];
    const height=(x,z)=>Math.sin(x*0.009)*18+Math.cos(z*0.011)*14+Math.sin((x+z)*0.018)*7;
    const push=(x,z)=>{
      const h=height(x,z), e=2;
      const hx=(height(x+e,z)-height(x-e,z))/(2*e);
      const hz=(height(x,z+e)-height(x,z-e))/(2*e);
      const n=[-hx,1,-hz];
      const len=Math.hypot(...n); n[0]/=len;n[1]/=len;n[2]/=len;
      verts.push(x,h,z,n[0],n[1],n[2]);
    };
    for(let iz=0;iz<N-1;iz++) for(let ix=0;ix<N-1;ix++){
      const x0=-size/2+ix*step,x1=x0+step,z0=iz*step,z1=z0+step;
      const cells=[[x0,z0],[x1,z0],[x0,z1],[x0,z1],[x1,z0],[x1,z1]];
      for(const [x,z] of cells) push(x,z);
    }
    this.terrainVertexCount=verts.length/6;
    this.terrainBuffer=this.device.createBuffer({
      size:verts.length*4,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.terrainBuffer,0,new Float32Array(verts));
  }

  resize(){
    if(!this.ready) return;
    const dpr=Math.min(devicePixelRatio||1,2);
    this.canvas.width=Math.max(1,Math.floor(innerWidth*dpr));
    this.canvas.height=Math.max(1,Math.floor(innerHeight*dpr));
  }

  ensureCapacity(count){
    if(count<=this.instanceCapacity)return;
    this.instanceCapacity=Math.max(count,this.instanceCapacity*2,64);
    this.instanceBuffer?.destroy();
    this.instanceBuffer=this.device.createBuffer({
      size:this.instanceCapacity*36,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST
    });
  }

  render(state){
    if(!this.ready)return;
    const dpr=Math.min(devicePixelRatio||1,2),w=this.canvas.width/dpr,h=this.canvas.height/dpr;
    const data=[], add=(x,y,r,c,k=0,z=0)=>data.push(x,y,r,c[0],c[1],c[2],c[3],k,z);
    const ac=state.accentRgb;
    for(const z of state.safeZones){
      add(z.x,z.y,z.r,[.25,1,.78,.20],5,40);
      add(z.x,z.y,z.r*.62,[.25,1,.78,.10],5,35);
    }
    if(state.boss)add(state.boss.x,state.boss.y,state.boss.r,[ac[0],ac[1],ac[2],1],9,20);
    for(const m of state.monsters){
      const c=m.type==='BASS'?[1,.25,.32,1]:m.type==='TREBLE'?[.45,.55,1,1]:m.type==='VOCAL'?[1,.35,.75,1]:[.55,1,.8,1];
      add(m.x,m.y,m.r,c,m.type==='BASS'?1:m.type==='TREBLE'?2:m.type==='VOCAL'?3:4,12);
      if(m.state==='telegraph')add(m.x,m.y,m.r*1.55,[1,1,1,.65],8,8);
    }
    add(state.player.x,state.player.y,state.player.r,[.94,.97,1,1],10,0);
    this.ensureCapacity(data.length/9);
    const globals=new Float32Array([w,h,state.player.x*dpr,state.player.y*dpr,state.time,state.intensity,520,h*.58]);
    this.device.queue.writeBuffer(this.uniformBuffer,0,globals);
    this.device.queue.writeBuffer(this.instanceBuffer,0,new Float32Array(data));

    const encoder=this.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{
      view:this.context.getCurrentTexture().createView(),
      clearValue:{r:state.bg[0],g:state.bg[1],b:state.bg[2],a:1},
      loadOp:'clear',storeOp:'store'
    }]});
    pass.setPipeline(this.terrainPipeline);
    pass.setBindGroup(0,this.terrainBindGroup);
    pass.setVertexBuffer(0,this.terrainBuffer);
    pass.draw(this.terrainVertexCount);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0,this.uniformBindGroup);
    pass.setVertexBuffer(0,this.instanceBuffer);
    pass.draw(6,data.length/9,0,0);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

export function hexRgb(hex){
  const n=parseInt(hex.replace('#',''),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
}
