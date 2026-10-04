use rand::{rngs::SmallRng, Rng, SeedableRng};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monster {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub radius: f32,
    pub kind: u8,
    pub state: u8,
    pub health: f32,
    pub speed: f32,
    pub phase: f32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldProp {
    pub id: u32,
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub rotation: f32,
    pub kind: u8,
    pub depth: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldFrame {
    pub seed: u32,
    pub biome: u8,
    pub style: u8,
    pub weather: u8,
    pub props: Vec<WorldProp>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub monsters: Vec<Monster>,
    pub intensity: f32,
    pub danger: f32,
    pub mutation: u8,
    pub player_damage: f32,
    pub knockback_x: f32,
    pub knockback_y: f32,
    pub hit_count: u32,
}

#[wasm_bindgen]
pub struct EchoVoidCore {
    rng: SmallRng,
    monsters: Vec<Monster>,
    next_id: u32,
    mutation: u8,
}

#[wasm_bindgen]
impl EchoVoidCore {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32) -> Self {
        Self { rng: SmallRng::seed_from_u64(seed as u64), monsters: Vec::new(), next_id: 1, mutation: 0 }
    }

    pub fn generate_world(&mut self, seed: u32, biome: u8, style: u8, weather: u8) -> JsValue {
        let mut rng = SmallRng::seed_from_u64(seed as u64);
        let count = 36 + (seed % 20) as usize;
        let mut props = Vec::with_capacity(count);
        for id in 0..count as u32 {
            let angle = rng.random_range(0.0..std::f32::consts::TAU);
            let radius = rng.random_range(180.0..1150.0);
            props.push(WorldProp { id, x: angle.cos()*radius+rng.random_range(-90.0..90.0), y: angle.sin()*radius+rng.random_range(-70.0..70.0), scale: rng.random_range(0.65..1.75), rotation: rng.random_range(0.0..std::f32::consts::TAU), kind: rng.random_range(0..8), depth: rng.random_range(20.0..1500.0) });
        }
        serde_wasm_bindgen::to_value(&WorldFrame { seed, biome: biome%8, style: style%8, weather: weather%8, props }).unwrap()
    }

    pub fn spawn(&mut self, x: f32, y: f32, sound_kind: u8, entry: u8, intensity: f32) -> u32 {
        let radius = 12.0 + self.rng.random_range(0.0..12.0) + self.mutation as f32 * 2.0;
        let speed = 55.0 + intensity * 120.0 + self.mutation as f32 * 15.0;
        let id = self.next_id; self.next_id += 1;
        self.monsters.push(Monster { id, x, y, radius, kind: sound_kind, state: entry, health: 1.0+self.mutation as f32*.35, speed, phase: self.rng.random_range(0.0..6.283) });
        id
    }

    pub fn set_mutation(&mut self, level: u8) {
        self.mutation=level.min(3);
        for m in &mut self.monsters { m.radius+=1.5; m.speed+=8.0; m.health+=0.15; }
    }

    pub fn tick(&mut self, dt: f32, px: f32, py: f32, intensity: f32, hidden: bool) -> JsValue {
        let danger=intensity.clamp(0.0,1.0);
        let mut player_damage=0.0; let mut knockback_x=0.0; let mut knockback_y=0.0; let mut hit_count=0;
        for m in &mut self.monsters {
            let dx=px-m.x; let dy=py-m.y; let len=(dx*dx+dy*dy).sqrt().max(0.001);
            let nx=dx/len; let ny=dy/len;
            let mut vx=nx*m.speed*(0.7+danger*.7); let mut vy=ny*m.speed*(0.7+danger*.7);
            match m.kind {
                // BASS CHARGER: circles briefly, then commits to a fast charge.
                1 => {
                    let charge=((m.phase.sin()+1.0)*0.5);
                    let side=if m.phase.sin()>0.0 {1.0} else {-1.0};
                    vx=nx*m.speed*(1.0+charge*1.8)+(-ny)*side*m.speed*.28;
                    vy=ny*m.speed*(1.0+charge*1.8)+( nx)*side*m.speed*.28;
                    m.phase+=dt*(1.5+danger*3.5);
                    m.state=if charge>.78 {5} else {m.state};
                }
                // TREBLE STALKER: strafes/orbits instead of running directly at the player.
                2 => {
                    let side=if m.phase.sin()>0.0 {1.0} else {-1.0};
                    vx=nx*m.speed*.52 + (-ny)*side*m.speed*.92;
                    vy=ny*m.speed*.52 + ( nx)*side*m.speed*.92;
                    m.phase+=dt*(3.0+danger*6.0);
                    m.state=4;
                }
                // VOCAL EATER: approaches slowly, then lunges when close.
                3 => {
                    let lunge=if len<230.0 {2.2} else {0.72};
                    vx=nx*m.speed*lunge; vy=ny*m.speed*lunge;
                    m.phase+=dt*(1.2+danger*2.0);
                    m.state=if len<230.0 {6} else {m.state};
                }
                // RHYTHM HUNTER: predicts the player's movement and intercepts.
                _ => {
                    let lead=(90.0+danger*150.0)/m.speed.max(1.0);
                    let tx=px+nx*m.speed*lead; let ty=py+ny*m.speed*lead;
                    let txd=tx-m.x; let tyd=ty-m.y; let tl=(txd*txd+tyd*tyd).sqrt().max(.001);
                    vx=txd/tl*m.speed*1.12; vy=tyd/tl*m.speed*1.12;
                    m.phase+=dt*(2.0+danger*4.0);
                    m.state=7;
                }
            }
            if m.state==3 { vx*=0.18; vy*=0.18; }
            m.x+=vx*dt; m.y+=vy*dt;
            let collision=m.radius+16.0;
            if !hidden && len<=collision {
                let damage=match m.kind {1=>.035,2=>.055,3=>.075,_=>.045}*(.7+danger*.9);
                player_damage+=damage; knockback_x+=nx*(80.0+danger*70.0); knockback_y+=ny*(80.0+danger*70.0); hit_count+=1;
            }
        }
        self.monsters.retain(|m| { let dx=m.x-px; let dy=m.y-py; dx*dx+dy*dy<3000.0*3000.0 && m.health>0.0 });
        serde_wasm_bindgen::to_value(&Frame { monsters:self.monsters.clone(), intensity:danger, danger:danger*(1.0+self.mutation as f32*.18), mutation:self.mutation, player_damage, knockback_x, knockback_y, hit_count }).unwrap()
    }

    pub fn damage(&mut self,id:u32,amount:f32){ if let Some(m)=self.monsters.iter_mut().find(|m|m.id==id){m.health-=amount.max(0.0);m.state=3;} }
    pub fn attack(&mut self,px:f32,py:f32,radius:f32,damage:f32)->u32{ let r=radius.max(1.0);let dmg=damage.max(0.0);let mut hits=0;for m in &mut self.monsters{let dx=m.x-px;let dy=m.y-py;if dx*dx+dy*dy<=(r+m.radius)*(r+m.radius){m.health-=dmg;m.state=3;hits+=1;}}hits }
    pub fn clear(&mut self){self.monsters.clear();}
}
