import type { EventType, EventHandler } from './types';

export class EventEmitter {
  private handlers = new Map<EventType, Set<EventHandler>>();

  on(event: EventType, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: EventType, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: EventType, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch {
        // Swallow handler errors to avoid breaking the emitter
      }
    });
  }
}
