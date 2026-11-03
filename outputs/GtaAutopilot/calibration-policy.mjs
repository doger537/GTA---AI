// Bounded manual calibration; no route/model output and no missing-speed extrapolation.
export function calibrationCommand({elapsed_ms,observation,age_ms,throttle=.35,gas_ms=900,steer=0,braking=false}){
  const neutral=reason=>({done:true,reason,command:{steer:0,throttle:0,brake:0}});
  if(![elapsed_ms,throttle,gas_ms,steer].every(Number.isFinite)||elapsed_ms<0||throttle<0||throttle>.5||gas_ms<1||gas_ms>1200||Math.abs(steer)>.35)return neutral('invalid_calibration_parameters');
  if(!Number.isFinite(age_ms)||age_ms>450||age_ms<0)return neutral('observation_stale');
  const speed=observation?.speed,gear=observation?.gear;
  if(!speed?.valid||!Number.isFinite(speed.kmh)||speed.kmh<0||!gear?.valid)return neutral('vehicle_state_unknown');
  if(gear.value==='R'&&speed.kmh>1)return neutral('reverse_movement_not_supported');
  if(!/^[R1-8]$/.test(gear.value))return neutral('gear_not_supported');
  if(speed.kmh>12)return {done:false,reason:'overspeed_brake',command:{steer:0,throttle:0,brake:.45},stop_after_ms:250};
  if(!braking&&elapsed_ms<gas_ms&&speed.kmh<8)return {done:false,reason:'bounded_gas',command:{steer,throttle,brake:0}};
  if(speed.kmh<=1)return neutral('stationary_observed');
  if(elapsed_ms>=gas_ms+1000)return neutral('braking_time_limit');
  return {done:false,reason:'brake_while_forward_moving',command:{steer:0,throttle:0,brake:.35}};
}
