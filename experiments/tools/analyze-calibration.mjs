// Offline analysis of saved calibration attempts (experiment runs). Reads
// report.json files only: no bridge, no game, no input, no verified bundle.
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {measureAttempt,compareAttempts,draftCoefficients} from '../../packages/control/calibration-attempt.mjs';
import {percentiles} from '../../packages/protocols/latency-trace.mjs';

export async function findReports(root){
  const found=[];
  async function walk(dir,depth=0){
    if(depth>4)return;
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);
      if(entry.isDirectory())await walk(full,depth+1);
      else if(entry.name==='report.json')found.push(full);
    }
  }
  try{await stat(root);}catch(error){if(error.code==='ENOENT')throw Error('No report.json found under '+root);throw error;}
  await walk(root);return found.sort();
}

export async function analyzeCalibrationFolder(root,{minRepetitions=5,vehicleId=null,actuatorKind='gamepad',cameraProfile='rear'}={}){
  const files=await findReports(root);
  if(!files.length)throw Error('No report.json found under '+root);
  const attempts=[];
  for(const file of files)attempts.push({file,attempt:JSON.parse(await readFile(file,'utf8'))});
  const measured=attempts.map(a=>({file:a.file,report:measureAttempt(a.attempt)}));
  const comparison=compareAttempts(measured.map(m=>m.report),{minRepetitions});
  const draft=draftCoefficients(comparison,{sessions:attempts.map(a=>a.attempt.session_id??path.basename(path.dirname(a.file))),vehicleId,actuatorKind,cameraProfile});
  return {root,files,measured,comparison,draft,
    reaction_ms:percentiles(measured.map(m=>m.report.motion.reaction_ms).filter(Number.isFinite)),
    scope:'Offline analysis of saved attempt reports. Draft coefficients are not verified evidence, contain no hashes and are rejected by loadCalibrationEvidence by design.'};
}

const isMain=process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname);
if(isMain){
  const root=process.argv[2];
  if(!root)throw Error('Usage: node experiments/tools/analyze-calibration.mjs <runs-folder> [--min=5] [--out=review.json] [--draft=coeffs.json] [--vehicle=NAME] [--camera=rear]');
  const arg=(k,f)=>process.argv.find(a=>a.startsWith('--'+k+'='))?.split('=').slice(1).join('=')??f;
  const report=await analyzeCalibrationFolder(path.resolve(root),{minRepetitions:Number(arg('min',5)),vehicleId:arg('vehicle',null),cameraProfile:arg('camera','rear')});
  const out=arg('out',path.join(path.resolve(root),'calibration-review.json'));
  await mkdir(path.dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2));
  const draftFile=arg('draft',null);
  if(draftFile){await mkdir(path.dirname(path.resolve(draftFile)),{recursive:true});await writeFile(path.resolve(draftFile),JSON.stringify(report.draft,null,2));}
  console.log(JSON.stringify({review:out,draft:draftFile,attempts:report.files.length,
    status:report.comparison.status,blockers:report.comparison.blockers,
    reaction_ms:report.reaction_ms?.median??null,
    group_reaction_ms:report.comparison.groups.map(g=>g.reaction_ms.median),
    groups:report.comparison.groups.map(g=>({dose:g.dose,attempts:g.attempts,measurable:g.measurable,
      reaction_ms:g.reaction_ms.median,braking_mps2:g.brake_deceleration_mps2.median,time_to_stop_ms:g.time_to_stop_ms.median}))},null,2));
}
