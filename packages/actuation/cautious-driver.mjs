// Legacy pulse/brake API retired; it cannot establish observation/calibration proof.
export class CautiousDriver {
  constructor(client){this.client=client;}
  async arm(){throw Error('Legacy CautiousDriver retired: DriveSafetyGate and single Observation required');}
  async tick(){throw Error('Legacy CautiousDriver retired: use a guarded actuator session');}
  async stop(){return this.client.stop();}
}
