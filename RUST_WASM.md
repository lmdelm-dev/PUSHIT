# ECHO//VOID Rust/WASM Core

The game keeps browser-facing audio/file handling in JavaScript, while the heavy simulation moves into Rust/WASM.

## Core responsibilities
- Monster ECS-like state storage
- Sound-born monster types
- Mutation scaling
- Movement simulation
- Damage/despawn
- Deterministic seeded spawning

The renderer can remain Canvas/WebGL/WebGPU while Rust owns gameplay simulation.

## Build
`wasm-pack build --target web --release`

The generated `pkg/` folder is intentionally a build artifact and is produced by CI.
