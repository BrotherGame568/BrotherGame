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
   * Register a Phaser scene as the audio host and queue unloaded tracks into
   * its Phaser loader.  Call from the scene's preload() so assets are cached
   * by the time create() runs.
   */
  attachScene(scene: import('phaser').Scene): void;

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
   * Fade in and loop the given music track, fading out any previous track.
   * @param fadeInMs Duration of fade-in.  Default: 2500 ms (cinematic).
   */
  setAmbience(trackId: MusicTrackId, fadeInMs?: number): void;

  /**
   * Fade out and stop all currently playing audio.
   * @param fadeOutMs Duration of fade-out.  Default: 2500 ms (cinematic).
   *                  Pass 1500 when transitioning to another screen.
   */
  stopAll(fadeOutMs?: number): void;

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
  attachScene(_scene: import('phaser').Scene): void { /* stub: no-op */ }
  play(_eventName: AudioEventName): void { /* stub: no-op */ }
  stop(_eventName: AudioEventName): void { /* stub: no-op */ }
  setAmbience(_trackId: MusicTrackId, _fadeInMs?: number): void { /* stub: no-op */ }
  stopAll(_fadeOutMs?: number): void { /* stub: no-op */ }
  setVolume(_volume: number): void { /* stub: no-op */ }
}
