# OrbitForge — Design & Architecture Plan

> A KSP-style rocket construction & spaceflight simulator with real orbital mechanics
> and high-fidelity atmospheric/planetary rendering.
> **Stack:** TypeScript + Three.js (WebGPU renderer) · **Physics:** patched-conic (KSP-style) · **Target:** desktop browsers (WebGPU), Chrome/Edge/Safari TP.

---

## 0. Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Rendering | **Three.js WebGPU (TSL shaders)** | Fastest iteration, f64 math native to JS, WebGPU compute for terrain/clouds. |
| Physics regime | **Patched conics, single-body gravity** | Stable, time-warpable, playable — what KSP ships. |
| Integrator | **RK4 (atmosphere) + analytic Kepler (space)** | Accuracy near bodies, cheap propagation for orbits/time-warp. |
| Precision | **f64 simulation, floating origin, f32 render** | Kills coordinate jitter at planetary scale. |
| Physics engine | **Custom flight model.** No Rapier/PhysX for flight. | Contact solvers are numerically wrong for orbits/multi-scale. Rapier only for construction collision + debris. |

**Highest-risk area:** planetary surface rendering (terrain + volumetric clouds + vegetation). Budget most of the schedule risk here. Everything else is well-trodden.

---

## 1. The visual target (the hard part)

Goal: standing on the launchpad, ascending through cloud layers, and descending to land on another world should all look *good* — not low-poly, not flat-shaded. Broken into subsystems by difficulty:

### 1.1 Atmospheric scattering — *medium risk, do early*
- **Bruneton precomputed multi-scattering** model (Rayleigh + Mie + ozone). Precompute transmittance/scattering LUTs once per body into 2D/3D textures via a compute pass; sample per-frame.
- Drives sky color, horizon glow, sunset reddening, aerial perspective (distant terrain fades into haze), and the blue limb seen from orbit.
- Per-body params: planet radius, atmosphere height, Rayleigh/Mie scale heights, scattering coefficients, sun intensity/color, ground albedo. A red thin-atmosphere world reuses the same shader with different constants.
- **Space↔surface continuity:** one scattering model serves both. From orbit you see the limb; descending, the same LUTs give correct in-atmosphere fog. No seam.

### 1.2 Volumetric clouds — *high risk, biggest visual payoff*
- **Raymarched volumetric layer** (the Horizon/Nubis approach), rendered at half or quarter res into a buffer, then upsampled + temporally reprojected (TAA-style) to keep it affordable.
- **Density field:** low-freq Perlin-Worley base shape × high-freq Worley erosion detail, modulated by a 2D **weather map** (coverage, cloud type, precipitation) and a vertical **height-gradient** (stratus low/flat vs cumulus tall/billowy).
- **Lighting:** Beer–Powder law for light attenuation, Henyey-Greenstein phase for forward silver-lining scatter, plus cheap multi-scatter approximation. This is what sells "puffy 3D clouds lit by the sun," not sprites.
- **Cost control:** adaptive step count, early-out on opacity, blue-noise ray offset to hide banding, temporal accumulation across frames. This is the subsystem most likely to blow the frame budget — it gets its own perf pass.
- Renders correctly whether you fly *under*, *through*, or *above* the layer (key for launch/reentry).

### 1.3 Planetary terrain — *high risk*
- **Quadtree sphere (CDLOD / chunked LOD):** cube-sphere mapped to the body; subdivide chunks near the camera, coarsen far away, with morphing between levels to prevent popping.
- **Heightfield from GPU noise** (ridged multifractal + domain warping) evaluated in a compute shader → displacement + on-the-fly normal derivation. Deterministic from a seed so terrain is reproducible and streamable.
- **Texturing:** triplanar mapping (no UV stretch on cliffs) + slope/altitude-based material blending (rock on steep, regolith/grass on flat, snow up high) + detail/normal maps at close range.
- **Floating origin** applied here too — chunk positions are camera-relative to stay in f32 precision.
- Start with textured spheres (milestone 1), swap in real LOD terrain at milestone 5. Don't let terrain block flight physics.

### 1.4 Vegetation / ground scatter ("shrubbery") — *medium risk, homeworld only*
- **GPU instancing** of grass/shrub/rock meshes scattered across near terrain chunks, positioned by a density map (respecting slope/altitude/biome). Tens of thousands of instances via one draw call per type.
- **LOD chain:** full mesh up close → billboard/impostor at mid → nothing far. Grass fades to a ground detail-texture at distance so there's no hard cutoff.
- **Wind:** vertex animation from a scrolling noise field for subtle motion.
- Homeworld surface only initially; other bodies get rock scatter, not foliage (they're airless/barren, which is also physically right).

### 1.5 Everything-else render stack
- HDR linear pipeline, ACES tonemap, physically-based sun.
- **Logarithmic depth buffer** — mandatory at these scales or z-fighting destroys everything.
- Bloom, motion blur (engine plumes, reentry), screen-space AO on close geometry.
- Starfield skybox (real star catalog optional), sun as a disk with bloom.
- Engine exhaust: additive plume + heat-haze distortion; reentry: fresnel-driven glowing heat shield + ionization trail.

---

## 2. Physics architecture

### 2.1 Regimes (a state machine per vessel)
1. **Landed / pre-launch** — clamped to surface, gravity + normal force.
2. **Powered atmospheric flight** — RK4, full force model (thrust, gravity, drag, lift, control torque).
3. **Coasting in vacuum** — analytic Keplerian propagation; no per-step integration.
4. **On rails (inactive vessels / time-warp)** — pure Kepler, orbit frozen as elements.

Transitions: atmosphere boundary (regime 2↔3), SOI crossing (re-parent frame), physics-warp threshold.

### 2.2 Patched conics + SOI
- Vessel feels **one** body's gravity: the current sphere-of-influence owner.
- SOI radius `r_soi = a · (m_body / m_parent)^(2/5)`.
- On boundary crossing → **re-parent reference frame**, convert state vectors into the new body's frame. This single mechanic is the backbone of the whole space sim; get it exactly right first.
- Orbits stored as **Keplerian elements** (a, e, i, Ω, ω, ν) → draw as analytic ellipses, propagate by solving Kepler's equation (Newton iteration on eccentric anomaly), time-warp arbitrarily without stepping.

### 2.3 Rocketry equations
- Ideal Δv (Tsiolkovsky): `Δv = Isp · g₀ · ln(m_wet / m_dry)`
- Thrust: `F = ṁ · v_e`, Isp interpolated between sea-level and vacuum curves by ambient pressure.
- TWR: `F_total / (m · g_local)`.
- Atmosphere: density `ρ = ρ₀ · exp(-h / H)`; drag `F_d = ½ ρ v² C_d A`; dynamic pressure Q for structural/heating limits.
- Reentry heating ∝ `ρ · v³` → heat-shield ablation + failure model.

### 2.4 Numerical hygiene
- **f64** for all simulation state (JS numbers are f64 — free win).
- **Floating origin:** recenter world on active vessel each frame; render in f32.
- Symplectic option (semi-implicit Euler) available for long-term stability comparison vs RK4.
- Fixed physics timestep with accumulator, decoupled from render framerate.

---

## 3. Parts & vessel model (data-driven)

Every part is a **config object**, not a subclass. Moddable via JSON, testable in isolation.

```
Part {
  id, category, mass_dry, drag_coef, attach_nodes[],
  // category-specific:
  engine?:   { thrust_vac, thrust_sl, isp_vac, isp_sl, gimbal_deg, mass_flow, fuel_type }
  tank?:     { capacity, resource, dry_mass }
  command?:  { torque, crew, electric_draw, has_reaction_wheel }
  aero?:     { lift_coef, is_control_surface, deflection }
  deploy?:   { type: parachute|leg|solar|fairing, drag_deployed }
}
```

Three graphs on top of the parts:
- **Attachment tree** — parent/child, snap nodes, symmetry (2×/3×/4×/radial mirror).
- **Resource-flow graph** — which tanks feed which engines; recomputed as tanks drain and stages drop. *Separate from geometry — the most under-estimated system.*
- **Staging sequence** — ordered list of activation groups.

Vessel = aggregate: total mass, CoM, moment of inertia, per-stage Δv/TWR — all recomputed live in the editor.

---

## 4. Celestial bodies (data)

```
Body {
  name, mass (→ μ = G·M), radius, rotationPeriod, axialTilt,
  parent, orbit: Keplerian elements,
  soiRadius,
  atmosphere?: { height, scaleHeight, seaLevelPressure, rayleigh[3], mie, ozone },
  surface: { seed, noiseParams, biomes[], hasVegetation },
  clouds?: { layers[], weatherSeed }
}
```

Vertical-slice system: **Homeworld** (Kerbin-like, atmosphere + clouds + vegetation), **Moon** (airless, rock scatter), one **outer planet** + its moon for transfers. Four bodies is enough to prove everything.

---

## 5. Project structure

```
OrbitForge/
├─ src/
│  ├─ sim/
│  │  ├─ integrator.ts        # RK4, symplectic
│  │  ├─ orbit.ts             # Kepler solve, elements <-> state vectors
│  │  ├─ soi.ts               # patched conics, frame re-parenting
│  │  ├─ forces.ts            # gravity, drag, lift, thrust
│  │  ├─ regimes.ts           # per-vessel state machine
│  │  └─ vessel.ts            # mass/CoM/inertia aggregation
│  ├─ parts/
│  │  ├─ registry.ts          # load part configs
│  │  ├─ attachment.ts        # tree + symmetry
│  │  ├─ resources.ts         # fuel-flow graph
│  │  └─ staging.ts
│  ├─ bodies/
│  │  ├─ registry.ts
│  │  └─ system.json          # the star system definition
│  ├─ render/
│  │  ├─ renderer.ts          # WebGPU setup, log-depth, HDR pipeline
│  │  ├─ atmosphere/          # Bruneton LUTs + sky/aerial shaders (TSL)
│  │  ├─ clouds/              # raymarch volumetrics + weather map
│  │  ├─ terrain/             # cube-sphere quadtree LOD + noise compute
│  │  ├─ vegetation/          # instanced scatter + LOD/impostors
│  │  ├─ floatingOrigin.ts
│  │  └─ postfx.ts            # bloom, AO, tonemap, plume/reentry FX
│  ├─ editor/                 # VAB construction UI, part placement, staging
│  ├─ flight/                 # HUD, navball, orbit map, time-warp controls
│  ├─ ui/                     # React (or lit) overlay
│  └─ main.ts
├─ assets/                    # part meshes, textures, noise, star catalog
├─ tests/                     # sim unit tests (orbits, Δv, SOI) — must be deterministic
└─ docs/PLAN.md
```

Keep files 200–400 lines. `sim/` and `parts/` are pure TypeScript with **zero Three.js imports** — that's what makes the physics unit-testable in isolation.

---

## 6. Testing strategy

Physics is deterministic → test it hard (targets your 80% floor where it matters most):
- **Orbit round-trips:** elements → state vectors → elements returns the same orbit.
- **Energy conservation:** circular orbit holds `a`, `e` over N periods within tolerance.
- **Tsiolkovsky:** known stage → expected Δv.
- **SOI crossing:** state continuity across frame re-parenting (no velocity discontinuity).
- **Kepler solver:** converges across full eccentricity range incl. near-parabolic.
- Rendering: visual regression via screenshot diffs on fixed camera setups (best-effort, not unit-tested).

---

## 7. Milestones

| # | Milestone | Proves | Visual bar |
|---|---|---|---|
| **1** | ✅ **Physics vertical slice** — hardcoded 2-stage rocket, RK4, one planet + gravity + atmosphere. Launch → gravity turn → orbit. | The integrator and force model are correct. | Textured sphere + skybox. Ugly on purpose. |
| **2** | ✅ **Orbital regime** — on-rails Kepler propagation, two-tier time-warp, orbit-line rendering, map view. | Stable orbits, warp without drift. | Orbit lines, planet from space. |
| **3** | ✅ **Part editor (VAB)** — attachment tree, radial symmetry, derived staging, live Δv/TWR. | Players can build arbitrary rockets. | Functional editor UI. |
| **4** | ✅ **SOI transitions** — Lunara added, Hohmann transfers, encounters, powered landing. | Multi-body navigation works. | Second body, rock scatter. |
| **5** | ✅ **Atmosphere & sky** — Rayleigh/Mie/ozone scattering, transmittance LUT, sunsets, orbital limb. | The sky sells the planet. | First "wow." |
| **6** | ✅ **Volumetric clouds** — raymarched layer, weather map, baked noise volumes, half-res pass. | Clouds affordable + beautiful during ascent/reentry. | Big visual jump. |
| **7** | ✅ **Terrain LOD** — cube-sphere quadtree, ridged height field, chunked meshing with skirts. | Real surfaces to land on, no popping. | Non-low-poly ground. |
| **8** | ✅ **Vegetation** — eight procedural species, instanced with per-band LOD. | Homeworld surface looks alive. | Target visual quality reached. |
| **9** | **Polish** — ✅ reentry heating; engine plumes, sound, camera work, UX outstanding. | Ships. | — |

**Rule:** finish milestone 1 (a correct orbit) before touching any milestone-5+ graphics. A jittery orbit under a gorgeous sky still feels broken; a solid orbit under a plain sky feels like a simulator.

---

## 8. Tech & libraries

- **Three.js** (WebGPURenderer) + **TSL** (node shader language) for atmosphere/cloud/terrain shaders.
- **TypeScript** strict, **Vite** dev/build.
- **Rapier (wasm)** — construction-time collision + crash debris **only**, never flight.
- **React** (or lit) for editor/HUD overlay; canvas stays pure Three.
- **Vitest** for the deterministic sim tests.
- **Comlink + Web Workers** — run the physics step and terrain/noise compute off the main thread.

---

## 9. Resolved decisions

1. **Fictional star system.** Homeworld "Terrin" uses Kerbin-tuned constants (600 km radius,
   μ = 3.5316×10¹² m³/s², 70 km atmosphere). Avoids real-scale float pain and is tuned for
   playability over fidelity. Real ephemerides are explicitly out of scope.
2. **Homeworld-first fidelity.** All visual budget goes to Terrin; other bodies stay barren
   (which is also physically correct for airless worlds).
3. **KSP VAB conventions** for the editor. Learned muscle memory — don't fight it.
```
