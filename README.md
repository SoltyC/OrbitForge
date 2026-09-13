# OrbitForge

A rocket construction and spaceflight simulator with real orbital mechanics, in the
browser. Think Kerbal Space Program: build a rocket, fly it, and have actual physics
decide whether you make orbit.

**Status: milestone 1 of 9.** The physics core is working — a hardcoded two-stage
vehicle launches, performs a gravity turn, stages, and circularises into an 85×77 km
orbit under RK4 integration. There is no part editor and no fancy rendering yet; both
are planned and sequenced in [docs/PLAN.md](docs/PLAN.md).

## Why the physics comes first

A jittery orbit under a beautiful sky still feels broken; a rock-solid orbit under a
plain sky already feels like a simulator. So milestones 1–4 build the simulation and
milestones 5–8 build the visuals (atmospheric scattering, volumetric clouds, quadtree
planetary terrain, instanced vegetation). The renderer today is deliberately a shaded
sphere and a starfield.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # simulation unit tests
npm run build    # typecheck + production bundle
```

Requires Node 20+. The renderer uses WebGPU via Three.js and falls back to WebGL2
automatically.

### Controls

| Input | Action |
|---|---|
| Drag | Orbit camera |
| Wheel | Zoom |
| Space | Pause |
| `,` / `.` | Time warp down / up |
| `R` | Reset to launchpad |

## How it works

**Single-body gravity (patched conics).** A vessel only ever feels the gravity of its
current sphere-of-influence owner. This is what KSP does, it keeps orbits analytically
solvable, and it is what makes arbitrary time-warp possible.

**Two integration regimes.** RK4 for powered and atmospheric flight, where thrust and
drag change fast; analytic Kepler propagation for coasting, so fast-forwarding an orbit
does not mean integrating millions of steps. Plain explicit Euler is deliberately absent
— it drifts orbits into garbage.

**f64 simulation, f32 rendering.** All state is double precision (free in JavaScript).
A floating origin recentres the rendered world on the active vessel every frame, so GPU
coordinates stay small and precise instead of jittering at planetary scale.

**No game physics engine for flight.** Rapier/PhysX-style contact solvers are built for
stacking boxes and are numerically wrong for orbits and multi-scale distances. The flight
model is hand-written. A contact solver will be used later, but only for construction
collision and crash debris.

### The equations

| | |
|---|---|
| Ideal Δv | `Δv = Isp · g₀ · ln(m_wet / m_dry)` |
| Thrust | `F = ṁ · v_e`, with Isp interpolated by ambient pressure |
| Atmosphere | `ρ = ρ₀ · exp(-h / H)` |
| Drag | `F_d = ½ ρ v² C_d A` |
| Orbit shape | Vis-viva + eccentricity vector → Keplerian elements |
| Propagation | Newton solve of `M = E - e·sin(E)` |

## Layout

```
src/
  sim/      # integrators, orbits, forces, attitude, guidance — zero Three.js imports
  parts/    # part catalogue and the test vehicle, all plain data
  bodies/   # celestial body definitions
  render/   # WebGPU renderer, floating origin, placeholder planet/vessel/stars
  ui/       # telemetry HUD
tests/      # deterministic simulation tests
docs/PLAN.md
```

`sim/` and `parts/` import nothing from Three.js. That is a deliberate constraint: it is
what makes the physics unit-testable without a renderer, and it is worth preserving.

## The world

Terrin, the homeworld, uses Kerbin-tuned constants rather than real-solar-system values:
600 km radius, 9.81 m/s² at sea level, 70 km of atmosphere, and a sidereal day of six
hours. Circular orbit just above the atmosphere costs about 2,296 m/s. Reaching orbit
takes minutes, not hours, and the numbers stay small enough to avoid float pain.

## Roadmap

1. ✅ **Physics vertical slice** — RK4, gravity, atmosphere, staging, ascent to orbit
2. Orbital regime — patched conics, Kepler propagation, time warp, map view
3. Part editor (VAB) — attachment tree, symmetry, staging, live Δv/TWR
4. SOI transitions — a moon, transfer orbits, encounters
5. Atmospheric scattering — Bruneton multi-scattering LUTs
6. Volumetric clouds — raymarched, weather-mapped, temporally reprojected
7. Planetary terrain — cube-sphere quadtree LOD, GPU noise heightfields
8. Vegetation and surface detail — instanced scatter with impostor LODs
9. Polish — reentry heating, engine plumes, sound, camera work

Full technical detail for each in [docs/PLAN.md](docs/PLAN.md).

## Contributing

Two rules worth stating up front: keep `sim/` free of rendering imports, and keep the
simulation tests deterministic. Beyond that, issues and pull requests are welcome.

## License

MIT — see [LICENSE](LICENSE).
