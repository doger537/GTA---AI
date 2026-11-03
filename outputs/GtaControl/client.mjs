// Node.js 18+. Uses connection.json from the running application.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const config = JSON.parse((await readFile(new URL('./connection.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const [command = 'status', argument, output] = process.argv.slice(2);
const headers = { Authorization: `Bearer ${config.token}` };
let response;
switch (command) {
  case 'status':
    response = await fetch(`${config.url}/status`, { headers });
    break;
  case 'capture-status':
    response = await fetch(`${config.url}/capture-status`, { headers });
    break;
  case 'stop':
    response = await fetch(`${config.url}/stop`, { method: 'POST', headers });
    break;
  case 'frame':
  case 'screenshot': {
    response = await fetch(`${config.url}/${command}`, { headers });
    if (!response.ok) throw new Error(await response.text());
    const destination = argument ?? fileURLToPath(new URL(command === 'frame' ? './frame.jpg' : './frame.png', import.meta.url));
    await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    console.log(destination);
    process.exit(0);
  }
  case 'step':
  case 'action': {
    if (!argument) throw new Error('Pass a JSON action file: node client.mjs action action.json');
    const payload = JSON.parse((await readFile(argument, 'utf8')).replace(/^\uFEFF/, ''));
    response = await fetch(`${config.url}/${command}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (command === 'step') {
      if (!response.ok) throw new Error(await response.text());
      const destination = output ?? fileURLToPath(new URL('./frame.jpg', import.meta.url));
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      console.log(JSON.stringify({
        frame: destination,
        interrupted: response.headers.get('x-action-interrupted') === 'true',
        action_ms: Number(response.headers.get('x-action-ms')),
        capture_ms: Number(response.headers.get('x-capture-ms')),
        total_ms: Number(response.headers.get('x-total-ms')),
      }));
      process.exit(0);
    }
    break;
  }
  default:
    throw new Error('Commands: status | capture-status | stop | frame [output.jpg] | screenshot [output.png] | action <file.json> | step <file.json> [frame.jpg]');
}
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
