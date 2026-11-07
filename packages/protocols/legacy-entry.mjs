import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const p=new URL(import.meta.url).searchParams;
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===new URL(p.get('from'),import.meta.url).href)process.argv[1]=fileURLToPath(new URL(p.get('to'),import.meta.url));
