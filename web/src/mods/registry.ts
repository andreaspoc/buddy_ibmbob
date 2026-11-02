/**
 * Buddy Mods Registry
 * Core registry managing installed mods, persistent enable/disable states,
 * and command/panel subscriptions.
 */

import type { BobMod, BobModCommand } from './types';

const STORAGE_KEY = 'bob_mods_enabled_states';

export const BUILTIN_MODS: BobMod[] = [
  {
    id: 'live-charts',
    name: 'Interactive Chart Studio',
    version: '0.9.2',
    description:
      'Extracts and renders live interactive Chart.js visualizations and metrics directly in a dedicated analytics panel.',
    icon: '📈',
    category: 'ui',
    author: 'Community',
    defaultEnabled: false,
    commands: [
      {
        command: '/charts',
        description: 'Open live data visualization panel',
      },
    ],
    features: [
      'Interactive Chart.js visualizer',
      'Auto-detects CSV, JSON tables, and KPI data',
      'Period toggle chips and export to PNG',
    ],
  },
  {
    id: 'task-monitor',
    name: 'Task Progress Monitor',
    version: '0.9.0',
    description:
      'Enhanced live task timeline, step-by-step telemetry, and automated retry handlers for long-running workflows.',
    icon: '⚡',
    category: 'productivity',
    author: 'Community',
    defaultEnabled: false,
    commands: [
      {
        command: '/retry',
        description: 'Retry last interrupted task or step',
      },
    ],
    features: [
      'Granular step execution telemetry',
      'Smart failure detection and retry triggers',
      'Completion desktop notifications',
    ],
  },
];

class ModRegistryService {
  private enabledStates: Record<string, boolean> = {};
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.loadStates();
  }

  private loadStates() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.enabledStates = JSON.parse(raw);
      } else {
        // Initialize defaults
        const defaults: Record<string, boolean> = {};
        for (const mod of BUILTIN_MODS) {
          defaults[mod.id] = mod.defaultEnabled;
        }
        this.enabledStates = defaults;
      }
    } catch {
      this.enabledStates = {};
    }
  }

  private saveStates() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.enabledStates));
    } catch {
      // Storage unavailable or disabled
    }
    this.notify();
  }

  private notify() {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        console.error('Error in mod registry listener', err);
      }
    });
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getMods(): BobMod[] {
    return BUILTIN_MODS;
  }

  public getMod(id: string): BobMod | undefined {
    return BUILTIN_MODS.find((m) => m.id === id);
  }

  public isEnabled(id: string): boolean {
    if (this.enabledStates[id] !== undefined) {
      return Boolean(this.enabledStates[id]);
    }
    const mod = this.getMod(id);
    return mod ? mod.defaultEnabled : false;
  }

  public setEnabled(id: string, enabled: boolean): void {
    this.enabledStates = { ...this.enabledStates, [id]: enabled };
    this.saveStates();
  }

  public toggleMod(id: string): boolean {
    const next = !this.isEnabled(id);
    this.setEnabled(id, next);
    return next;
  }

  public getActiveCommands(): BobModCommand[] {
    const commands: BobModCommand[] = [];
    for (const mod of BUILTIN_MODS) {
      if (this.isEnabled(mod.id) && mod.commands) {
        commands.push(...mod.commands);
      }
    }
    return commands;
  }
}

export const modRegistry = new ModRegistryService();
