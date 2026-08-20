function wrapPhase(p) {
  let x = p % 1;
  if (x > 0.5) x -= 1;
  if (x < -0.5) x += 1;
  return x;
}

/** Beat-grid aware tempo matching and a phase-locked loop that keeps decks glued. */
export class SyncEngine {
  constructor(decks) {
    this.decks = decks;
    this.masterIndex = null;
    this.autoMaster = true;
  }

  get master() {
    if (this.masterIndex != null) {
      const d = this.decks[this.masterIndex];
      if (d?.bpm) return d;
    }
    if (!this.autoMaster) return null;
    return this.decks.find((d) => d.playing && d.bpm) ?? this.decks.find((d) => d.bpm) ?? null;
  }

  setMaster(index) {
    this.masterIndex = index;
    this.autoMaster = index == null;
  }

  beatPhase(deck) {
    if (!deck.bpm) return null;
    const spb = deck.secondsPerBeat();
    return ((deck.positionSeconds() - deck.beatOffset) / spb) % 1;
  }

  /** Chooses the tempo ratio closest to 1, allowing half/double time matches. */
  matchTempo(deck, master) {
    if (!deck.bpm || !master?.bpm) return false;
    const target = master.effectiveBpm;
    const candidates = [target / deck.bpm, target / (deck.bpm * 2), (target * 2) / deck.bpm];
    let best = candidates[0];
    for (const c of candidates) if (Math.abs(Math.log(c)) < Math.abs(Math.log(best))) best = c;
    deck.setTempo(best);
    return true;
  }

  alignPhase(deck, master, hard) {
    const a = this.beatPhase(deck);
    const b = this.beatPhase(master);
    if (a == null || b == null) return;
    const err = wrapPhase(b - a);
    if (hard) {
      deck.seekSeconds(deck.positionSeconds() + err * deck.secondsPerBeat());
    }
  }

  enableSync(deck) {
    const master = this.decks.find((d) => d !== deck && d.bpm && d.playing) ?? this.master;
    if (!master || master === deck) return false;
    deck.syncEnabled = true;
    this.matchTempo(deck, master);
    this.alignPhase(deck, master, true);
    deck.dispatchEvent(new CustomEvent('state'));
    return true;
  }

  disableSync(deck) {
    deck.syncEnabled = false;
    deck.setNudge(1);
    deck.dispatchEvent(new CustomEvent('state'));
  }

  toggleSync(deck) {
    if (deck.syncEnabled) this.disableSync(deck);
    else this.enableSync(deck);
  }

  /** Call a few times per second; keeps synced decks phase-locked to the master. */
  tick() {
    const master = this.master;
    if (master) {
      const spb = master.effectiveBpm ? 60 / master.effectiveBpm : 60 / 128;
      this.currentBeatTime = spb;
    }
    for (const deck of this.decks) {
      if (!deck.syncEnabled || deck === master || !master) continue;
      if (!deck.bpm || !master.bpm) continue;

      const wanted = master.effectiveBpm / deck.bpm;
      const scaled = [wanted, wanted / 2, wanted * 2].reduce((a, b) =>
        Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a
      );
      if (Math.abs(scaled - deck.tempo) > 0.0005) deck.setTempo(scaled);

      if (!deck.playing || !master.playing) {
        deck.setNudge(1);
        continue;
      }

      const a = this.beatPhase(deck);
      const b = this.beatPhase(master);
      if (a == null || b == null) continue;
      const err = wrapPhase(b - a);

      if (Math.abs(err) > 0.35) {
        deck.seekSeconds(deck.positionSeconds() + err * deck.secondsPerBeat());
        deck.setNudge(1);
      } else {
        const k = Math.max(-0.06, Math.min(0.06, (err * deck.secondsPerBeat()) / 2));
        deck.setNudge(1 + k);
      }
    }
  }
}
