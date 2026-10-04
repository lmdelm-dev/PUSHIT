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
