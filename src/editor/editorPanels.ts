/**
 * Editor DOM: the part catalogue, symmetry control, live vehicle stats and the
 * stage list.
 *
 * Stats update on every craft change, so the delta-v and TWR consequences of
 * adding a part are visible immediately — which is the whole point of building
 * a rocket in an editor rather than discovering it on the pad.
 */
import type { Assembly } from '../parts/assembly.js';
import { CATALOGUE } from '../parts/catalogue.js';
import type { Part } from '../parts/types.js';
import { surfaceGravity } from '../bodies/types.js';
import type { Body } from '../bodies/types.js';
import {
  stageDeltaV,
  stageMass,
  thrustToWeight,
  totalDeltaV,
  vesselMass,
} from '../sim/vessel.js';

export interface EditorPanelHandlers {
  readonly onSelectPart: (partId: string) => void;
  readonly onSymmetryChange: (symmetry: number) => void;
  readonly onLaunch: () => void;
  readonly onClear: () => void;
}

const SYMMETRY_OPTIONS = [1, 2, 3, 4] as const;

export class EditorPanels {
  private readonly root: HTMLElement;
  private readonly statsBody: HTMLElement;
  private readonly stageBody: HTMLElement;
  private readonly partButtons = new Map<string, HTMLButtonElement>();
  private readonly symmetryButtons = new Map<number, HTMLButtonElement>();

  constructor(container: HTMLElement, handlers: EditorPanelHandlers) {
    this.root = document.createElement('div');
    this.root.className = 'editor-root';

    this.root.append(
      this.buildCatalogue(handlers),
      this.buildRightColumn(handlers),
    );
    container.append(this.root);

    this.statsBody = this.root.querySelector('.editor-stats-body')!;
    this.stageBody = this.root.querySelector('.editor-stage-body')!;
  }

  private buildCatalogue(handlers: EditorPanelHandlers): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'editor-panel editor-catalogue';
    panel.append(heading('Parts'));

    for (const part of CATALOGUE) {
      const button = document.createElement('button');
      button.className = 'editor-part';
      button.type = 'button';
      button.innerHTML =
        `<span class="editor-part-name">${part.name}</span>` +
        `<span class="editor-part-meta">${describePart(part)}</span>`;
      button.addEventListener('click', () => handlers.onSelectPart(part.id));

      this.partButtons.set(part.id, button);
      panel.append(button);
    }

    panel.append(this.buildSymmetryRow(handlers));
    return panel;
  }

  private buildSymmetryRow(handlers: EditorPanelHandlers): HTMLElement {
    const row = document.createElement('div');
    row.className = 'editor-symmetry';
    row.append(heading('Symmetry'));

    const buttons = document.createElement('div');
    buttons.className = 'editor-symmetry-buttons';

    for (const count of SYMMETRY_OPTIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${count}x`;
      button.addEventListener('click', () => handlers.onSymmetryChange(count));
      this.symmetryButtons.set(count, button);
      buttons.append(button);
    }

    row.append(buttons);
    return row;
  }

  private buildRightColumn(handlers: EditorPanelHandlers): HTMLElement {
    const column = document.createElement('div');
    column.className = 'editor-right';

    const stats = document.createElement('div');
    stats.className = 'editor-panel';
    stats.append(heading('Vehicle'));
    const statsBody = document.createElement('div');
    statsBody.className = 'editor-stats-body';
    stats.append(statsBody);

    const stages = document.createElement('div');
    stages.className = 'editor-panel';
    stages.append(heading('Stages'));
    const stageBody = document.createElement('div');
    stageBody.className = 'editor-stage-body';
    stages.append(stageBody);

    const actions = document.createElement('div');
    actions.className = 'editor-actions';

    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'editor-launch';
    launch.textContent = 'Launch';
    launch.addEventListener('click', handlers.onLaunch);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'editor-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', handlers.onClear);

    actions.append(clear, launch);
    column.append(stats, stages, actions);
    return column;
  }

  setSelectedPart(partId: string | null): void {
    for (const [id, button] of this.partButtons) {
      button.classList.toggle('is-active', id === partId);
    }
  }

  setSymmetry(symmetry: number): void {
    for (const [count, button] of this.symmetryButtons) {
      button.classList.toggle('is-active', count === symmetry);
    }
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** Refresh stats and the stage breakdown for the current craft. */
  update(assembly: Assembly, body: Body): void {
    const vessel = assembly.vessel;
    const gravity = surfaceGravity(body);

    this.statsBody.innerHTML = '';
    this.statsBody.append(
      statRow('Mass', `${(vesselMass(vessel) / 1000).toFixed(2)} t`),
      statRow('Height', `${assembly.height.toFixed(1)} m`),
      statRow('Parts', String(assembly.placements.length)),
      statRow('Delta-v (vac)', `${totalDeltaV(vessel).toFixed(0)} m/s`),
      statRow('Launch TWR', thrustToWeight(vessel, gravity, 1).toFixed(2)),
    );

    this.stageBody.innerHTML = '';
    // Stage 0 fires first, but rockets are read top-down, so list in reverse.
    for (let index = vessel.stages.length - 1; index >= 0; index--) {
      this.stageBody.append(this.buildStageRow(assembly, index, gravity));
    }
  }

  private buildStageRow(assembly: Assembly, index: number, gravity: number): HTMLElement {
    const vessel = assembly.vessel;
    const stage = vessel.stages[index]!;

    // TWR of a stage is measured against everything it still has to lift.
    const massAbove = vessel.stages
      .slice(index + 1)
      .reduce((sum, s) => sum + stageMass(s), 0);
    const liftedMass = massAbove + stageMass(stage);

    const enginePart = stage.parts.find((part) => part.engine);
    const thrust = enginePart?.engine?.thrustSeaLevel ?? 0;
    const twr = liftedMass > 0 ? thrust / (liftedMass * gravity) : 0;

    const row = document.createElement('div');
    row.className = 'editor-stage';
    row.innerHTML =
      `<span class="editor-stage-index">${index}</span>` +
      `<span class="editor-stage-detail">` +
      `${stage.parts.length} parts · ${(stageMass(stage) / 1000).toFixed(2)} t` +
      `</span>` +
      `<span class="editor-stage-numbers">` +
      `${stageDeltaV(vessel, index).toFixed(0)} m/s` +
      (thrust > 0 ? ` · TWR ${twr.toFixed(2)}` : '') +
      `</span>`;

    return row;
  }
}

function heading(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'editor-heading';
  element.textContent = text;
  return element;
}

function statRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'editor-stat';
  row.innerHTML =
    `<span class="editor-stat-label">${label}</span>` +
    `<span class="editor-stat-value">${value}</span>`;
  return row;
}

function describePart(part: Part): string {
  if (part.engine) {
    return `${(part.engine.thrustSeaLevel / 1000).toFixed(0)} kN · ${part.engine.ispVacuum}s`;
  }
  if (part.tank) {
    return `${(part.tank.propellantCapacity / 1000).toFixed(1)} t fuel`;
  }
  if (part.command) return 'Crewed · reaction wheels';
  return `${part.dryMass} kg`;
}
