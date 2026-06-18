import express from 'express'
import Redis from "ioredis"
import { consistentHashRing } from './consistentHash.js'

const redisNodes = {
    NodeA: new Redis({ host: process.env.REDIS_A_HOST || 'localhost', port: 6379 }),
    NodeB: new Redis({ host: process.env.REDIS_B_HOST || 'localhost', port: process.env.REDIS_B_HOST ? 6379 : 6380 }),
    NodeC: new Redis({ host: process.env.REDIS_C_HOST || 'localhost', port: process.env.REDIS_C_HOST ? 6379 : 6381 }),
};

const app= express()

async function acquireLock(redis, lockKey, ttl = 5) {
    const result = await redis.set(lockKey, 'locked', 'NX', 'EX', ttl);
    return result === 'OK';
}

async function releaseLock(redis, lockKey) {
    await redis.del(lockKey);
}

async function tokenBucketAllowed(redis, clientId) {
    const bucketKey = `bucket:${clientId}`;
    const capacity = 6;
    const refillRate = 1; 
    const now = Math.floor(Date.now() / 1000); 
    
    const bucketData = await redis.get(bucketKey);
    let bucket = bucketData ? JSON.parse(bucketData) : { tokens: capacity, lastRefillAt: now };
    

    const secondsElapsed = now - bucket.lastRefillAt;
    const tokensToAdd = secondsElapsed * refillRate;
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1; 
      await redis.set(bucketKey, JSON.stringify(bucket), 'EX', 3600); 
      return { allowed: true, tokensRemaining: Math.floor(bucket.tokens) };
    }
    
    return { allowed: false, tokensRemaining: 0 };
}

const ring=new  consistentHashRing()
ring.addNode('NodeA')
ring.addNode('NodeB')
ring.addNode('NodeC')

app.get('/api/resource', async(req,res)=>{
    const clientId= req.headers['x-client-id'] || req.ip
    const nodeName= ring.getNode(clientId)

    const redis= redisNodes[nodeName]
    const lockKey= `lock:${clientId}`

    const gotLock= await acquireLock(redis,lockKey)

    if (!gotLock) {
        return res.status(429).json({ error: 'System busy, try again shortly' });
    }

    try { 
        const bucketResult= await tokenBucketAllowed(redis,clientId)
        
        if(!bucketResult){  
            return res.status(429).json({
                error: 'Too many requests',
                tokensRemaining: 0,
                node: nodeName
            });
        }
     console.log(bucketResult.tokensRemaining)
     res.json({ message : "request successful", 
                tokensRemaining: bucketResult.tokensRemaining, 
                node: nodeName 
            });
    }
    finally{
        await releaseLock(redis,lockKey)
    }
})

app.listen(3000, (req,res)=>{
    console.log("server started on port 3000")
})