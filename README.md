# OrbitForge

A rocket construction and spaceflight simulator with real orbital mechanics, in the
browser. Think Kerbal Space Program: build a rocket, fly it, and have actual physics
decide whether you make orbit.

**Status: milestone 3 of 9.** There is a working part editor: build a rocket from an
attachment tree with radial symmetry, watch delta-v and TWR update as you go, and launch
it. The autopilot flies whatever you built to orbit. Once coasting it goes *on rails*,
propagating analytically — 24 hours and 46 revolutions warp past in 52 frames with a
semi-major axis drift of 10⁻¹⁰ m — with a map view showing orbit lines and apsis markers.
The rendering is still placeholder geometry; scattering, clouds, terrain and vegetation
are milestones 5 through 8, sequenced in [docs/PLAN.md](docs/PLAN.md).

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

The game opens in the VAB. Pick a part, click a blue attach node to place it, then
**Launch**.

| Input | Action |
|---|---|
| Click part → click node | Place a part |
| Click a placed part | Select it |
| Delete / Backspace | Remove the selected part and everything below it |
| Drag / Wheel | Orbit / zoom camera |
| Space | Pause |
| `,` / `.` | Time warp down / up |
| `M` | Toggle map view |
| `B` | Back to the VAB |
| `R` | Reset to launchpad |

## How it works

**Single-body gravity (patched conics).** A vessel only ever feels the gravity of its
current sphere-of-influence owner. This is what KSP does, it keeps orbits analytically
solvable, and it is what makes arbitrary time-warp possible.

**Two integration regimes, chosen per step.** RK4 for powered and atmospheric flight,
where thrust and drag change fast; analytic Kepler propagation ("rails") for coasting in
vacuum. Plain explicit Euler is deliberately absent — it drifts orbits into garbage.

Rails are not just faster, they are *more* accurate: the orbit's shape is carried
forward exactly rather than re-derived, so `a`, `e` and `i` cannot drift at all. A
100,000x warp costs exactly as much as 1x, because both are one Kepler solve. Warp is
clamped at the next periapsis whenever the orbit dips into atmosphere, so a decaying
orbit can never tunnel through reentry.

**f64 simulation, f32 rendering.** All state is double precision (free in JavaScript).
A floating origin recentres the rendered world on the active vessel every frame, so GPU
coordinates stay small and precise instead of jittering at planetary scale.

**Staging is derived, not declared.** A craft is an attachment tree; a decoupler is a
stage boundary. Counting decouplers along the path from the root gives every part its
stage automatically, so the staging list cannot drift out of sync with the rocket.

**The autopilot adapts to the craft, not the other way round.** It flies a real gravity
turn — kick off vertical, then follow the surface velocity vector — and throttles to hold
a TWR ceiling. An early scripted altitude-to-pitch table worked beautifully for one
reference rocket and flung a booster-heavy build to a 554 km apoapsis; a fixed schedule
silently encodes one vehicle's acceleration curve. Following prograde does not, because
the velocity vector already reflects whatever the player actually built.

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
  sim/      # integrators, orbits, rails, forces, attitude, guidance — no Three.js
  parts/    # catalogue, craft tree, assembler — plain data, no Three.js
  bodies/   # celestial body definitions
  editor/   # the VAB: craft view, panels, click-to-place
  render/   # WebGPU renderer, floating origin, planet/vessel/stars/orbit lines
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
2. ✅ **Orbital regime** — on-rails Kepler propagation, time warp, orbit lines, map view
3. ✅ **Part editor (VAB)** — attachment tree, radial symmetry, derived staging, live Δv/TWR
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
