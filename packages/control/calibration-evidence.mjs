import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const verified=new WeakSet();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const isCalibrationEvidence=value=>verified.has(value);
const finite=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
function localFile(root,ref){
  if(typeof ref!=='string'||!ref||path.isAbsolute(ref))throw Error('Calibration evidence needs relative bundle paths');
  const result=path.resolve(root,ref),relative=path.relative(root,result);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Calibration evidence escapes its bundle');
  return result;
}
async function checked(root,ref){
  if(!ref||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('Calibration evidence hash required');
  const bytes=await readFile(localFile(root,ref.file));if(sha(bytes)!==ref.sha256)throw Error('Calibration evidence hash mismatch');return bytes;
}

// This loader verifies provenance/measurement contracts, not truth of human labels.
// It never generates passed reports from the project's incomplete calibration runs.
export async function loadCalibrationEvidence(file,{modelManifest=new URL('../../models-manifest.json',import.meta.url)}={}){
  const root=path.dirname(path.resolve(file)),manifest=JSON.parse(await readFile(file,'utf8'));
  if(manifest.schema_version!==1||manifest.status!=='verified'||typeof manifest.profile?.vehicle_id!=='string'||!manifest.profile.vehicle_id||!['keyboard','gamepad'].includes(manifest.profile.actuator_kind)||manifest.profile.camera_profile!=='rear'||typeof manifest.profile.observation_geometry!=='string')throw Error('Verified vehicle/camera/input calibration bundle required');
  if(manifest.model_manifest_sha256!==sha(await readFile(modelManifest)))throw Error('Calibration model manifest changed');
  const reports={};
  for(const kind of ['camera','speed','braking','steering','vehicle']){
    const report=JSON.parse(await checked(root,manifest.reports?.[kind]));
    const dev=report.development_sessions,val=report.validation_sessions;
    if(report.kind!==kind||report.validation_passed!==true||!Array.isArray(dev)||!dev.length||!Array.isArray(val)||!val.length||dev.some(x=>typeof x!=='string'||!x||val.includes(x))||val.some(x=>typeof x!=='string'||!x)||report.vehicle_id!==manifest.profile.vehicle_id||report.actuator_kind!==manifest.profile.actuator_kind||report.camera_profile!==manifest.profile.camera_profile||report.observation_geometry!==manifest.profile.observation_geometry)throw Error('Independent matching '+kind+' validation required');
    if(!Array.isArray(report.source_files)||!report.source_files.length)throw Error('Calibration source files missing');
    for(const ref of report.source_files)await checked(root,ref);
    reports[kind]=report;
  }
  const {camera,speed,braking,steering,vehicle}=reports;
  if(camera.heading_verified!==true||camera.metric_scale_verified!==true||vehicle.identity_verified!==true)throw Error('Camera scale/heading and vehicle identity evidence required');
  if(!Number.isInteger(speed.samples)||speed.samples<20||speed.false_stops!==0||speed.reverse_confusions!==0||!finite(speed.min_kmh,0,0)||!finite(speed.max_kmh,12,120)||!finite(speed.p95_error_kmh,0,2))throw Error('Validated speed range and false-stop checks required');
  if(!Number.isInteger(braking.repetitions)||braking.repetitions<5||!finite(braking.deceleration_mps2,1,12)||braking.measured_distance_verified!==true||!Number.isInteger(steering.repetitions_per_direction)||steering.repetitions_per_direction<5||steering.response_verified!==true)throw Error('Measured braking and steering validation required');
  if(!finite(braking.brake_command,Number.MIN_VALUE,1)||!finite(braking.max_throttle_tested,Number.MIN_VALUE,1)||!finite(steering.max_abs_steer,Number.MIN_VALUE,1))throw Error('Measured actuator command envelope required');
  if(!finite(manifest.max_speed_kmh,1,Math.min(12,speed.max_kmh)))throw Error('Invalid calibrated speed envelope');
  const value=Object.freeze({profile:Object.freeze({...manifest.profile}),maxSpeedKmh:manifest.max_speed_kmh,maxThrottle:Math.min(.45,braking.max_throttle_tested),maxBrake:braking.brake_command,maxSteer:Math.min(.6,steering.max_abs_steer),brakingMps2:braking.deceleration_mps2,manifestSha256:sha(Buffer.from(JSON.stringify(manifest)))});verified.add(value);return value;
}
