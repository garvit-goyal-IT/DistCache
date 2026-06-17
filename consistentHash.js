import crypto from 'crypto'
import { fileURLToPath } from 'url';

function hash(key){
    return parseInt(crypto.createHash('md5').update(key).digest('hex').substring(0,8),16);
}

class consistentHashRing{
    constructor(virtualNodes = 100){
        this.virtualNodes= virtualNodes
        this.ring= {}
        this.sortedPositions= []
    }

    addNode(nodeName){
        for(let i=0;i<this.virtualNodes;i++){
            const position= hash(`${nodeName}-${i}`)
            this.ring[position]=nodeName
            this.sortedPositions.push(position)
        }
        this.sortedPositions.sort((a,b)=>a-b)
    }

    getNode(key){
        if(this.sortedPositions.length===0) return null

        const position= hash(key)

        for(const nodePosition of this.sortedPositions){
            if(position <= nodePosition){
                return this.ring[nodePosition]
            }
        }

        return this.ring[this.sortedPositions[0]]
    }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ring = new consistentHashRing();
    ring.addNode('NodeA');
    ring.addNode('NodeB');
    ring.addNode('NodeC');
  
    const clients = [];
    for (let i = 0; i < 1000; i++) clients.push(`client${i}`);
  
    const before = clients.map(c => ring.getNode(c));
  
    ring.addNode('NodeD'); // add 4th node
  
    const after = clients.map(c => ring.getNode(c));
  
    let changed = 0;
    for (let i = 0; i < clients.length; i++) {
      if (before[i] !== after[i]) changed++;
    }
  
    console.log(`Total clients: ${clients.length}`);
    console.log(`Changed nodes: ${changed}`);
    console.log(`Percentage changed: ${(changed / clients.length * 100).toFixed(2)}%`);
  }

export {
    consistentHashRing
}