import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';

self.onmessage = ({data:{nodes,edges,groups,repulsion}}) => {
  const spread = Math.sqrt(nodes.length)*13;
  const centers = Array.from({length:groups},(_,index)=>{
    const angle = index*2*Math.PI/groups;
    return groups>1 ? [spread*Math.cos(angle),spread*Math.sin(angle)] : [0,0];
  });
  const offsets = new Uint32Array(groups);
  for (const node of nodes) {
    const index = offsets[node.group]++;
    const distance = 15*Math.sqrt(index);
    const angle = 2.3999632297*index;
    const [x,y] = centers[node.group];
    node.x = x+distance*Math.cos(angle);
    node.y = y+distance*Math.sin(angle);
  }
  const simulation = forceSimulation(nodes).stop()
    .alphaDecay(.034)
    .force('charge',forceManyBody().strength(-176*repulsion).theta(.92))
    .force('links',forceLink(edges).distance(edge=>edge.source.group===edge.target.group?90:126))
    .force('collision',forceCollide(node=>node.radius+11))
    .force('x',forceX(node=>centers[node.group][0]).strength(.045))
    .force('y',forceY(node=>centers[node.group][1]).strength(.045))
    .force('center',forceCenter(0,0).strength(.17));
  const iterations = nodes.length>2500 ? 100 : 150;
  simulation.tick(iterations);
  const positions = new Float32Array(nodes.length*2);
  for (const node of nodes) {
    positions[node.index*2] = node.x;
    positions[node.index*2+1] = node.y;
  }
  self.postMessage(positions,[positions.buffer]);
};
