/**
 * Craft tree and assembly tests.
 *
 * The assembler sits between the editor and the physics, so a mistake here
 * produces a vehicle that looks right in the VAB and flies wrong. These cover
 * the tree operations, stage derivation, and geometry independently.
 */
import { describe, expect, it } from 'vitest';
import { assemble, craftToVessel } from '../src/parts/assembly.js';
import {
  CraftError,
  attachPart,
  childrenOf,
  createCraft,
  detachPart,
  freeNodes,
  isNodeOccupied,
  rootInstance,
} from '../src/parts/craft.js';
import type { Craft } from '../src/parts/craft.js';
import { createPathfinderCraft } from '../src/parts/testVehicle.js';
import { stageDeltaV, vesselMass } from '../src/sim/vessel.js';

function podWithTank(): Craft {
  const craft = createCraft('Test', 'mk1-pod');
  return attachPart(craft, {
    parentId: 'root',
    parentNodeId: 'bottom',
    partId: 'tank-large',
  });
}

describe('craft tree', () => {
  it('starts with a single root part', () => {
    const craft = createCraft('Test', 'mk1-pod');
    expect(craft.parts).toHaveLength(1);
    expect(rootInstance(craft).partId).toBe('mk1-pod');
    expect(rootInstance(craft).parentId).toBeNull();
  });

  it('attaches a part to a free node', () => {
    const craft = podWithTank();
    expect(craft.parts).toHaveLength(2);
    expect(childrenOf(craft, 'root')).toHaveLength(1);
  });

  it('does not mutate the craft it was given', () => {
    const craft = createCraft('Test', 'mk1-pod');
    attachPart(craft, { parentId: 'root', parentNodeId: 'bottom', partId: 'tank-large' });
    expect(craft.parts).toHaveLength(1);
  });

  it('refuses to attach twice to the same node', () => {
    const craft = podWithTank();
    expect(() =>
      attachPart(craft, {
        parentId: 'root',
        parentNodeId: 'bottom',
        partId: 'tank-small',
      }),
    ).toThrow(CraftError);
  });

  it('refuses to attach to a node the part does not have', () => {
    const craft = createCraft('Test', 'mk1-pod');
    expect(() =>
      attachPart(craft, { parentId: 'root', parentNodeId: 'top', partId: 'tank-large' }),
    ).toThrow(/no attach node/);
  });

  it('treats the node facing the parent as occupied', () => {
    const craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;

    // The tank hangs from the pod's bottom, so the tank's own top is consumed.
    expect(isNodeOccupied(craft, tank.id, 'top')).toBe(true);
    expect(isNodeOccupied(craft, tank.id, 'bottom')).toBe(false);
  });

  it('reports remaining free nodes', () => {
    const craft = podWithTank();
    const free = freeNodes(craft);

    // Pod bottom is taken; the tank still offers bottom and radial.
    expect(free.map((n) => n.nodeId).sort()).toEqual(['bottom', 'radial']);
  });
});

describe('detachPart', () => {
  it('removes the part and everything below it', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'bottom',
      partId: 'engine-booster',
    });
    expect(craft.parts).toHaveLength(3);

    const pruned = detachPart(craft, tank.id);
    expect(pruned.parts).toHaveLength(1);
    expect(rootInstance(pruned).partId).toBe('mk1-pod');
  });

  it('refuses to remove the root', () => {
    expect(() => detachPart(podWithTank(), 'root')).toThrow(/root/);
  });

  it('throws for an unknown instance', () => {
    expect(() => detachPart(podWithTank(), 'nope')).toThrow(CraftError);
  });
});

describe('radial symmetry', () => {
  it('places one part per symmetry slot', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;

    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'radial',
      partId: 'engine-booster',
      symmetry: 3,
    });

    const boosters = craft.parts.filter((p) => p.partId === 'engine-booster');
    expect(boosters).toHaveLength(3);
    expect(new Set(boosters.map((b) => b.symmetryGroup)).size).toBe(1);
  });

  it('spaces symmetric parts evenly around the stack', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'radial',
      partId: 'engine-booster',
      symmetry: 4,
    });

    const angles = craft.parts
      .filter((p) => p.partId === 'engine-booster')
      .map((p) => p.radialAngle)
      .sort((a, b) => a - b);

    expect(angles).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(angles[i]!).toBeCloseTo((i / 4) * Math.PI * 2, 9);
    }
  });

  it('removes the whole symmetry group together', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'radial',
      partId: 'engine-booster',
      symmetry: 3,
    });

    const oneBooster = craft.parts.find((p) => p.partId === 'engine-booster')!;
    const pruned = detachPart(craft, oneBooster.id);

    expect(pruned.parts.filter((p) => p.partId === 'engine-booster')).toHaveLength(0);
  });

  it('places symmetric parts at a consistent radius', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'radial',
      partId: 'engine-booster',
      symmetry: 2,
    });

    const boosters = assemble(craft).placements.filter(
      (p) => p.part.id === 'engine-booster',
    );

    const radii = boosters.map((b) => Math.hypot(b.position[0], b.position[2]));
    expect(radii[0]).toBeCloseTo(radii[1]!, 9);
    expect(radii[0]).toBeGreaterThan(0);
  });
});

describe('stage derivation', () => {
  it('gives a craft with no decouplers a single stage', () => {
    let craft = podWithTank();
    const tank = childrenOf(craft, 'root')[0]!;
    craft = attachPart(craft, {
      parentId: tank.id,
      parentNodeId: 'bottom',
      partId: 'engine-booster',
    });

    expect(craftToVessel(craft).stages).toHaveLength(1);
  });

  it('starts a new stage at each decoupler', () => {
    expect(craftToVessel(createPathfinderCraft()).stages).toHaveLength(3);
  });

  it('puts the lowest parts in the first stage to fire', () => {
    const vessel = craftToVessel(createPathfinderCraft());
    const firstStageIds = vessel.stages[0]!.parts.map((p) => p.id).sort();

    expect(firstStageIds).toEqual([
      'decoupler-stack',
      'engine-booster',
      'tank-large',
    ]);
  });

  it('leaves the pod alone in the final stage', () => {
    const vessel = craftToVessel(createPathfinderCraft());
    const last = vessel.stages[vessel.stages.length - 1]!;

    expect(last.parts.map((p) => p.id)).toEqual(['mk1-pod']);
    expect(last.propellant).toBe(0);
  });

  it('sums tank capacity into the right stage', () => {
    const vessel = craftToVessel(createPathfinderCraft());
    expect(vessel.stages[0]!.propellant).toBe(9_000);
    expect(vessel.stages[1]!.propellant).toBe(2_000);
  });
});

describe('assembled geometry', () => {
  it('places the bottom of the stack at zero', () => {
    const { placements } = assemble(createPathfinderCraft());
    const lowest = Math.min(...placements.map((p) => p.position[1]));
    expect(lowest).toBe(0);
  });

  it('stacks parts without gaps or overlaps', () => {
    const { placements, height } = assemble(createPathfinderCraft());

    // Total part length must equal the stack height for a pure stack build.
    const totalLength = placements.reduce((sum, p) => sum + p.part.length, 0);
    expect(height).toBeCloseTo(totalLength, 9);
  });

  it('puts the pod at the top and the booster at the bottom', () => {
    const { placements } = assemble(createPathfinderCraft());

    const pod = placements.find((p) => p.part.id === 'mk1-pod')!;
    const booster = placements.find((p) => p.part.id === 'engine-booster')!;

    expect(booster.position[1]).toBe(0);
    expect(pod.position[1]).toBeGreaterThan(booster.position[1]);
  });
});

describe('Pathfinder I as an assembled craft', () => {
  const vessel = createPathfinderCraft();

  it('has the expected liftoff mass', () => {
    // 11 550 kg booster + 2 700 kg upper + 800 kg pod.
    expect(vesselMass(craftToVessel(vessel))).toBe(15_050);
  });

  it('still carries enough delta-v to reach orbit', () => {
    const assembled = craftToVessel(vessel);
    const total = assembled.stages.reduce(
      (sum, _stage, index) => sum + stageDeltaV(assembled, index),
      0,
    );
    expect(total).toBeGreaterThan(4_500);
  });

  it('assembles deterministically', () => {
    const a = craftToVessel(createPathfinderCraft());
    const b = craftToVessel(createPathfinderCraft());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('names each instance uniquely', () => {
    const ids = createPathfinderCraft().parts.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
