import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const executable=fileURLToPath(new URL(process.platform==='win32'?'../../training/training-env/Scripts/python.exe':'../../training/training-env/bin/python',import.meta.url));
const result=spawnSync(executable,['-m','unittest','tests.python.test_ablation','tests.python.test_integration','tests.python.test_ownership','tests.python.test_decision_deadline','tests.python.test_drive_safety'],{cwd:new URL('../../',import.meta.url),stdio:'inherit',windowsHide:true});
if(result.error)console.error('Prepared training/training-env is required:',result.error.message);
process.exitCode=result.status??1;
