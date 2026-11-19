import { EventEmitter } from 'node:events';

export interface UserRealtimeEvent {
  eventType: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

class AutopatchEventBus extends EventEmitter {}

export const autopatchEvents = new AutopatchEventBus();
autopatchEvents.setMaxListeners(200);

export function emitUserUpdate(
  userId: number,
  eventType = 'dashboard_update',
  payload?: Record<string, unknown>
) {
  const event: UserRealtimeEvent = {
    eventType,
    timestamp: new Date().toISOString(),
    payload,
  };
  autopatchEvents.emit(`user:${userId}`, event);
}

export function subscribeUserUpdates(
  userId: number,
  listener: (event: UserRealtimeEvent) => void
): () => void {
  const channel = `user:${userId}`;
  autopatchEvents.on(channel, listener);
  return () => {
    autopatchEvents.off(channel, listener);
  };
}
