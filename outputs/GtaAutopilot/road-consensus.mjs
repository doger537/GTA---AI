export function mergeRoadViews(primary,mirror){
  if(primary.gridWidth!==mirror.gridWidth||primary.gridHeight!==mirror.gridHeight||primary.road.length!==mirror.road.length)throw Error('Road view shape mismatch');
  const road=new Uint8Array(primary.road.length),rawRoad=new Uint8Array(road.length),obstacle=new Uint8Array(road.length);let disagreements=0;
  for(let i=0;i<road.length;i++){road[i]=primary.road[i]&&mirror.road[i]?1:0;rawRoad[i]=primary.rawRoad[i]&&mirror.rawRoad[i]?1:0;obstacle[i]=primary.obstacle[i]||mirror.obstacle[i]?1:0;if(primary.road[i]!==mirror.road[i])disagreements++;}
  return {...primary,road,rawRoad,obstacle,inference_ms:primary.inference_ms+mirror.inference_ms,road_view_disagreements:disagreements,model:primary.model+' mirror agreement',probability_scope:'primary view only, not calibrated agreement confidence'};
}
export async function analyzeRoadConsensus(semantic,bytes,options={}){
  const primary=await semantic.analyze(bytes,{...options,horizontalFlip:false}),mirror=await semantic.analyze(bytes,{...options,horizontalFlip:true});
  return {primary,mirror,combined:mergeRoadViews(primary,mirror)};
}
