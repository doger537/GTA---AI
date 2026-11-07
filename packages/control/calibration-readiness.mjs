// Pure startup gate. No capture, actuator, extrapolation or saved-state refresh.
export function calibrationReadiness(observations,{latestAgeMs}={}){
  const fail=reason=>({ready:false,reason});
  if(!Array.isArray(observations)||observations.length<3)return fail('need_three_observations');
  if(!Number.isFinite(latestAgeMs)||latestAgeMs<0||latestAgeMs>450)return fail('latest_observation_stale');
  const recent=observations.slice(-3);let previous=null,gearValue=null;
  for(const o of recent){
    if(!o||!Number.isInteger(o.sequence)||o.sequence<0||![o.start_ms,o.end_ms,o.age_ms].every(Number.isFinite)||o.start_ms<0||o.end_ms<o.start_ms)return fail('invalid_observation_timeline');
    if(o.age_ms<0||o.age_ms>450||o.end_ms-o.start_ms>450)return fail('historical_observation_stale');
    if(previous&&(o.sequence<=previous.sequence||o.start_ms<=previous.start_ms))return fail('non_increasing_observations');
    if(previous&&o.start_ms-previous.start_ms>450)return fail('observation_gap');
    const state=o.state,speed=state?.speed,gear=state?.gear;
    if(state?.time_ms!==o.start_ms||speed?.time_ms!==o.start_ms)return fail('state_frame_mismatch');
    if(speed?.valid!==true||!Number.isFinite(speed.kmh)||speed.kmh<0||gear?.valid!==true)return fail('vehicle_state_unknown');
    if(speed.kmh>1)return fail('vehicle_not_stationary');
    if(typeof gear.value!=='string'||!/^[R1-8]$/.test(gear.value))return fail('gear_not_supported');
    if(gearValue!==null&&gear.value!==gearValue)return fail('gear_not_stable');
    gearValue=gear.value;previous=o;
  }
  return {ready:true,reason:'three_fresh_stationary_observations',frames:3,gear:gearValue,first_sequence:recent[0].sequence,last_sequence:recent[2].sequence};
}
