// A stop-and-observe driving aid. No road recognition or vehicle telemetry.
export class CautiousDriver {
  constructor(client) { this.client = client; this.busy = false; this.armed = false; this.epoch = 0; }
  async arm() {
    if (this.busy) throw new Error('Driver is busy');
    this.busy = true;
    const epoch = this.epoch;
    try {
      const status = await this.client.status();
      if (!status.target_found || !status.foreground) throw new Error('Activate GTA first');
      const result = await this.client.action({ keys: ['space'], duration_ms: 1500 });
      if (result.interrupted || epoch !== this.epoch) throw new Error('Arming interrupted');
      const frame = await this.client.frame();
      this.armed = epoch === this.epoch;
      return frame;
    } finally { this.busy = false; }
  }
  async stop() { ++this.epoch; this.armed = false; return this.client.stop(); }
  async tick({ direction = 'forward', steer = 'straight', pulse_ms = 200 } = {}) {
    if (!['forward', 'reverse'].includes(direction)) throw new Error('Invalid direction');
    if (!['left', 'straight', 'right'].includes(steer)) throw new Error('Invalid steering');
    const max = steer === 'straight' ? 300 : 150;
    if (!Number.isInteger(pulse_ms) || pulse_ms < 50 || pulse_ms > max) throw new Error(`pulse_ms must be 50..${max}`);
    if (!this.armed) throw new Error('Arm the driver while seated in a stationary vehicle');
    if (this.busy) throw new Error('Wait for the current maneuver');
    this.busy = true;
    const epoch = this.epoch;
    const started = performance.now();
    let brakeStarted = false;
    try {
      const status = await this.client.status();
      if (!status.target_found || !status.foreground) throw new Error('GTA lost focus');
      if (epoch !== this.epoch) throw new Error('Maneuver cancelled');
      const keys = [direction === 'forward' ? 'w' : 's'];
      if (steer !== 'straight') keys.push(steer === 'left' ? 'a' : 'd');
      const action = await this.client.action({ keys, duration_ms: pulse_ms });
      if (action.interrupted || epoch !== this.epoch) throw new Error('Maneuver interrupted');
      // Brake locally before returning control to the agent, avoiding coasting during reasoning.
      brakeStarted = true;
      const frame = await this.client.step({ keys: ['space'], duration_ms: 700 });
      if (frame.interrupted || epoch !== this.epoch) throw new Error('Braking interrupted');
      return { ...frame, pulse_ms, direction, steer, maneuver_ms: Math.round(performance.now() - started) };
    } catch (error) {
      this.armed = false;
      // After an uncertain accelerator response, attempt braking only if GTA still has focus.
      // Never replay the accelerator command. Explicit stop or focus loss prevents follow-up inputs.
      if (!brakeStarted && epoch === this.epoch) {
        try {
          const status = await this.client.status();
          if (status.foreground && epoch === this.epoch) await this.client.action({ keys: ['space'], duration_ms: 700 });
        } catch { }
      }
      try { await this.client.stop(); } catch { }
      throw error;
    } finally { this.busy = false; }
  }
}
