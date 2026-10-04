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
        Self {
            rng: SmallRng::seed_from_u64(seed as u64),
            monsters: Vec::new(),
            next_id: 1,
            mutation: 0,
        }
    }

    /// Deterministically creates a compact world descriptor from a seed.
    /// biome/style/weather are intentionally numeric so the renderer can map them to
    /// radically different visual themes without putting rendering logic in WASM.
    pub fn generate_world(&mut self, seed: u32, biome: u8, style: u8, weather: u8) -> JsValue {
        let mut rng = SmallRng::seed_from_u64(seed as u64);
        let count = 36 + (seed % 20) as usize;
        let mut props = Vec::with_capacity(count);
        for id in 0..count as u32 {
            let angle = rng.random_range(0.0..std::f32::consts::TAU);
            let radius = rng.random_range(180.0..1150.0);
            let x = angle.cos() * radius + rng.random_range(-90.0..90.0);
            let y = angle.sin() * radius + rng.random_range(-70.0..70.0);
            let depth = rng.random_range(20.0..1500.0);
            props.push(WorldProp {
                id,
                x,
                y,
                scale: rng.random_range(0.65..1.75),
                rotation: rng.random_range(0.0..std::f32::consts::TAU),
                kind: rng.random_range(0..8),
                depth,
            });
        }
        let frame = WorldFrame { seed, biome: biome % 8, style: style % 8, weather: weather % 8, props };
        serde_wasm_bindgen::to_value(&frame).unwrap()
    }

    pub fn spawn(&mut self, x: f32, y: f32, sound_kind: u8, entry: u8, intensity: f32) -> u32 {
        let radius = 12.0 + self.rng.random_range(0.0..12.0) + self.mutation as f32 * 2.0;
        let speed = 55.0 + intensity * 120.0 + self.mutation as f32 * 15.0;
        let id = self.next_id;
        self.next_id += 1;
        self.monsters.push(Monster {
            id, x, y, radius, kind: sound_kind, state: entry,
            health: 1.0 + self.mutation as f32 * 0.35,
            speed, phase: self.rng.random_range(0.0..6.283),
        });
        id
    }

    pub fn set_mutation(&mut self, level: u8) {
        self.mutation = level.min(3);
        for m in &mut self.monsters {
            m.radius += 1.5;
            m.speed += 8.0;
            m.health += 0.15;
        }
    }

    pub fn tick(&mut self, dt: f32, px: f32, py: f32, intensity: f32, hidden: bool) -> JsValue {
        let danger = intensity.clamp(0.0, 1.0);
        if !hidden {
            for m in &mut self.monsters {
                let dx = px - m.x;
                let dy = py - m.y;
                let len = (dx * dx + dy * dy).sqrt().max(0.001);
                let mut speed = m.speed * (0.75 + danger * 0.65);
                if m.kind == 1 { speed *= 1.35; }
                if m.kind == 2 { speed *= 0.85; }
                if m.kind == 3 { speed *= 1.05; }
                m.x += dx / len * speed * dt;
                m.y += dy / len * speed * dt;
                m.phase += dt * (2.0 + danger * 5.0);
            }
        }
        self.monsters.retain(|m| {
            let dx = m.x - px;
            let dy = m.y - py;
            dx * dx + dy * dy < 3000.0 * 3000.0 && m.health > 0.0
        });
        let frame = Frame {
            monsters: self.monsters.clone(),
            intensity: danger,
            danger: danger * (1.0 + self.mutation as f32 * 0.18),
            mutation: self.mutation,
        };
        serde_wasm_bindgen::to_value(&frame).unwrap()
    }

    pub fn damage(&mut self, id: u32, amount: f32) {
        if let Some(m) = self.monsters.iter_mut().find(|m| m.id == id) {
            m.health -= amount.max(0.0);
        }
    }

    pub fn clear(&mut self) {
        self.monsters.clear();
    }
}
