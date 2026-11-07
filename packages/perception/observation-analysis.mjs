import {validateObservation,observationGeometry} from '../protocols/observation-stream.mjs';
import {VehicleStateReader} from './vehicle-state.mjs';
import {hudProfile} from './hud-profile.mjs';
import {navigationAtFrame} from '../navigation/navigation-context.mjs';

export class ObservationAnalyzer {
  constructor({readerFactory=profile=>VehicleStateReader.create(profile),clock=()=>performance.now()}={}){this.readerFactory=readerFactory;this.clock=clock;this.reader=null;this.geometry=null;}
  async readState(o){
    validateObservation(o,{clock:this.clock});const geometry=observationGeometry(o);
    if(this.geometry!==null&&geometry!==this.geometry)throw Error('Native observation geometry changed');
    if(!this.reader){this.reader=await this.readerFactory(hudProfile(o.hud.hud));this.geometry=geometry;}
    const state=await this.reader.read(o.hud.bytes,o.capture_start_ms);
    if(state?.time_ms!==o.capture_start_ms||state?.speed?.time_ms!==o.capture_start_ms)throw Error('OCR returned another frame timestamp');return state;
  }
  async analyze(o,vision){
    const [state,p]=await Promise.all([this.readState(o),vision.analyze(o.road.bytes)]);
    return {state,vision:{...p,source:{sequence:o.sequence,generation:o.generation,capture_start_ms:o.capture_start_ms}}};
  }
  async close(){if(this.reader)await this.reader.close();}
}

export function observationContext(o,state,status,{vehicle_id=null,camera_profile='unknown',metric=null,heading=null,identity=null}={}){
  return {observation:o,state,status,vehicle_id,camera_profile,metric,heading,identity,navigation:navigationAtFrame(o.navigation,o.capture_start_ms,o.capture_end_ms)};
}
