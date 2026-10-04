const WGSL = `
struct Globals {
  viewport: vec2<f32>,
  camera: vec2<f32>,
  time: f32,
  intensity: f32,
  focal: f32,
  horizon: f32,
  fog: vec4<f32>,   // rgb = fog colour, w = distance density
  fogP: vec4<f32>,  // x = height fog, y = silence, z = glitch, w = void
  light: vec4<f32>, // xyz = unit direction the light travels, w = shadow strength
  shadowP: vec4<f32>, // x = shadow-map texel, y = depth bias
};
struct LightU { vp: mat4x4<f32> };
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<uniform> lightU: LightU;
@group(0) @binding(2) var shadowTex: texture_depth_2d;
@group(0) @binding(3) var shadowSamp: sampler_comparison;

fn fog_amount(dist: f32, height: f32, cap: f32) -> f32 {
  let df = 1.0 - exp(-max(dist, 0.0) * g.fog.w);
  let hf = g.fogP.x * exp(-max(height + 40.0, 0.0) * 0.035) * (0.4 + 0.6 * df);
  return clamp(df + hf * (1.0 - df), 0.0, cap);
}

fn apply_fog(color: vec3<f32>, dist: f32, height: f32, py: f32, cap: f32) -> vec3<f32> {
  var fogCol = g.fog.rgb;
  let df = 1.0 - exp(-max(dist, 0.0) * g.fog.w);
  let hf = g.fogP.x * exp(-max(height + 40.0, 0.0) * 0.035) * (0.4 + 0.6 * df);
  var f = clamp(df + hf * (1.0 - df), 0.0, cap);
  if (g.fogP.z > 0.5) {
    let band = floor(py / 24.0) + floor(g.time * 7.0);
    let h = fract(sin(band * 12.9898) * 43758.5453);
    if (h > 0.82) {
      fogCol = mix(fogCol, vec3<f32>(1.0 - h * 0.5, h, 1.0) * 0.5, 0.7);
      f = min(f + 0.12, cap);
    }
  }
  let lum = dot(color, vec3<f32>(0.299, 0.587, 0.114));
  let faded = mix(color, vec3<f32>(lum), f * 0.6);
  return mix(faded, fogCol, f);
}

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
  @location(3) dist: f32,
  @location(4) h: f32,
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
  o.dist=length(world)+v.depth*4.0;
  o.h=v.depth;
  return o;
}

@fragment fn fs(v: VOut) -> @location(0) vec4<f32> {
  let d=length(v.uv);
  if(d>1.0){discard;}
  let glow=pow(max(0.0,1.0-d),2.2);
  let ring=smoothstep(0.72,0.76,abs(sin(d*18.0+g.time*3.0)));
  let pulse=0.84+0.16*sin(g.time*5.0+v.kind*1.7);
  let col=v.color.rgb*(pulse+glow*0.65+ring*0.25);
  // player stays clear, warnings stay readable, silence zones barely fog, threats never fully vanish
  var k=1.0;
  if(v.kind>9.5){k=0.0;}
  else if(v.kind>8.5){k=0.5;}
  else if(v.kind>7.5){k=0.2;}
  else if(abs(v.kind-5.0)<0.5){k=0.25;}
  let fogged=apply_fog(col,v.dist,v.h,v.position.y,0.65);
  return vec4<f32>(mix(col,fogged,k),v.color.a);
}

// ---- ground shadows for dynamic entities (soft, projected along the light) ----
struct SOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) a: f32,
  @location(2) dist: f32,
  @location(3) len: f32,
};

@vertex fn blob_vs(v: VIn, @builtin(vertex_index) vi: u32) -> SOut {
  var o: SOut;
  let corners = array<vec2<f32>,6>(
    vec2<f32>(-1,-1),vec2<f32>(1,-1),vec2<f32>(-1,1),
    vec2<f32>(-1,1),vec2<f32>(1,-1),vec2<f32>(1,1)
  );
  let corner = corners[vi];
  let world = v.pos - g.camera;
  let hs = max(length(g.light.xz), 0.001);
  let dir = g.light.xz / hs;
  let perp = vec2<f32>(-dir.y, dir.x);
  let len = v.depth * hs / max(-g.light.y, 0.2);
  let along = v.radius * 0.95 + len * 0.5;
  let across = v.radius * 0.9;
  let centre = world + dir * (len * 0.5 + v.radius * 0.1);
  let pixel = centre + dir * corner.x * along + perp * corner.y * across;
  o.position = vec4<f32>(pixel.x / g.viewport.x * 2.0, -pixel.y / g.viewport.y * 2.0, 0.0, 1.0);
  o.uv = corner;
  o.a = v.color.a;
  o.dist = length(world);
  o.len = len;
  return o;
}

@fragment fn blob_fs(v: SOut) -> @location(0) vec4<f32> {
  let d = length(v.uv);
  if (d > 1.0) { discard; }
  let soft = 1.0 - smoothstep(0.15, 1.0, d);
  let longer = mix(1.0, 0.55, clamp(v.len / 220.0, 0.0, 1.0));
  let fogged = 1.0 - fog_amount(v.dist, 0.0, 0.65);
  let a = v.a * g.light.w * soft * soft * longer * fogged;
  return vec4<f32>(0.0, 0.0, 0.02, clamp(a, 0.0, 0.85));
}

// ---- shadow-map depth pass (terrain + props) ----
@vertex fn shadow_vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return lightU.vp * vec4<f32>(pos, 1.0);
}

fn shadow_factor(wpos: vec3<f32>, n: vec3<f32>) -> f32 {
  let lp = lightU.vp * vec4<f32>(wpos + n * 2.5, 1.0);
  let uv = vec2<f32>(lp.x * 0.5 + 0.5, -lp.y * 0.5 + 0.5);
  let z = lp.z - g.shadowP.y;
  let t = g.shadowP.x;
  var s = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      s += textureSampleCompareLevel(shadowTex, shadowSamp, uv + vec2<f32>(f32(i), f32(j)) * t, z);
    }
  }
  s = s / 9.0;
  let inside = f32(uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && lp.z > 0.0 && lp.z < 1.0);
  return mix(1.0, s, inside);
}

struct TVOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) height: f32,
  @location(3) dist: f32,
  @location(4) wpos: vec3<f32>,
};

@vertex fn terrain_vs(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>) -> TVOut {
  var o: TVOut;
  let rx=pos.x-g.camera.x;
  let z=pos.z;
  let p=clamp(g.focal/(g.focal+z),0.25,1.0);
  let y=-g.camera.y - z*0.20 - pos.y;   // height rises up the screen
  let pixel=vec2<f32>(rx*p,(y-g.horizon)*p+g.horizon);
  o.position=vec4<f32>(pixel.x/g.viewport.x*2.0,-pixel.y/g.viewport.y*2.0,clamp(z/2600.0,0.0,0.999),1.0);
  o.uv=pos.xz*0.002;
  o.normal=normal;
  o.height=pos.y;
  o.dist=pos.z*0.35+abs(rx)*0.25;
  o.wpos=pos;
  return o;
}

@fragment fn terrain_fs(v: TVOut) -> @location(0) vec4<f32> {
  let n=normalize(v.normal);
  let ndl=max(0.0,dot(n,-g.light.xyz));
  let sh=shadow_factor(v.wpos,n);
  let grid=0.5+0.5*sin(v.uv.x*40.0+g.time*0.2)*sin(v.uv.y*40.0);
  let pulse=0.75+g.intensity*0.55;
  let base=vec3<f32>(0.055+grid*0.035,0.07+grid*0.025,0.12+g.intensity*0.04);
  let direct=ndl*0.75*mix(1.0,sh,g.light.w);
  let ambient=0.45-0.18*g.light.w*(1.0-sh);
  let lit=base*(ambient+direct)*pulse;
  return vec4<f32>(apply_fog(lit,v.dist,v.height,v.position.y,0.97),1.0);
}
`;


const SHADOW_SIZE=1024, DEPTH_FORMAT='depth24plus', PROP_COUNT=44;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const fin=(x,d=0)=>Number.isFinite(x)?x:d;
const clamp01=x=>Math.min(1,Math.max(0,x));
const lerp=(a,b,k)=>a+(b-a)*k;
// density: per-pixel distance fog; height: ground-pooling fog; tint: accent mix into fog colour
const WORLD_FOG={
  'CALM MEADOW':  {density:0.0007,height:0.25,tint:0.10},
  'NEON CITY':    {density:0.0010,height:0.45,tint:0.22},
  'PAPER FOREST': {density:0.0009,height:0.35,tint:0.12},
  'CANDY PLAINS': {density:0.0008,height:0.20,tint:0.25},
  'VOID GARDEN':  {density:0.0013,height:0.60,tint:0.05},
  'GLITCH DESERT':{density:0.0006,height:0.10,tint:0.18},
  default:         {density:0.0008,height:0.30,tint:0.15}
};

export class EchoVoidWebGPU {
  constructor(canvas){
    this.canvas=canvas; this.device=null; this.context=null;
    this.pipeline=null; this.terrainPipeline=null; this.uniformBuffer=null;
    this.uniformBindGroup=null; this.instanceBuffer=null; this.instanceCapacity=0;
    this.terrainBuffer=null; this.terrainVertexCount=0; this.depthTexture=null;
    this.fogState=null; this._lastT=0;
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

    const dev=this.device, module=dev.createShaderModule({code:WGSL});
    const VF=GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT;
    const bglMain=dev.createBindGroupLayout({entries:[
      {binding:0,visibility:VF,buffer:{type:'uniform'}},
      {binding:1,visibility:VF,buffer:{type:'uniform'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'comparison'}}
    ]});
    const bglShadow=dev.createBindGroupLayout({entries:[
      {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'uniform'}}
    ]});
    const layoutMain=dev.createPipelineLayout({bindGroupLayouts:[bglMain]});
    const layoutShadow=dev.createPipelineLayout({bindGroupLayouts:[bglShadow]});
    const instanceLayout={
      arrayStride:36,stepMode:'instance',attributes:[
        {shaderLocation:0,offset:0,format:'float32x2'},
        {shaderLocation:1,offset:8,format:'float32'},
        {shaderLocation:2,offset:12,format:'float32x4'},
        {shaderLocation:3,offset:28,format:'float32'},
        {shaderLocation:4,offset:32,format:'float32'}
      ]};
    const overlayDepth={format:DEPTH_FORMAT,depthWriteEnabled:false,depthCompare:'always'};
    const alphaBlend={
      color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
      alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}
    };
    this.pipeline=dev.createRenderPipeline({
      layout:layoutMain,
      vertex:{module,entryPoint:'vs',buffers:[instanceLayout]},
      fragment:{module,entryPoint:'fs',targets:[{format}]},
      primitive:{topology:'triangle-list'},depthStencil:overlayDepth
    });
    this.blobPipeline=dev.createRenderPipeline({
      layout:layoutMain,
      vertex:{module,entryPoint:'blob_vs',buffers:[instanceLayout]},
      fragment:{module,entryPoint:'blob_fs',targets:[{format,blend:alphaBlend}]},
      primitive:{topology:'triangle-list'},depthStencil:overlayDepth
    });
    this.terrainPipeline=dev.createRenderPipeline({
      layout:layoutMain,
      vertex:{module,entryPoint:'terrain_vs',buffers:[{
        arrayStride:24,stepMode:'vertex',attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},
          {shaderLocation:1,offset:12,format:'float32x3'}
        ]
      }]},
      fragment:{module,entryPoint:'terrain_fs',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:DEPTH_FORMAT,depthWriteEnabled:true,depthCompare:'less'}
    });
    this.shadowPipeline=dev.createRenderPipeline({
      layout:layoutShadow,
      vertex:{module,entryPoint:'shadow_vs',buffers:[{
        arrayStride:24,stepMode:'vertex',attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]
      }]},
      primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:2}
    });

    this.uniformBuffer=dev.createBuffer({size:96,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.lightBuffer=dev.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.shadowTexture=dev.createTexture({
      size:[SHADOW_SIZE,SHADOW_SIZE],format:'depth32float',
      usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING
    });
    this.shadowView=this.shadowTexture.createView();
    this.shadowSampler=dev.createSampler({compare:'less-equal',magFilter:'linear',minFilter:'linear'});
    this.mainBindGroup=dev.createBindGroup({layout:bglMain,entries:[
      {binding:0,resource:{buffer:this.uniformBuffer}},
      {binding:1,resource:{buffer:this.lightBuffer}},
      {binding:2,resource:this.shadowView},
      {binding:3,resource:this.shadowSampler}
    ]});
    this.shadowBindGroup=dev.createBindGroup({layout:bglShadow,entries:[
      {binding:1,resource:{buffer:this.lightBuffer}}
    ]});
    this.uniformBindGroup=this.terrainBindGroup=this.mainBindGroup;

    this.buildTerrain();
    this.ready=true; this.resize(); return true;
  }

  buildTerrain(seed=849201){
    this.worldSeed=seed>>>0;
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
    this.addProps(verts,height,this.worldSeed);
    this.terrainVertexCount=verts.length/6;
    this.terrainBuffer=this.device.createBuffer({
      size:verts.length*4,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.terrainBuffer,0,new Float32Array(verts));
  }

  // Procedural crystal monoliths: deterministic from the world seed, flat-shaded, real shadow casters.
  addProps(verts,height,seed){
    const rnd=mulberry32(seed^0x9e3779b9);
    const tri=(a,b,c)=>{
      const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
      let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
      const l=Math.hypot(nx,ny,nz)||1; nx/=l;ny/=l;nz/=l;
      if(ny<0){nx=-nx;ny=-ny;nz=-nz;}   // keep normals pointing up/out for lighting
      for(const p of [a,b,c]) verts.push(p[0],p[1],p[2],nx,ny,nz);
    };
    for(let i=0;i<PROP_COUNT;i++){
      const x=(rnd()*2-1)*1000, z=120+Math.pow(rnd(),1.6)*1900;   // denser near the camera
      const sz=16+rnd()*18, H=110+rnd()*170, skew=(rnd()*2-1)*8;
      const y0=height(x,z)-3, ts=sz*0.5, yMid=y0+H*0.7, yTop=y0+H;
      const base=[[x-sz,y0,z-sz],[x+sz,y0,z-sz],[x+sz,y0,z+sz],[x-sz,y0,z+sz]];
      const mid=[[x-ts+skew,yMid,z-ts],[x+ts+skew,yMid,z-ts],[x+ts+skew,yMid,z+ts],[x-ts+skew,yMid,z+ts]];
      const apex=[x+skew*1.5,yTop,z];
      for(let k=0;k<4;k++){
        const k2=(k+1)%4;
        tri(base[k],base[k2],mid[k2]); tri(base[k],mid[k2],mid[k]);
        tri(mid[k],mid[k2],apex);
      }
    }
  }

  updateFog(state){
    const t=fin(state.time), dt=Math.min(Math.max(t-this._lastT,0),0.1); this._lastT=t;
    const bass=clamp01(fin(state.bass)), treble=clamp01(fin(state.treble)), beat=clamp01(fin(state.beat));
    const inten=clamp01(fin(state.intensity)), silence=clamp01(fin(state.silence));
    const wf=WORLD_FOG[state.worldName]||WORLD_FOG.default;
    const glitch=state.visualMode===4?1:0, voidMode=state.visualMode===5?1:0;
    const bg=state.bg, ac=state.accentRgb;

    // target colour: world colour lifted + accent tint, pushed by bass (warm) / treble (cold)
    const col=[0,1,2].map(i=>clamp01(bg[i]*1.5+ac[i]*wf.tint));
    col[0]+=bass*0.10; col[2]+=treble*0.10;
    for(let i=0;i<3;i++){
      col[i]=col[i]*(1-silence*0.55);              // silence: dark, empty
      if(voidMode) col[i]*=0.25;                   // void: near-black fog
      col[i]=clamp01(col[i]);
    }
    // density: music thickens fog, beat pulses it, treble thins it, silence clears it
    let density=wf.density*(1+bass*0.9+inten*0.5+beat*0.25)*(1-treble*0.15);
    density*=1-silence*0.8;
    if(voidMode) density*=1.5;
    const height=wf.height*(voidMode?1.6:1)*(1-silence*0.6);

    const target={color:col,density,height,silence,glitch,void:voidMode};
    if(!this.fogState){ this.fogState=JSON.parse(JSON.stringify(target)); }
    const f=this.fogState, kSlow=1-Math.exp(-dt*3), kFast=1-Math.exp(-dt*7);
    for(let i=0;i<3;i++) f.color[i]=lerp(f.color[i],target.color[i],kSlow);
    f.density=lerp(f.density,target.density,kFast);
    f.height=lerp(f.height,target.height,kSlow);
    f.silence=lerp(f.silence,target.silence,kSlow);
    f.glitch=glitch; f.void=voidMode;
    return {color:f.color.map(fin),density:fin(f.density,0.001),height:fin(f.height),silence:fin(f.silence),glitch,void:voidMode};
  }

  updateShadow(state,dt){
    const bass=clamp01(fin(state.bass)), inten=clamp01(fin(state.intensity)), silence=clamp01(fin(state.silence)), t=fin(state.time);
    const sh=this.shadowState||(this.shadowState={swing:bass,elev:0.95,strength:0.6});
    const k=1-Math.exp(-dt*2.5);
    sh.swing=lerp(sh.swing,bass,k);                         // bass swings the light around
    sh.elev=lerp(sh.elev,0.95-0.30*inten,k);                // intensity lowers the light: longer shadows
    const target=clamp01(0.55+0.30*bass+0.15*inten)*(1-0.75*silence);   // silence: almost no dynamic light
    sh.strength=lerp(sh.strength,target,1-Math.exp(-dt*5));
    const phi=Math.atan2(0.55,-0.35)+0.5*sh.swing+0.06*Math.sin(t*0.13);
    const ce=Math.cos(sh.elev);
    const L=[ce*Math.cos(phi),-Math.sin(sh.elev),ce*Math.sin(phi)];

    // orthographic light matrix (column-major) covering the terrain
    const C=[0,0,1200], D=3000, HALF=1800, FAR=6000;
    const eye=[C[0]-L[0]*D,C[1]-L[1]*D,C[2]-L[2]*D];
    const norm=v=>{const l=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/l,v[1]/l,v[2]/l]};
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const right=norm(cross(L,[0,0,1])), up=cross(right,L);
    const r0=[right[0]/HALF,right[1]/HALF,right[2]/HALF,-dot(right,eye)/HALF];
    const r1=[up[0]/HALF,up[1]/HALF,up[2]/HALF,-dot(up,eye)/HALF];
    const r2=[L[0]/FAR,L[1]/FAR,L[2]/FAR,-dot(L,eye)/FAR];
    const vp=new Float32Array([
      r0[0],r1[0],r2[0],0,  r0[1],r1[1],r2[1],0,  r0[2],r1[2],r2[2],0,  r0[3],r1[3],r2[3],1
    ]);
    return {L:L.map(fin),strength:fin(sh.strength),vp};
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

  ensureDepth(){
    const w=this.canvas.width,h=this.canvas.height;
    if(this.depthTexture&&this._dw===w&&this._dh===h)return;
    this.depthTexture?.destroy();
    this.depthTexture=this.device.createTexture({size:[w,h],format:DEPTH_FORMAT,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    this.depthView=this.depthTexture.createView(); this._dw=w; this._dh=h;
  }

  render(state){
    if(!this.ready)return;
    const dpr=Math.min(devicePixelRatio||1,2),w=this.canvas.width/dpr,h=this.canvas.height/dpr;
    const ents=[], shadows=[];
    const add=(x,y,r,c,k=0,z=0)=>ents.push(x,y,r,c[0],c[1],c[2],c[3],k,z);
    const cast=(x,y,r,strength,height)=>shadows.push(x,y,r,0,0,0,strength,0,height);
    const ac=state.accentRgb;
    for(const z of state.safeZones){
      add(z.x,z.y,z.r,[.25,1,.78,.20],5,40);
      add(z.x,z.y,z.r*.62,[.25,1,.78,.10],5,35);
    }
    if(state.boss){add(state.boss.x,state.boss.y,state.boss.r,[ac[0],ac[1],ac[2],1],9,20);cast(state.boss.x,state.boss.y,state.boss.r,0.65,state.boss.r*1.2)}
    for(const m of state.monsters){
      const c=m.type==='BASS'?[1,.25,.32,1]:m.type==='TREBLE'?[.45,.55,1,1]:m.type==='VOCAL'?[1,.35,.75,1]:[.55,1,.8,1];
      add(m.x,m.y,m.r,c,m.type==='BASS'?1:m.type==='TREBLE'?2:m.type==='VOCAL'?3:4,12);
      cast(m.x,m.y,m.r,0.6,m.r*1.8);
      if(m.state==='telegraph')add(m.x,m.y,m.r*1.55,[1,1,1,.65],8,8);
    }
    add(state.player.x,state.player.y,state.player.r,[.94,.97,1,1],10,0);
    cast(state.player.x,state.player.y,state.player.r,0.7,state.player.r*2.0);

    const nS=shadows.length/9, nE=ents.length/9;
    this.ensureCapacity(nS+nE);
    this.ensureDepth();
    const fog=this.updateFog(state);
    const dt=Math.min(Math.max(fin(state.time)-(this._lastShadowT??fin(state.time)),0),0.1); this._lastShadowT=fin(state.time);
    const sh=this.updateShadow(state,dt);
    const globals=new Float32Array([
      w,h,fin(state.player.x),fin(state.player.y),fin(state.time),fin(state.intensity),520,h*.58,
      fog.color[0],fog.color[1],fog.color[2],fog.density,
      fog.height,fog.silence,fog.glitch,fog.void,
      sh.L[0],sh.L[1],sh.L[2],sh.strength,
      1/SHADOW_SIZE,0.0008,0,0
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer,0,globals);
    this.device.queue.writeBuffer(this.lightBuffer,0,sh.vp);
    this.device.queue.writeBuffer(this.instanceBuffer,0,new Float32Array([...shadows,...ents]));

    const encoder=this.device.createCommandEncoder();
    // 1) shadow map: depth-only pass from the light (terrain + props)
    const sp=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{
      view:this.shadowView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
    sp.setPipeline(this.shadowPipeline);
    sp.setBindGroup(0,this.shadowBindGroup);
    sp.setVertexBuffer(0,this.terrainBuffer);
    sp.draw(this.terrainVertexCount);
    sp.end();
    // 2) main pass
    const pass=encoder.beginRenderPass({
      colorAttachments:[{
        view:this.context.getCurrentTexture().createView(),
        clearValue:{r:fog.color[0],g:fog.color[1],b:fog.color[2],a:1},
        loadOp:'clear',storeOp:'store'
      }],
      depthStencilAttachment:{view:this.depthView,depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'discard'}
    });
    pass.setBindGroup(0,this.mainBindGroup);
    pass.setPipeline(this.terrainPipeline);
    pass.setVertexBuffer(0,this.terrainBuffer);
    pass.draw(this.terrainVertexCount);
    pass.setVertexBuffer(0,this.instanceBuffer);
    if(nS>0){
      pass.setPipeline(this.blobPipeline);
      pass.draw(6,nS,0,0);
    }
    pass.setPipeline(this.pipeline);
    pass.draw(6,nE,0,nS);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}

export function hexRgb(hex){
  const n=parseInt(hex.replace('#',''),16);
  return [((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255];
}
