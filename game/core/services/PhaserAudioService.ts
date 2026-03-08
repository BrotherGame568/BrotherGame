/**
 * PhaserAudioService.ts
 * Real Phaser-backed implementation of IAudioService.
 * Owner: Architecture domain
 *
 * Design notes:
 *  - Fades use setInterval — NOT Phaser tweens — so they survive past scene
 *    shutdown (e.g. the smooth 1.5 s fade-out that runs while the next scene
 *    is already booting).
 *  - Track URLs are Vite ?url imports — resolved to hashed paths at build time
 *    so the opus file is correctly included in the production bundle.
 *  - Call attachScene(scene) from your scene's preload() — it queues any
 *    unloaded tracks into the Phaser loader so they are ready by create().
 */

import Phaser from 'phaser';
import type { IAudioService, AudioEventName, MusicTrackId } from './IAudioService';

// ── Tuning ──────────────────────────────────────────────────────────────────
/** Timer resolution for volume ramps (~40 fps). */
const TICK_MS = 25;
/** Peak playback volume (0 – 1). */
const TARGET_VOLUME = 0.75;

// ── Track registry ───────────────────────────────────────────────────────────
// Vite resolves ?url imports to content-hashed public asset paths so the
// files are copied into the build output automatically.
// Add new tracks here and in game/audio/EVENTS.md.
import overworldTrack01Url from '@audio/music/overworld_track01.opus?url';

const TRACK_URLS: Record<string, string> = {
  music_overworld_01: overworldTrack01Url,
};

// ---------------------------------------------------------------------------

export class PhaserAudioService implements IAudioService {
  private scene: Phaser.Scene | null = null;
  private activeSound: Phaser.Sound.BaseSound | null = null;
  private activeTrackId: string | null = null;
  /** Handle for the current fade-in interval so it can be cancelled. */
  private fadeInTimer: ReturnType<typeof setInterval> | null = null;
  /** User-set volume ceiling — 0 = muted, TARGET_VOLUME = normal. */
  private _userVolume: number = TARGET_VOLUME;

  // ── Scene attachment ───────────────────────────────────────────────────────

  /**
   * Register a Phaser scene as the audio host and queue any unloaded tracks
   * into its loader.  Call from the scene's preload() so all audio is in the
   * cache by the time create() runs.
   */
  attachScene(scene: Phaser.Scene): void {
    this.scene = scene;
    for (const [key, url] of Object.entries(TRACK_URLS)) {
      if (!scene.cache.audio.exists(key)) {
        scene.load.audio(key, url);
      }
    }
  }

  // ── IAudioService: music ───────────────────────────────────────────────────

  /**
   * Fade in and loop the named track.  Fades out whatever was playing before.
   * @param trackId   Key from TRACK_URLS / game/audio/EVENTS.md.
   * @param fadeInMs  Duration of the fade-in ramp.  Default: 2500 (cinematic).
   */
  setAmbience(trackId: MusicTrackId, fadeInMs = 2500): void {
    if (!this.scene) return;
    if (this.activeTrackId === trackId && this.activeSound?.isPlaying) return;

    // Detach the current track's fade-out into its own independent closure so
    // it keeps running even if a new track (or another stopAll) is requested.
    this._detachedFadeOut(this.activeSound);
    this.activeSound   = null;
    this.activeTrackId = null;

    if (!trackId) return;

    if (!this.scene.cache.audio.exists(trackId)) {
      console.warn(
        `[PhaserAudioService] Track "${trackId}" not found in audio cache. ` +
        `Make sure attachScene(this) was called from preload().`,
      );
      return;
    }

    this.activeTrackId = trackId;
    const sound = this.scene.sound.add(trackId, { loop: true, volume: 0 });
    sound.play();
    this.activeSound = sound;
    this._startFadeIn(sound, fadeInMs);
  }

  /**
   * Fade out and stop all music.
   * @param fadeOutMs  Duration of the fade-out.  Default: 2500 (cinematic).
   *                   Pass 1500 when transitioning to another screen.
   */
  stopAll(fadeOutMs = 2500): void {
    this.activeTrackId = null;
    const sound = this.activeSound;
    this.activeSound   = null;

    this._clearFadeIn(); // cancel any unfinished fade-in

    if (!sound) return;
    this._detachedFadeOut(sound, fadeOutMs);
  }

  // ── IAudioService: SFX – Phase 1 stubs ─────────────────────────────────────
  play(_eventName: AudioEventName): void       { /* Phase 1 */ }
  stop(_eventName: AudioEventName): void       { /* Phase 1 */ }

  /**
   * Set the volume ceiling for all music playback.
   * 0.0 = muted, 1.0 = full (capped internally at TARGET_VOLUME).
   * Takes effect immediately on the playing track.
   */
  setVolume(volume: number): void {
    this._userVolume = Math.max(0, Math.min(1, volume)) * TARGET_VOLUME;
    this._clearFadeIn(); // stop ramp so we own the level immediately
    const ws = this.activeSound as Phaser.Sound.WebAudioSound | null;
    if (!ws?.isPlaying) return;
    try { ws.setVolume(this._userVolume); } catch { /* already destroyed */ }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Ramp `sound` from 0 → TARGET_VOLUME over `durationMs`.
   * Stores the timer handle so a subsequent call can cancel it.
   */
  private _startFadeIn(sound: Phaser.Sound.BaseSound, durationMs: number): void {
    this._clearFadeIn();
    const ws    = sound as Phaser.Sound.WebAudioSound;
    const steps = Math.max(1, Math.ceil(durationMs / TICK_MS));
    const delta = this._userVolume / steps;
    let step    = 0;
    let id: ReturnType<typeof setInterval>;
    id = setInterval(() => {
      if (!ws.isPlaying) { clearInterval(id); this.fadeInTimer = null; return; }
      step++;
      ws.setVolume(Math.min(this._userVolume, delta * step));
      if (step >= steps) { clearInterval(id); this.fadeInTimer = null; }
    }, TICK_MS);
    this.fadeInTimer = id;
  }

  /**
   * Ramp `sound` from its current volume → 0, then stop and destroy it.
   * Runs entirely in a captured closure — does not reference `this` — so it
   * continues working after the originating scene has shut down.
   */
  private _detachedFadeOut(sound: Phaser.Sound.BaseSound | null, durationMs = 2500): void {
    if (!sound?.isPlaying) return;
    const ws       = sound as Phaser.Sound.WebAudioSound;
    const startVol = ws.volume || TARGET_VOLUME;
    const steps    = Math.max(1, Math.ceil(durationMs / TICK_MS));
    const delta    = startVol / steps;
    let step       = 0;
    let id: ReturnType<typeof setInterval>;
    id = setInterval(() => {
      step++;
      try {
        ws.setVolume(Math.max(0, startVol - delta * step));
      } catch {
        clearInterval(id);
        return;
      }
      if (step >= steps) {
        clearInterval(id);
        try { ws.stop(); ws.destroy(); } catch { /* already gone */ }
      }
    }, TICK_MS);
  }

  private _clearFadeIn(): void {
    if (this.fadeInTimer !== null) {
      clearInterval(this.fadeInTimer);
      this.fadeInTimer = null;
    }
  }
}
