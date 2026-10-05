import { ipcMain } from 'electron';
import { IPC } from '../shared/types';
import { sameActivity, type ActivityMap, type GameActivity } from '../shared/activity';

type ActivityListener = (activities: ActivityMap) => void;

/** Holds the background operation of every game by id and announces each real change as a full snapshot. */
export class ActivityRegistry {
  private activities: ActivityMap = {};
  private readonly listeners = new Set<ActivityListener>();

  /** Answers the renderer's seed request and pushes every change to the window as a full snapshot. */
  init(send: (channel: string, activities: ActivityMap) => void): void {
    ipcMain.handle(IPC.activityRequest, (): ActivityMap => this.snapshot());
    this.subscribe((activities) => send(IPC.activityUpdate, activities));
  }

  /** The activity of `id`, or undefined when the game is free. */
  get(id: string): GameActivity | undefined {
    return this.activities[id];
  }

  /** Whether `id` carries any activity. */
  has(id: string): boolean {
    return this.activities[id] !== undefined;
  }

  /** Every game's activity right now. */
  snapshot(): ActivityMap {
    return this.activities;
  }

  /** Sets the activity of `id`; a value equal to the current one changes nothing and announces nothing. */
  set(id: string, activity: GameActivity): void {
    if (sameActivity(this.activities[id], activity)) return;
    this.activities = { ...this.activities, [id]: activity };
    this.emit();
  }

  /** Frees `id`; a game that carries no activity changes nothing and announces nothing. */
  clear(id: string): void {
    if (this.activities[id] === undefined) return;
    this.activities = Object.fromEntries(
      Object.entries(this.activities).filter(([key]) => key !== id),
    );
    this.emit();
  }

  /** Calls `listener` with the full snapshot after every change. Returns the unsubscribe. */
  subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.activities);
  }
}
