/**
 * IAudioService.ts
 * Interface for all audio triggering and music management.
 * Owner: Architecture domain
 *
 * CROSS-DOMAIN CONTRACT — changes require sign-off from all domain owners.
 * Event name strings must match entries in game/audio/EVENTS.md.
 */

/**
 * All valid audio event names. Must stay in sync with game/audio/EVENTS.md.
 * In Phase 1, this union type will be generated from EVENTS.md.
 */
export type AudioEventName = string; // Phase 1: replace with full union type

/**
 * All valid music/ambience track IDs. Must match game/audio/EVENTS.md.
 */
export type MusicTrackId = string; // Phase 1: replace with full union type

export interface IAudioService {
  /**
   * Play a one-shot sound effect or sting.
   * `eventName` must be a key from game/audio/EVENTS.md.
   */
  play(eventName: AudioEventName): void;

  /**
   * Stop a currently playing sound if it is looping.
   */
  stop(eventName: AudioEventName): void;

  /**
   * Crossfade to the given music track. Stops any previously playing music.
   */
  setAmbience(trackId: MusicTrackId): void;

  /**
   * Stop all currently playing audio immediately.
   */
  stopAll(): void;

  /**
   * Set master volume. 0.0 = silent, 1.0 = full.
   */
  setVolume(volume: number): void;
}

// ---------------------------------------------------------------------------
// STUB
// ---------------------------------------------------------------------------

// STUB — replace with full implementation
export class AudioServiceStub implements IAudioService {
  play(_eventName: AudioEventName): void { /* stub: no-op */ }
  stop(_eventName: AudioEventName): void { /* stub: no-op */ }
  setAmbience(_trackId: MusicTrackId): void { /* stub: no-op */ }
  stopAll(): void { /* stub: no-op */ }
  setVolume(_volume: number): void { /* stub: no-op */ }
}
