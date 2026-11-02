/** Track incoming server IDs, so reads/deletes/reconnects never replay alerts. */
export interface NotificationRoom {
  id: number;
  kind: string;
  name: string;
  subscribed: boolean;
  unread_count: number;
  latest_incoming_id?: number | null;
  latest_incoming_sender_name?: string | null;
  notification_incoming_id?: number | null;
  notification_mode?: 'all' | 'mentions' | 'muted';
  notifications_paused?: boolean;
}
export class CommunityNotificationTracker {
  private readonly notifyBacklog: boolean;
  constructor(notifyBacklog = false) { this.notifyBacklog = notifyBacklog; }
  private initialized = false;
  private seen = new Map<number, number>();

  update<T extends NotificationRoom>(rooms: T[], viewedRoomId: number | null): T[] {
    const incoming: T[] = [];
    for (const room of rooms) {
      const id = room.latest_incoming_id || 0;
      const previous = this.seen.get(room.id) || 0;
      this.seen.set(room.id, Math.max(previous, id));
      const candidate = 'notification_incoming_id' in room ? room.notification_incoming_id || 0 : id;
      if ((this.initialized || this.notifyBacklog) && room.subscribed && room.unread_count > 0 && candidate > previous && room.id !== viewedRoomId && room.notification_mode !== 'muted' && !room.notifications_paused) incoming.push(room);
    }
    this.initialized = true;
    return incoming;
  }
}
