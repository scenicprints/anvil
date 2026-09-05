import { initKernel } from '../src/renderer/kernel.js';
import * as K from '../src/renderer/kernel.js';
import { newDocument, newSketch, rebuild, uid } from '../src/renderer/features.js';
const out = [];
const log = (...a) => out.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
await initKernel();
function poly(doc, plane, pts, name) {
  const sk = newSketch(plane, name);
  sk.points = pts.map(([x,y])=>({x,y}));
  sk.entities = pts.map((_,i)=>({id:i+1,type:'line',p:[i,(i+1)%pts.length]}));
  sk.nextEntityId = pts.length+1; doc.sketches[sk.id]=sk; return sk;
}
function look(label, doc) {
  const res = rebuild(doc);
  const s = res.bodies[0].solid;
  const parts = s.decompose();
  log(`${label}: genus=${s.genus()} pieces=${parts.length} [${parts.map(x=>x.volume().toFixed(1)).join(', ')}] vol=${s.volume().toFixed(1)}`);
  parts.forEach(x=>x.delete()); res.dispose();
}
const doc = newDocument();
const base = poly(doc,'XY',[[-24,-16],[24,-16],[24,16],[-24,16]],'Base');
const top = poly(doc,{base:'XY',offset:'18'},[[-12,-9],[12,-9],[12,9],[-12,9]],'Top');
doc.features=[{id:uid('f'),type:'sketch',sketch:base.id},{id:uid('f'),type:'sketch',sketch:top.id},
  {id:uid('f'),type:'loft',sections:[{sketch:base.id},{sketch:top.id}],op:'new',targets:'all'}];
look('loft only', doc);

const prof = newSketch('YZ','Prof'); prof.points=[{x:0,y:0}]; prof.entities=[{id:1,type:'circle',c:0,r:3}]; prof.nextEntityId=2;
doc.sketches[prof.id]=prof;
const arch = newSketch('XZ','Arch');
arch.points=[{x:-10,y:14},{x:-9,y:30},{x:0,y:36},{x:9,y:30},{x:10,y:14}];
arch.entities=[{id:1,type:'spline',p:[0,1,2,3,4]}]; arch.nextEntityId=2;
doc.sketches[arch.id]=arch;
doc.features.push({id:uid('f'),type:'sketch',sketch:prof.id});
doc.features.push({id:uid('f'),type:'sketch',sketch:arch.id});
doc.features.push({id:uid('f'),type:'sweep',sketch:prof.id,path:{sketch:arch.id},op:'join',targets:'all'});
look('+ handle', doc);
doc.features.push({id:uid('f'),type:'primitive',shape:'cylinder',op:'join',targets:'all',
  params:{diameter:'12',height:'34',centered:false,x:'0',y:'0',z:'-34'}});
look('+ stem', doc);
doc.features.push({id:uid('f'),type:'thread',bodies:'all',diameter:'12',pitch:'1.75',length:'20',clearance:'0.2',plane:{base:'XY',offset:'-34'}});
look('+ thread', doc);
document.getElementById('out').textContent = out.join('\n');
window.anvilTest.done({total:0, failed:0, results:[], log: out});
