import * as tf from '@tensorflow/tfjs';
export async function initializeBackend(preference=process.env.GTA_BC_BACKEND??'cpu'){
  if(!['auto','cpu','tensorflow'].includes(preference))throw Error('Unsupported BC backend');
  if(preference!=='cpu'){
    process.env.TF_NUM_INTRAOP_THREADS??='2';process.env.TF_NUM_INTEROP_THREADS??='1';
    try{await import('@tensorflow/tfjs-node');await tf.setBackend('tensorflow');await tf.ready();return tf.getBackend();}
    catch(error){if(preference==='tensorflow')throw error;console.log('Native TensorFlow unavailable; using JavaScript CPU backend.');}
  }
  await tf.setBackend('cpu');await tf.ready();return tf.getBackend();
}
